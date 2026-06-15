// updeacon — client-side fastq/fasta uploader for the CLIMB S3-compatible store.
//
// Everything runs in the browser. The AWS SDK is vendored locally as a single
// bundled module (vendor/aws-sdk.js) so the page has no runtime CDN dependency.
// Rebuild it with `npm run build:sdk` (see README).
import { S3Client, Upload } from "./vendor/aws-sdk.js";

// --- Fixed configuration -----------------------------------------------------
// CLIMB uses Ceph RADOS Gateway (S3-compatible), not real AWS, so:
//   - `endpoint` points at the gateway,
//   - `region` is a dummy value the gateway ignores but the SDK requires,
//   - `forcePathStyle` is required (RGW does not do virtual-host-style buckets).
const ENDPOINT = "https://s3.climb.ac.uk";
const BUCKET = "quick-research-bede-upload-test";
const REGION = "us-east-1";

// Matches fastq/fasta sequence files, optionally .gz or .zst compressed
// (fq/fa short forms included).
const SEQ_RE = /\.(fastq|fq|fasta|fa)(\.gz|\.zst)?$/i;

// Multipart tuning: 8 MiB parts, up to 4 concurrent parts per file.
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 4;

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const accessKeyEl = $("access-key");
const secretKeyEl = $("secret-key");
const dirZone = $("dir-zone");
const dirInput = $("dir-input");
const dirSummary = $("dir-summary");
const uploadBtn = $("upload-btn");
const resetBtn = $("reset-btn");
const progressWrap = $("progress-wrap");
const overallProgress = $("overall-progress");
const progressLabel = $("progress-label");
const fileListEl = $("file-list");
const statusEl = $("status");

// --- State -------------------------------------------------------------------
let selectedFiles = []; // { file, key } entries, sequence files only
let totalBytes = 0;
let isUploading = false;

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

  // Track aggregate progress across all files. `lib-storage` reports the
  // cumulative `loaded` for the current file, so we keep per-file loaded values
  // and sum them for the overall bar.
  const loaded = new Array(items.length).fill(0);
  const renderOverall = (idx) => {
    const sum = loaded.reduce((a, b) => a + b, 0);
    const pct = totalBytes ? (sum / totalBytes) * 100 : 0;
    overallProgress.value = pct;
    progressLabel.textContent =
      `Uploading file ${idx + 1} of ${items.length} · ` +
      `${humanBytes(sum)} / ${humanBytes(totalBytes)} (${pct.toFixed(1)}%)`;
  };
  renderOverall(0);

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
    setStatus(`Uploading to ${timestamp}/ …`);
    for (let i = 0; i < items.length; i++) {
      const { file, key } = items[i];
      rows[i].li.className = "active";
      rows[i].st.textContent = "uploading…";

      const up = new Upload({
        client,
        params: { Bucket: BUCKET, Key: key, Body: file },
        queueSize: QUEUE_SIZE,
        partSize: PART_SIZE,
      });
      up.on("httpUploadProgress", (p) => {
        loaded[i] = p.loaded || 0;
        renderOverall(i);
      });

      await up.done();

      loaded[i] = file.size; // ensure the bar reflects full completion
      rows[i].li.className = "done";
      rows[i].st.textContent = "done";
      completed++;
      renderOverall(Math.min(i + 1, items.length - 1));
    }

    overallProgress.value = 100;
    progressLabel.textContent = `Done · ${completed}/${items.length} files · ${humanBytes(totalBytes)}`;
    setStatus(
      `Uploaded ${completed} file${completed === 1 ? "" : "s"} to ` +
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
