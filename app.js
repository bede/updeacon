// updeacon — client-side fastq/fasta dehosting + uploader for the CLIMB
// S3-compatible store.
//
// Everything runs in the browser. Each selected file is decontaminated with
// Deacon (compiled to WebAssembly, run in a Web Worker) and the filtered output
// is streamed *directly* into the S3 multipart upload as it is produced — so
// dehosting and uploading of a file happen simultaneously and contaminant reads
// never leave the machine. The AWS SDK is vendored locally as a single bundled
// module (vendor/aws-sdk.js) so the page has no runtime CDN dependency.
import { S3Client, Upload } from "./vendor/aws-sdk.js";
import { MSG } from "./protocol.js?v=20260615-1";

// --- Fixed configuration -----------------------------------------------------
// CLIMB uses Ceph RADOS Gateway (S3-compatible), not real AWS, so:
//   - `endpoint` points at the gateway,
//   - `region` is a dummy value the gateway ignores but the SDK requires,
//   - `forcePathStyle` is required (RGW does not do virtual-host-style buckets).
const ENDPOINT = "https://s3.climb.ac.uk";
const BUCKET = "quick-research-bede-upload-test";
const REGION = "us-east-1";

const ASSET_VERSION = "20260615-1";

// Matches fastq/fasta sequence files, optionally .gz compressed (fq/fa short
// forms included).
const SEQ_RE = /\.(fastq|fq|fasta|fa)(\.gz)?$/i;

// Multipart tuning: 8 MiB parts, up to 4 concurrent parts per file.
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 4;

// Largest index we'll try to load into browser memory.
const MAX_INDEX_BYTES = 1024 * 1024 * 1024; // 1 GB

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const accessKeyEl = $("access-key");
const secretKeyEl = $("secret-key");
const indexZone = $("index-zone");
const indexInput = $("index-input");
const indexName = $("index-name");
const indexInfo = $("index-info");
const dirZone = $("dir-zone");
const dirInput = $("dir-input");
const dirSummary = $("dir-summary");
const uploadBtn = $("upload-btn");
const resetBtn = $("reset-btn");
const progressWrap = $("progress-wrap");
const dehostProgress = $("dehost-progress");
const dehostLabel = $("dehost-label");
const uploadProgress = $("upload-progress");
const uploadLabel = $("upload-label");
const fileListEl = $("file-list");
const statusEl = $("status");

// --- State -------------------------------------------------------------------
let selectedFiles = []; // { file, key } entries, sequence files only
let totalBytes = 0;
let isUploading = false;
let indexLoaded = false;

// --- Helpers -----------------------------------------------------------------
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || "";
}

