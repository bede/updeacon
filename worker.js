import { MSG, FILTER_DEFAULTS } from "./protocol.js?v=20260624-191102";

// Web Worker for off-main-thread WASM dehosting (deacon filtering).
// Pull-driven: main thread requests one batch per MSG.PULL as the upload consumes it, so memory stays bounded.
let wasm = null;
let index = null;
const ASSET_VERSION = "20260624-191102";
const OUTPUT_BATCH_BYTES = 4 * 1024 * 1024; // 4 MiB

// wasm-bindgen throws Result errors as plain strings with no `.message`; normalise so the reason isn't lost
function errText(err) {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

// Per-file filtering state, set up by MSG.FILTER and drained by MSG.PULL.
let active = null;

function isGzipFilename(name) {
  return /\.(fastq|fq|fasta|fa)\.gz$/i.test(name || "");
}

function isSeqFilename(name) {
  return /\.(fastq|fq|fasta|fa)(\.gz)?$/i.test(name || "");
}

function startFilter(file) {
  if (!index) throw new Error("No index loaded");
  if (!file || typeof file.stream !== "function") throw new Error("Missing sequence file");
  if (!isSeqFilename(file.name)) {
    throw new Error("Only FASTA/FASTQ files are supported (.fasta/.fa/.fastq/.fq, optionally .gz)");
  }

  const isGz = isGzipFilename(file.name);
  const session = new wasm.WasmFilterSession(
    index,
    FILTER_DEFAULTS.deplete,
    FILTER_DEFAULTS.absThreshold,
    FILTER_DEFAULTS.relThreshold,
    isGz, // decompress_input
    isGz  // compress_output (match input so the original filename stays valid)
  );

  active = {
    session,
    reader: file.stream().getReader(),
    isGz,
    totalBytes: file.size || 0,
    processedBytes: 0,
    pendingBuffers: [],
    pendingBytes: 0,
    finished: false,
    lastProgressTs: 0,
    t0: performance.now(),
  };
}

// Append a chunk of filtered output, transferring its underlying buffer.
function appendOutput(chunk) {
  if (!chunk || chunk.length === 0) return;
  const buffer =
    chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
      ? chunk.buffer
      : chunk.slice().buffer;
  active.pendingBuffers.push(buffer);
  active.pendingBytes += buffer.byteLength;
}

function postProgress() {
  self.postMessage({
    type: MSG.PROGRESS,
    bytesProcessed: active.processedBytes,
    bytesTotal: active.totalBytes,
    progressCompressed: active.isGz,
  });
}

// Pump input until one output batch is ready or input ends, then post one OUTPUT_CHUNK_BATCH (done:true + stats at EOF)
async function pump() {
  const a = active;
  while (a.pendingBytes < OUTPUT_BATCH_BYTES && !a.finished) {
    const { value, done } = await a.reader.read();
    if (done) {
      appendOutput(a.session.finish());
      a.finished = true;
      break;
    }
    if (!value || value.length === 0) continue;
    a.processedBytes += value.length;
    appendOutput(a.session.push_chunk(value));

    const now = performance.now();
    if (now - a.lastProgressTs >= 150) {
      postProgress();
      a.lastProgressTs = now;
    }
  }

  const chunks = a.pendingBuffers;
  a.pendingBuffers = [];
  a.pendingBytes = 0;

  if (a.finished) {
    const stats = a.session.stats();
    const elapsed = ((performance.now() - a.t0) / 1000).toFixed(2);
    postProgress();
    self.postMessage(
      {
        type: MSG.OUTPUT_CHUNK_BATCH,
        chunks,
        done: true,
        stats,
        elapsed,
        bytesProcessed: a.processedBytes,
        bytesTotal: a.totalBytes,
        progressCompressed: a.isGz,
      },
      chunks
    );
    a.session.free();
    active = null;
  } else {
    self.postMessage({ type: MSG.OUTPUT_CHUNK_BATCH, chunks, done: false }, chunks);
  }
}

function disposeActive() {
  if (!active) return;
  try {
    active.reader.cancel();
  } catch (_) {}
  try {
    active.session.free();
  } catch (_) {}
  active = null;
}

self.onmessage = async function (e) {
  const { type, data } = e.data;

  if (type === MSG.INIT) {
    try {
      const mod = await import(`./pkg/deacon_wasm.js?v=${ASSET_VERSION}`);
      const wasmUrl = new URL(`./pkg/deacon_wasm_bg.wasm?v=${ASSET_VERSION}`, import.meta.url);
      await mod.default({ module_or_path: wasmUrl });
      wasm = mod;
      self.postMessage({ type: MSG.READY });
    } catch (err) {
      self.postMessage({ type: MSG.ERROR, message: "Failed to initialize WASM: " + errText(err) });
    }
    return;
  }

  if (type === MSG.LOAD_INDEX) {
    try {
      index = new wasm.WasmIndex(new Uint8Array(data));
      self.postMessage({ type: MSG.INDEX_LOADED, info: index.info() });
    } catch (err) {
      // wasm error already carries a "Failed to load index: …" prefix; surface as-is
      self.postMessage({ type: MSG.ERROR, message: errText(err) });
    }
    return;
  }

  if (type === MSG.RESET) {
    disposeActive();
    index = null;
    self.postMessage({ type: MSG.RESET_DONE });
    return;
  }

  if (type === MSG.FILTER) {
    try {
      disposeActive();
      startFilter(data.file);
    } catch (err) {
      self.postMessage({ type: MSG.ERROR, message: "Filtering failed: " + errText(err) });
    }
    return;
  }

  if (type === MSG.PULL) {
    if (!active) {
      self.postMessage({ type: MSG.ERROR, message: "No active filter session" });
      return;
    }
    try {
      await pump();
    } catch (err) {
      disposeActive();
      self.postMessage({ type: MSG.ERROR, message: "Filtering failed: " + errText(err) });
    }
    return;
  }
};
