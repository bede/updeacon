import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { checkReachable, makeLinkUploader } = await import(
  `${pathToFileURL(resolve(here, "../uploaders.js"))}?test=${Date.now()}`
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
  assert.equal(retries[0].error.updeaconCause, "network");
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
    (err) => err.updeaconCause === "cors"
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

test("the source module graph uses one cache token", async () => {
  const paths = [
    "../index.html",
    "../app.js",
    "../uploaders.js",
    "../worker.js",
    "../sapiometer/index.html",
    "../sapiometer.js",
  ];
  const tokens = [];
  for (const path of paths) {
    const text = await readFile(resolve(here, path), "utf8");
    tokens.push(
      ...[...text.matchAll(/(?:ASSET_VERSION = "|[?]v=)([0-9]{8}-[0-9]{6})/g)].map(
        (m) => m[1]
      )
    );
  }
  assert.ok(tokens.length >= 10);
  assert.equal(new Set(tokens).size, 1);
});