function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function timestampPrefix() {
  // 2026-06-13T09-12-00Z — filesystem/key-safe ISO 8601 without ms or colons.
  return new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function updateUploadEnabled() {
  uploadBtn.disabled =
    isUploading ||
    !indexLoaded ||
    selectedFiles.length === 0 ||
    !accessKeyEl.value.trim() ||
    !secretKeyEl.value.trim();
}

// Build the upload list from a flat array of File objects. Keys are
// `<timestamp>/<relative path>`, preserving the directory structure of the
// selected folder (including the chosen folder name) and keeping filenames
// intact. Preserving full relative paths also means basenames never collide.
function buildFileList(files, timestamp) {
  return files
    .filter((f) => SEQ_RE.test(f.name))
    .map((file) => {
      // webkitRelativePath is e.g. "myrun/laneA/sample.fastq.gz"; fall back to
      // the bare filename if the browser didn't provide a relative path.
      const rel = file.webkitRelativePath || file.name;
      return { file, key: `${timestamp}/${rel}` };
    });
}

function setSelection(files) {
  // `files` here is just for display/count; keys are finalised at upload time
  // so the timestamp reflects when the upload actually starts.
  const seqs = files.filter((f) => SEQ_RE.test(f.name));
  selectedFiles = seqs.map((file) => ({ file, key: null }));
  totalBytes = seqs.reduce((sum, f) => sum + f.size, 0);

  if (seqs.length === 0) {
    dirZone.classList.remove("loaded");
    dirSummary.textContent = files.length
      ? "No fastq/fasta files found in that folder"
      : "";
  } else {
    dirZone.classList.add("loaded");
    dirSummary.textContent = `${seqs.length} sequence file${
      seqs.length === 1 ? "" : "s"
    } selected · ${humanBytes(totalBytes)}`;
  }
  setStatus("");
  progressWrap.style.display = "none";
  fileListEl.innerHTML = "";
  updateUploadEnabled();
}

// --- WASM worker (dehosting) -------------------------------------------------
const worker = new Worker(`./worker.js?v=${ASSET_VERSION}`, { type: "module" });

// While a file is being filtered these route the worker's streaming replies to
// the active per-file handlers (one file is processed at a time).
let onOutputBatch = null; // (msg) => void  — next OUTPUT_CHUNK_BATCH
let onDehostProgress = null; // (msg) => void  — PROGRESS for the active file
let onWorkerError = null; // (message) => void — abort the active pull

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case MSG.READY:
      setStatus("Load a Deacon index to begin.");
      break;
    case MSG.INDEX_LOADED:
      indexLoaded = true;
      indexZone.classList.add("loaded");
      indexInfo.textContent = m.info;
      setStatus("Index loaded. Select a folder of sequences and your CLIMB keys.");
      updateUploadEnabled();
      break;
    case MSG.PROGRESS:
      if (onDehostProgress) onDehostProgress(m);
      break;
    case MSG.OUTPUT_CHUNK_BATCH:
      if (onOutputBatch) onOutputBatch(m);
      break;
    case MSG.ERROR:
      if (onWorkerError) onWorkerError(m.message);
      else {
        indexInfo.textContent = "";
        setStatus("Error: " + m.message, "error");
      }
      break;
    default:
      break;
  }
};

worker.postMessage({ type: MSG.INIT });

// Returns a ReadableStream of the dehosted bytes of `file`. The stream is
// pull-driven: each `pull` asks the worker for the next output batch, so the S3
// upload (which consumes this stream) paces the WASM filter and memory stays
// bounded. `hooks.onProgress(msg)` fires as input is consumed;
// `hooks.onStats(stats)` fires once when filtering completes.
function dehostStream(file, hooks) {
  return new ReadableStream({
    start() {
      onDehostProgress = hooks.onProgress;
      worker.postMessage({ type: MSG.FILTER, data: { file } });
    },
    pull(controller) {
      return new Promise((resolve, reject) => {
        onWorkerError = (message) => {
          onWorkerError = null;
          onOutputBatch = null;
          reject(new Error(message));
        };
        onOutputBatch = (m) => {
          onOutputBatch = null;
          for (const buf of m.chunks) controller.enqueue(new Uint8Array(buf));
          if (m.done) {
            onWorkerError = null;
            onDehostProgress = null;
            if (hooks.onStats) hooks.onStats(m.stats);
            controller.close();
          }
          resolve();
        };
        worker.postMessage({ type: MSG.PULL });
      });
    },
    cancel() {
      // Drop our handlers; the worker disposes its session on the next FILTER.
      onOutputBatch = null;
      onDehostProgress = null;
      onWorkerError = null;
    },
  });
}

// --- Index selection ---------------------------------------------------------
indexZone.addEventListener("click", () => {
  if (!isUploading) indexInput.click();
});
indexZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!isUploading) indexZone.classList.add("dragover");
});
indexZone.addEventListener("dragleave", () => indexZone.classList.remove("dragover"));
indexZone.addEventListener("drop", (e) => {
  e.preventDefault();
  indexZone.classList.remove("dragover");
  if (isUploading) return;
  if (e.dataTransfer.files.length > 0) loadIndexFile(e.dataTransfer.files[0]);
});
indexInput.addEventListener("change", () => {
  if (indexInput.files.length > 0) loadIndexFile(indexInput.files[0]);
});

async function loadIndexFile(file) {
  if (file.size > MAX_INDEX_BYTES) {
    setStatus(
      `Index file too large for browser use (${(file.size / 1024 / 1024).toFixed(0)} MB). ` +
        `Maximum supported size is ${MAX_INDEX_BYTES / 1024 / 1024 / 1024} GB.`,
      "error"
    );
    return;
  }
  indexLoaded = false;
  indexZone.classList.remove("loaded");
  updateUploadEnabled();
  indexName.textContent = file.name;
  indexInfo.textContent = "Loading…";
  setStatus(`Loading index (${(file.size / 1024 / 1024).toFixed(0)} MB)…`);
  const buf = await file.arrayBuffer();
  worker.postMessage({ type: MSG.LOAD_INDEX, data: buf }, [buf]);
}

