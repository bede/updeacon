import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { checkReachable, makeLinkUploader, makeCredentialUploader } = await import(
  `${pathToFileURL(resolve(here, "../seq2bucket/uploaders.js"))}?test=${Date.now()}`
);

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimerFn(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimerFn(id) {
      pending.delete(id);
    },
    fire(ms) {
      const found = [...pending].find(([, timer]) => timer.ms === ms);
      assert.ok(found, `no ${ms}ms timer was armed`);
      pending.delete(found[0]);
      found[1].fn();
    },
    get size() {
      return pending.size;
    },
  };
}

test("a black-holed online preflight is classified as network and retried", async () => {
  const timers = fakeTimers();
  const retries = [];
  const sleeps = [];
  let attempts = 0;
  const checking = [];

  const result = checkReachable("https://example.test", "bucket", {
    retryOffline: true,
    expiresAt: Date.now() + 120_000,
    onlineFn: () => true,
    onChecking: () => checking.push(1),
    onRetry: (info) => retries.push(info),
    sleepFn: async (ms) => sleeps.push(ms),
    fetchFn: (_url, opts) => {
      attempts++;
      if (attempts === 2) return Promise.resolve({});
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
    setTimerFn: timers.setTimerFn,
    clearTimerFn: timers.clearTimerFn,
  });

  timers.fire(5 * 60 * 1000);
  await result;

  assert.equal(attempts, 2);
  assert.equal(checking.length, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].waitingOnline, false);
  assert.equal(retries[0].error.kind, "network");
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(timers.size, 0);
});

test("an immediate online preflight failure remains a terminal CORS diagnosis", async () => {
  await assert.rejects(
    checkReachable("https://example.test", "bucket", {
      retryOffline: true,
      onlineFn: () => true,
      fetchFn: async () => {
        throw new TypeError("Failed to fetch");
      },
    }),
    (err) => err.kind === "cors"
  );
});

test("link upload checks combined spool capacity before pulling either mate", async () => {
  const events = [];
  const posts = [];
  const released = [];
  const uploader = makeLinkUploader({
    link: {
      endpoint: "https://example.test",
      bucket: "bucket",
      maxBytes: 1000,
      expiresAt: Date.now() + 60_000,
      fields: {},
    },
    buildClientRecord: () => ({}),
    humanBytes: String,
    onStatus: () => {},
    prepareSpoolFn: async (bytes) => events.push(["prepare", bytes]),
    spoolNameFn: (_n, mate) => `${mate}.bin`,
    spoolToFileFn: async (_stream, name, opts) => {
      events.push(["spool", name, opts.expectedBytes]);
      return new Blob([name]);
    },
    releaseSpoolFn: async (name) => released.push(name),
    postWithRetryFn: async (args) => posts.push(args.key),
  });

  const keys = await uploader.uploadGroup(
    {
      kind: "paired",
      key: "prefix/r1.fastq.gz",
      key2: "prefix/r2.fastq.gz",
      file1: { size: 100 },
      file2: { size: 200 },
    },
    { streamR1: {}, streamR2: {} },
    { onUploadStart: () => {}, onUploadProgress: () => {} }
  );

  assert.deepEqual(events, [
    ["prepare", 300],
    ["spool", "r1.bin", 100],
    ["spool", "r2.bin", 200],
  ]);
  assert.deepEqual(posts, ["prefix/r1.fastq.gz", "prefix/r2.fastq.gz"]);
  assert.deepEqual(keys, posts);
  assert.deepEqual(released, ["r1.bin", "r2.bin"]);
});

test("link upload posts whole Blobs directly, with no spool", async () => {
  const posts = [];
  const started = [];
  const fail = (what) => async () => assert.fail(`${what} must not be called for raw bodies`);
  const uploader = makeLinkUploader({
    link: {
      endpoint: "https://example.test",
      bucket: "bucket",
      maxBytes: 1000,
      expiresAt: Date.now() + 60_000,
      fields: { policy: "p" },
    },
    buildClientRecord: () => ({}),
    humanBytes: String,
    onStatus: () => {},
    prepareSpoolFn: fail("prepareSpool"),
    spoolToFileFn: fail("spoolToFile"),
    releaseSpoolFn: fail("releaseSpool"),
    postWithRetryFn: async (args) => posts.push([args.key, args.body, args.link.fields]),
  });

  const r1 = new Blob(["@r1\n"]);
  const r2 = new Blob(["@r2\n"]);
  const keys = await uploader.uploadGroup(
    { kind: "paired", key: "p/r1.fastq", key2: "p/r2.fastq", file1: r1, file2: r2 },
    { bodyR1: r1, bodyR2: r2 },
    { onUploadStart: (n) => started.push(n), onUploadProgress: () => {} }
  );

  assert.deepEqual(keys, ["p/r1.fastq", "p/r2.fastq"]);
  assert.equal(posts[0][1], r1);
  assert.equal(posts[1][1], r2);
  assert.equal(posts[0][2].policy, "p"); // fields go through verbatim
  assert.deepEqual(started, [r1.size + r2.size]);
});

test("link upload enforces the per-file cap on a whole Blob's exact size", async () => {
  const uploader = makeLinkUploader({
    link: { endpoint: "e", bucket: "b", maxBytes: 3, expiresAt: Date.now() + 60_000, fields: {} },
    buildClientRecord: () => ({}),
    humanBytes: (n) => `${n}B`,
    postWithRetryFn: async () => assert.fail("must not post an oversize body"),
  });
  const body = new Blob(["@toolong\n"]);
  await assert.rejects(
    uploader.uploadGroup(
      { kind: "single", key: "p/a.fastq", file: body },
      { body },
      { onUploadStart: () => {}, onUploadProgress: () => {} }
    ),
    (err) => err.kind === "size" && /^a\.fastq is 9B/.test(err.message)
  );
});

test("credential upload sends a whole Blob as the multipart Body", async () => {
  const sent = [];
  class Upload {
    constructor({ params }) {
      this.params = params;
    }
    on() {}
    async done() {
      sent.push([this.params.Key, this.params.Body]);
    }
  }
  const uploader = makeCredentialUploader({
    accessKeyId: "a",
    secretAccessKey: "s",
    bucket: "b",
    endpoint: "e",
    region: "r",
    loadSdk: async () => ({ Upload, S3Client: class {} }),
    checkReachableFn: async () => {},
  });
  await uploader.preflight("p");
  const body = new Blob(["@r\n"]);
  const started = [];
  await uploader.uploadGroup(
    { kind: "single", key: "p/a.fastq", file: body },
    { body },
    { onUploadStart: (n) => started.push(n), onUploadProgress: () => {} }
  );
  assert.deepEqual(sent.at(-1), ["p/a.fastq", body]);
  assert.deepEqual(started, [body.size]);
});

test("the source module graph uses one cache token", async () => {
  // Every app source file outside pkg/, vendor/ and tests/
  const root = resolve(here, "..");
  const paths = [];
  for (const dir of [root, resolve(root, "seq2bucket"), resolve(root, "sapiometer")]) {
    for (const name of await readdir(dir)) {
      if (/\.(js|html|css)$/.test(name)) paths.push(resolve(dir, name));
    }
  }
  const tokens = [];
  for (const path of paths) {
    const text = await readFile(path, "utf8");
    tokens.push(
      ...[...text.matchAll(/(?:ASSET_VERSION = "|[?]v=)([0-9]{8}-[0-9]{6})/g)].map((m) => m[1])
    );
  }
  assert.ok(tokens.length >= 30, `only ${tokens.length} tokens found`);
  assert.equal(new Set(tokens).size, 1);
});