// --- Directory selection -----------------------------------------------------
dirZone.addEventListener("click", () => {
  if (!isUploading) dirInput.click();
});

dirInput.addEventListener("change", () => {
  setSelection(Array.from(dirInput.files));
});

// Drag-and-drop of a folder (Chromium/WebKit) via the entries API.
dirZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!isUploading) dirZone.classList.add("dragover");
});
dirZone.addEventListener("dragleave", () => dirZone.classList.remove("dragover"));
dirZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dirZone.classList.remove("dragover");
  if (isUploading) return;
  const items = Array.from(e.dataTransfer.items)
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (items.length) {
    const files = await collectEntries(items);
    setSelection(files);
  } else {
    setSelection(Array.from(e.dataTransfer.files || []));
  }
});

// Recursively walk dropped FileSystemEntry objects into a flat File[] list,
// stamping webkitRelativePath so collision handling works the same as the picker.
async function collectEntries(entries, prefix = "") {
  const out = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      try {
        Object.defineProperty(file, "webkitRelativePath", {
          value: prefix + entry.name,
          configurable: true,
        });
      } catch (_) {
        // Some browsers make this read-only; key falls back to basename.
      }
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await readAllEntries(reader);
      out.push(...(await collectEntries(children, prefix + entry.name + "/")));
    }
  }
  return out;
}

function readAllEntries(reader) {
  // readEntries returns at most ~100 entries per call; loop until exhausted.
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

// --- Upload ------------------------------------------------------------------
// Access key ID persistence is left to the browser's native form autofill (the
// field has a name + autocomplete). The secret key field has autocomplete off,
// so the browser won't offer to remember it.
[accessKeyEl, secretKeyEl].forEach((el) =>
  el.addEventListener("input", updateUploadEnabled)
);

resetBtn.addEventListener("click", () => {
  if (isUploading) return;
  dirInput.value = "";
  setSelection([]);
  dirSummary.textContent = "";
  dirZone.classList.remove("loaded");
});

uploadBtn.addEventListener("click", uploadAll);

async function uploadAll() {
  const accessKeyId = accessKeyEl.value.trim();
  const secretAccessKey = secretKeyEl.value.trim();

  const timestamp = timestampPrefix();
  const items = buildFileList(
    selectedFiles.map((s) => s.file),
    timestamp
  );
  if (!items.length) return;

  isUploading = true;
  updateUploadEnabled();
  resetBtn.disabled = true;
  setStatus(`Uploading to ${timestamp}/ …`);

  // Render per-file rows.
  progressWrap.style.display = "block";
  fileListEl.innerHTML = "";
  dehostProgress.value = 0;
  uploadProgress.value = 0;
  dehostLabel.textContent = "";
  uploadLabel.textContent = "";
  const rows = items.map(({ file }) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = file.name;
    const st = document.createElement("span");
    st.className = "st";
    st.textContent = "queued";
    li.append(name, st);
    fileListEl.appendChild(li);
    return { li, st };
  });

  const client = new S3Client({
    endpoint: ENDPOINT,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  // Aggregate progress. Dehost progress is an exact % of input bytes (we know the
  // source sizes); upload progress is bytes-only (the filtered size is unknown
  // until a file finishes, so the bar is indeterminate during transfer).
  let dehostedBefore = 0; // input bytes of fully-dehosted files
  let uploadedBefore = 0; // output bytes of fully-uploaded files

  let completed = 0;
  let inFileLoop = false;
  try {
    // Write a marker object recording the uploader's access key ID into the
    // timestamped directory before any sequence files. Doubles as an early
    // CORS/credentials check before the (potentially large) uploads start.
    setStatus(`Creating ${timestamp}/access_key_id …`);
    await new Upload({
      client,
      params: {
        Bucket: BUCKET,
        Key: `${timestamp}/access_key_id`,
        Body: new Blob([accessKeyId], { type: "text/plain" }),
        ContentType: "text/plain",
      },
    }).done();

    inFileLoop = true;
    setStatus(`Dehosting and uploading to ${timestamp}/ …`);
    for (let i = 0; i < items.length; i++) {
      const { file, key } = items[i];
      rows[i].li.className = "active";
      rows[i].st.textContent = "dehosting…";

      let curProcessed = 0; // input bytes dehosted for this file
      let curUploaded = 0; // output bytes uploaded for this file
      let fileStats = null;

      const renderRow = () => {
        const dpct = file.size ? Math.min(100, (curProcessed / file.size) * 100) : 100;
        rows[i].st.textContent = `dehost ${dpct.toFixed(0)}% · up ${humanBytes(curUploaded)}`;
      };
      const onProgress = (m) => {
        curProcessed = m.bytesProcessed || 0;
        const pct = totalBytes ? ((dehostedBefore + curProcessed) / totalBytes) * 100 : 0;
        dehostProgress.value = pct;
        dehostLabel.textContent =
          `Dehosting · ${humanBytes(dehostedBefore + curProcessed)} / ${humanBytes(totalBytes)} ` +
          `(${pct.toFixed(1)}%) — file ${i + 1} of ${items.length}`;
        renderRow();
      };
      const onStats = (stats) => {
        fileStats = stats;
      };

      const stream = dehostStream(file, { onProgress, onStats });
      const up = new Upload({
        client,
        params: { Bucket: BUCKET, Key: key, Body: stream },
        queueSize: QUEUE_SIZE,
        partSize: PART_SIZE,
      });
      uploadProgress.removeAttribute("value"); // indeterminate during transfer
      up.on("httpUploadProgress", (p) => {
        curUploaded = p.loaded || 0;
        uploadLabel.textContent =
          `Uploaded ${humanBytes(uploadedBefore + curUploaded)} · file ${i + 1} of ${items.length}`;
        renderRow();
      });

      await up.done();

      dehostedBefore += file.size;
      uploadedBefore += curUploaded;
      rows[i].li.className = "done";
      const readsIn = Number(fileStats?.readsIn || 0);
      const readsOut = Number(fileStats?.readsOut || 0);
      rows[i].st.textContent = readsIn
        ? `done · ${readsOut.toLocaleString()}/${readsIn.toLocaleString()} reads kept`
        : "done";
      completed++;
    }

    dehostProgress.value = 100;
    uploadProgress.value = 100;
    dehostLabel.textContent = `Dehosted ${humanBytes(totalBytes)} of input across ${completed} file${completed === 1 ? "" : "s"}.`;
    uploadLabel.textContent = `Uploaded ${humanBytes(uploadedBefore)} of dehosted output.`;
    setStatus(
      `Dehosted and uploaded ${completed} file${completed === 1 ? "" : "s"} to ` +
        `s3://${BUCKET}/${timestamp}/`,
      "success"
    );
  } catch (err) {
    const idx = completed; // the file that failed
    if (inFileLoop && rows[idx]) {
      rows[idx].li.className = "failed";
      rows[idx].st.textContent = "failed";
    }
    console.error(err);
    setStatus(formatError(err), "error");
  } finally {
    uploadProgress.value = uploadProgress.value || 0; // restore determinate bar
    isUploading = false;
    resetBtn.disabled = false;
    updateUploadEnabled();
  }
}

function formatError(err) {
  const name = err?.name || "Error";
  const msg = err?.message || String(err);
  // The overwhelmingly common browser-upload failure is a missing/incorrect
  // CORS policy on the bucket; surface a hint rather than a bare network error.
  if (
    name === "TypeError" ||
    /CORS|Failed to fetch|NetworkError|Load failed/i.test(msg)
  ) {
    return (
      `Upload failed: ${msg}\n\n` +
      `This is usually a CORS or network issue. The bucket must allow PUT/POST ` +
      `from this origin and expose the ETag header — see the README.`
    );
  }
  if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|403/i.test(name + msg)) {
    return `Upload failed (authentication/authorisation): ${name}: ${msg}\n\nCheck the access key, secret key, and bucket permissions.`;
  }
  return `Upload failed: ${name}: ${msg}`;
}
