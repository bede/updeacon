import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(resolve(here, "../presign.js"), "utf8");
const presign = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const {
  parseUploadLink,
  describeExpiry,
  clientEnvironment,
  retryDelayMs,
  isRetryableUploadError,
  postObjectWithRetry,
  postObject,
  STALL_MS,
  RESPONSE_MS,
  SMALL_MS,
  MEMORY_SPOOL_MAX_BYTES,
  prepareSpoolStorage,
  spoolToFile,
} = presign;

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function policy({
  bucket = "test-bucket",
  prefix = "inrb-batch3-k7q2/",
  maxBytes = 5368709120,
  expiration = "2026-07-16T14:22:00Z",
  extra = [],
} = {}) {
  const conditions = [{ bucket }, ["content-length-range", 0, maxBytes], ...extra];
  if (prefix != null) conditions.splice(1, 0, ["starts-with", "$key", prefix]);
  return b64({ expiration, conditions });
}

function link(opts = {}) {
  return `#u=${b64url({
    v: 1,
    endpoint: opts.endpoint ?? "https://s3.climb.ac.uk",
    fields: {
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": "AKIAEXAMPLE/20260709/us-east-1/s3/aws4_request",
      "x-amz-date": "20260709T142200Z",
      policy: policy(opts),
      "x-amz-signature": "a".repeat(64),
      ...(opts.fields ?? {}),
    },
  })}`;
}

test("returns null when the hash carries no link", () => {
  assert.equal(parseUploadLink(""), null);
  assert.equal(parseUploadLink("#"), null);
  assert.equal(parseUploadLink(undefined), null);
  assert.equal(parseUploadLink("#index=panhuman"), null);
});

test("derives bucket, prefix, cap and expiry from the signed policy", () => {
  const parsed = parseUploadLink(link());
  assert.equal(parsed.endpoint, "https://s3.climb.ac.uk");
  assert.equal(parsed.bucket, "test-bucket");
  assert.equal(parsed.prefix, "inrb-batch3-k7q2/");
  assert.equal(parsed.maxBytes, 5368709120);
  assert.equal(parsed.expiresAt, Date.parse("2026-07-16T14:22:00Z"));
  assert.equal(parsed.fields["x-amz-signature"], "a".repeat(64));
});

test("posts the policy back verbatim, signature intact", () => {
  const parsed = parseUploadLink(link());
  // fields must survive untouched: any mutation invalidates the signature
  assert.deepEqual(Object.keys(parsed.fields).sort(), [
    "policy",
    "x-amz-algorithm",
    "x-amz-credential",
    "x-amz-date",
    "x-amz-signature",
  ]);
});

test("carries a session token through when the policy has one", () => {
  const parsed = parseUploadLink(
    link({ fields: { "x-amz-security-token": "tok" }, extra: [{ "x-amz-security-token": "tok" }] })
  );
  assert.equal(parsed.fields["x-amz-security-token"], "tok");
});

test("strips a trailing slash from the endpoint", () => {
  assert.equal(parseUploadLink(link({ endpoint: "https://s3.climb.ac.uk/" })).endpoint, "https://s3.climb.ac.uk");
});

test("refuses a policy that does not scope uploads to a prefix", () => {
  assert.throws(() => parseUploadLink(link({ prefix: null })), /does not restrict uploads to a prefix/);
});

test("refuses a policy with no bucket", () => {
  const hash = `#u=${b64url({
    v: 1,
    endpoint: "https://s3.climb.ac.uk",
    fields: { policy: b64({ expiration: "2026-07-16T14:22:00Z", conditions: [["starts-with", "$key", "p/"]] }), "x-amz-signature": "x" },
  })}`;
  assert.throws(() => parseUploadLink(hash), /names no bucket/);
});

test("refuses a policy with an unparseable expiry", () => {
  assert.throws(() => parseUploadLink(link({ expiration: "whenever" })), /no valid expiry/);
});

test("rejects an unsupported link version", () => {
  const hash = `#u=${b64url({ v: 2, endpoint: "https://x", fields: {} })}`;
  assert.throws(() => parseUploadLink(hash), /version 2 is not supported/);
});

test("rejects a link missing its signature", () => {
  const hash = `#u=${b64url({ v: 1, endpoint: "https://x", fields: { policy: policy() } })}`;
  assert.throws(() => parseUploadLink(hash), /missing required fields/);
});

test("rejects a truncated payload", () => {
  assert.throws(() => parseUploadLink("#u=not-valid-base64-json"), /corrupt/);
});

test("describeExpiry counts down in the largest sensible unit", () => {
  const now = Date.parse("2026-07-09T00:00:00Z");
  const at = (iso) => describeExpiry(Date.parse(iso), now);
  assert.deepEqual(at("2026-07-16T00:00:00Z"), { expired: false, text: "7 days" });
  assert.deepEqual(at("2026-07-10T00:00:00Z"), { expired: false, text: "1 day" });
  assert.deepEqual(at("2026-07-09T03:00:00Z"), { expired: false, text: "3 hours" });
  assert.deepEqual(at("2026-07-09T00:30:00Z"), { expired: false, text: "30 minutes" });
  assert.deepEqual(at("2026-07-09T00:00:30Z"), { expired: false, text: "less than a minute" });
  // A link minted "7 days" ago-to-the-second must not read as 6
  assert.deepEqual(at("2026-07-15T23:59:30Z"), { expired: false, text: "7 days" });
});

test("describeExpiry reports elapsed time once expired", () => {
  const now = Date.parse("2026-07-09T00:00:00Z");
  assert.deepEqual(describeExpiry(Date.parse("2026-07-07T00:00:00Z"), now), { expired: true, text: "2 days" });
  assert.deepEqual(describeExpiry(now, now), { expired: true, text: "less than a minute" });
});

test("clientEnvironment reports provenance and nothing more", () => {
  const env = clientEnvironment();
  // The signature rides in the fragment, so no URL may ever appear here
  const serialised = JSON.stringify(env);
  assert.ok(!/#u=|x-amz-signature|policy|http/i.test(serialised), serialised);
  assert.deepEqual(Object.keys(env).filter((k) => k !== "device_memory_gb").sort(), [
    "hardware_concurrency",
    "languages",
    "platform",
    "timezone",
    "user_agent",
  ]);
  assert.ok(Array.isArray(env.languages));
  assert.ok(typeof env.timezone === "string" && env.timezone.length > 0);
});

test("retryDelayMs backs off exponentially and caps at one minute", () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(2), 2000);
  assert.equal(retryDelayMs(6), 32000);
  assert.equal(retryDelayMs(7), 60000);
  assert.equal(retryDelayMs(20), 60000);
});

test("isRetryableUploadError only retries transient upload failures", () => {
  const network = new Error("offline");
  network.updeaconCause = "network";
  assert.equal(isRetryableUploadError(network), true);

  for (const status of [408, 429, 500, 503]) {
    const err = new Error(`HTTP ${status}`);
    err.status = status;
    assert.equal(isRetryableUploadError(err), true, String(status));
  }

  for (const cause of ["link", "size", "storage", "cors"]) {
    const err = new Error(cause);
    err.updeaconCause = cause;
    assert.equal(isRetryableUploadError(err), false, cause);
  }

  const badRequest = new Error("bad request");
  badRequest.status = 400;
  assert.equal(isRetryableUploadError(badRequest), false);
});

test("postObjectWithRetry retries transient errors until the POST succeeds", async () => {
  const attempts = [];
  const sleeps = [];
  const link = { expiresAt: Date.parse("2026-07-09T00:10:00Z") };
  const network = new Error("offline");
  network.updeaconCause = "network";

  await postObjectWithRetry({
    link,
    key: "prefix/file.fastq.gz",
    body: new Blob(["x"]),
    nowFn: () => Date.parse("2026-07-09T00:00:00Z"),
    sleepFn: async (ms) => sleeps.push(ms),
    postOnce: async () => {
      attempts.push(1);
      if (attempts.length < 3) throw network;
    },
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("postObjectWithRetry stops retrying when the magic link expires", async () => {
  let now = Date.parse("2026-07-09T00:00:00Z");
  const sleeps = [];
  const link = { expiresAt: now + 2500 };
  const network = new Error("offline");
  network.updeaconCause = "network";

  await assert.rejects(
    () =>
      postObjectWithRetry({
        link,
        key: "prefix/file.fastq.gz",
        body: new Blob(["x"]),
        nowFn: () => now,
        sleepFn: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        postOnce: async () => {
          throw network;
        },
      }),
    /magic link expired/
  );

  assert.deepEqual(sleeps, [1000, 1500]);
});

test("postObjectWithRetry waits for online after an offline upload failure", async () => {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });

  const events = [];
  const attempts = [];
  const link = { expiresAt: Date.parse("2026-07-09T00:10:00Z") };
  const offline = new Error("Connection lost during upload.");
  offline.updeaconCause = "network";
  offline.offline = true;

  try {
    await postObjectWithRetry({
      link,
      key: "prefix/file.fastq.gz",
      body: new Blob(["x"]),
      nowFn: () => Date.parse("2026-07-09T00:00:00Z"),
      sleepFn: () => new Promise(() => {}),
      waitOnlineFn: async () => {
        events.push("wait-online");
        globalThis.navigator.onLine = true;
      },
      onRetry: (info) => events.push(info.waitingOnline ? "waiting-online" : info.resumed ? "resumed" : "backoff"),
      postOnce: async () => {
        attempts.push(1);
        if (attempts.length === 1) {
          globalThis.navigator.onLine = false;
          throw offline;
        }
      },
    });
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }

  assert.equal(attempts.length, 2);
  assert.deepEqual(events, ["waiting-online", "wait-online", "resumed"]);
});

test("postObjectWithRetry does not start a POST while already offline", async () => {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: false },
  });

  const events = [];
  const attempts = [];
  const link = { expiresAt: Date.parse("2026-07-09T00:10:00Z") };

  try {
    await postObjectWithRetry({
      link,
      key: "prefix/file.fastq.gz",
      body: new Blob(["x"]),
      nowFn: () => Date.parse("2026-07-09T00:00:00Z"),
      sleepFn: () => new Promise(() => {}),
      waitOnlineFn: async () => {
        events.push(`wait-before-${attempts.length}`);
        globalThis.navigator.onLine = true;
      },
      onRetry: (info) => events.push(info.waitingOnline ? "waiting-online" : info.resumed ? "resumed" : "backoff"),
      postOnce: async () => {
        attempts.push(1);
      },
    });
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }

  assert.equal(attempts.length, 1);
  assert.deepEqual(events, ["waiting-online", "wait-before-0", "resumed"]);
});

test("postObject aborts an in-flight XHR when the browser goes offline", async () => {
  const originalWindow = globalThis.window;
  const originalXhr = globalThis.XMLHttpRequest;
  const listeners = new Map();
  let sent = false;
  let aborted = false;

  class MockXhr {
    constructor() {
      this.upload = {};
    }
    open() {}
    send() {
      sent = true;
    }
    abort() {
      aborted = true;
      this.onabort?.();
    }
  }

  globalThis.window = {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  globalThis.XMLHttpRequest = MockXhr;

  try {
    const upload = postObject({
      link: { endpoint: "https://example.test", bucket: "bucket", fields: {} },
      key: "prefix/file.fastq.gz",
      body: new Blob(["x"]),
      onProgress: () => {},
    });

    assert.equal(sent, true);
    listeners.get("offline")();

    await assert.rejects(upload, (err) => {
      assert.equal(err.updeaconCause, "network");
      assert.equal(err.offline, true);
      return /Connection lost/.test(err.message);
    });
    assert.equal(aborted, true);
    assert.equal(listeners.has("offline"), false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.XMLHttpRequest = originalXhr;
  }
});

// --- Idle timeouts ------------------------------------------------------------
// Timers are injected so these run instantly; the real durations are minutes long.

function fakeTimers() {
  let seq = 0;
  let setCount = 0;
  const pending = new Map();
  return {
    setTimerFn(fn, ms) {
      setCount++;
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimerFn(id) {
      pending.delete(id);
    },
    get armed() {
      return [...pending.values()].map((t) => t.ms);
    },
    get setCount() {
      return setCount;
    },
    // Fire by duration, so tests read as "the stall timer expired"
    fire(ms) {
      for (const [id, t] of pending) {
        if (t.ms !== ms) continue;
        pending.delete(id);
        t.fn();
        return;
      }
      throw new Error(`no timer armed for ${ms}ms (armed: ${[...pending.values()].map((t) => t.ms)})`);
    },
  };
}

// A pending promise resolves the sentinel first; a settled one wins the race
const settledYet = (p) =>
  Promise.race([p.then(() => true, () => true), Promise.resolve(false)]);

function withMockXhr(run) {
  const originalWindow = globalThis.window;
  const originalXhr = globalThis.XMLHttpRequest;
  const listeners = new Map();
  let xhr = null;

  class MockXhr {
    constructor() {
      this.upload = {};
      this.status = 200;
      this.statusText = "OK";
      this.responseText = "";
      this.aborted = false;
      xhr = this;
    }
    open() {}
    send() {}
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    progress(loaded) {
      this.upload.onprogress?.({ loaded, total: 1000 });
    }
    bodySent() {
      this.upload.onloadend?.();
    }
    respond(status = 200) {
      this.status = status;
      this.onload?.();
    }
  }

  globalThis.window = {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  globalThis.XMLHttpRequest = MockXhr;

  const link = { endpoint: "https://example.test", bucket: "bucket", fields: {} };
  const start = (timers) =>
    postObject({
      link,
      key: "prefix/file.fastq.gz",
      body: new Blob(["x"]),
      onProgress: () => {},
      setTimerFn: timers.setTimerFn,
      clearTimerFn: timers.clearTimerFn,
    });

  return (async () => {
    try {
      return await run({ start, goOffline: () => listeners.get("offline")(), xhr: () => xhr });
    } finally {
      globalThis.window = originalWindow;
      globalThis.XMLHttpRequest = originalXhr;
    }
  })();
}

test("a silent upload aborts once the stall timer expires", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(100);
    xhr().progress(200);
    timers.fire(STALL_MS);

    await assert.rejects(upload, (err) => {
      assert.equal(err.updeaconCause, "network");
      assert.equal(isRetryableUploadError(err), true);
      return /stalled/i.test(err.message);
    });
    assert.equal(xhr().aborted, true);
    assert.deepEqual(timers.armed, []);
  }));

test("postObjectWithRetry retries a stalled upload rather than failing the run", async () => {
  const stalled = await withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);
    timers.fire(STALL_MS);
    return upload.catch((err) => err);
  });

  const attempts = [];
  await postObjectWithRetry({
    link: { expiresAt: Date.parse("2026-07-09T00:10:00Z") },
    key: "prefix/file.fastq.gz",
    body: new Blob(["x"]),
    nowFn: () => Date.parse("2026-07-09T00:00:00Z"),
    sleepFn: async () => {},
    postOnce: async () => {
      attempts.push(1);
      if (attempts.length === 1) throw stalled;
    },
  });

  assert.equal(attempts.length, 2);
});

test("continuing progress keeps resetting the stall timer", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    for (const loaded of [100, 200, 300, 400]) xhr().progress(loaded);

    // One live timer, not one per event
    assert.deepEqual(timers.armed, [STALL_MS]);
    assert.equal(await settledYet(upload), false);

    xhr().respond(204);
    await upload;
  }));

test("duplicate progress events do not conceal a stalled upload", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(100);
    const afterAdvance = timers.setCount;
    xhr().progress(100);
    assert.equal(timers.setCount, afterAdvance);

    timers.fire(STALL_MS);
    await assert.rejects(upload, /stalled/i);
  }));

test("silence after the body is sent is bounded by the response timer", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(1000);
    assert.deepEqual(timers.armed, [STALL_MS]);

    xhr().bodySent();
    // The store commits silently; a stall timer here would kill a healthy upload
    assert.deepEqual(timers.armed, [RESPONSE_MS]);

    timers.fire(RESPONSE_MS);
    await assert.rejects(upload, (err) => {
      assert.equal(err.updeaconCause, "network");
      return /timed out waiting for the object store/i.test(err.message);
    });
  }));

test("a slow but arriving response still succeeds, leaving no timer armed", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(1000);
    xhr().bodySent();
    xhr().respond(204);

    await upload;
    assert.deepEqual(timers.armed, []);
  }));

test("loadend fired by an abort does not arm the response timer", async () =>
  withMockXhr(async ({ start, xhr, goOffline }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(100);
    goOffline();
    xhr().bodySent(); // abort() fires loadend on the upload object too

    await assert.rejects(upload, /Connection lost/);
    assert.deepEqual(timers.armed, []);
  }));

test("an offline abort keeps its cause and clears the timers", async () =>
  withMockXhr(async ({ start, xhr, goOffline }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    goOffline();

    await assert.rejects(upload, (err) => {
      assert.equal(err.offline, true);
      return /Connection lost/.test(err.message);
    });
    // Settled, so a stall timer can no longer fire and reject a second time
    assert.deepEqual(timers.armed, []);
  }));

function withMockFetch(impl, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  const timers = fakeTimers();
  const post = () =>
    postObject({
      link: { endpoint: "https://example.test", bucket: "bucket", fields: {} },
      key: "prefix/_MANIFEST.txt",
      body: new Blob(["x"]),
      contentType: "text/plain",
      setTimerFn: timers.setTimerFn,
      clearTimerFn: timers.clearTimerFn,
    });
  return (async () => {
    try {
      return await run({ post, timers });
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();
}

test("a silent small-object POST times out and stays retryable", async () =>
  withMockFetch(
    (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    async ({ post, timers }) => {
      const upload = post();
      assert.deepEqual(timers.armed, [SMALL_MS]);

      timers.fire(SMALL_MS);
      await assert.rejects(upload, (err) => {
        assert.equal(err.updeaconCause, "network");
        assert.equal(isRetryableUploadError(err), true);
        return /timed out/i.test(err.message);
      });
      assert.deepEqual(timers.armed, []);
    }
  ));

test("the small-object timer is cleared on success", async () =>
  withMockFetch(
    async () => ({ ok: true }),
    async ({ post, timers }) => {
      await post();
      assert.deepEqual(timers.armed, []);
    }
  ));

test("the small-object timer is cleared on an HTTP error", async () =>
  withMockFetch(
    async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "<Error><Code>AccessDenied</Code><Message>nope</Message></Error>",
    }),
    async ({ post, timers }) => {
      await assert.rejects(post(), (err) => {
        assert.equal(err.updeaconCause, "link");
        return err.name === "AccessDenied";
      });
      assert.deepEqual(timers.armed, []);
    }
  ));

test("the small-object timer covers a stalled HTTP error body", async () =>
  withMockFetch(
    async (_url, opts) => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
      text: () =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }),
    async ({ post, timers }) => {
      const upload = post();
      await Promise.resolve();
      assert.deepEqual(timers.armed, [SMALL_MS]);
      timers.fire(SMALL_MS);
      await assert.rejects(upload, /timed out/i);
      assert.deepEqual(timers.armed, []);
    }
  ));

// --- Spool storage ------------------------------------------------------------

test("large link uploads require OPFS rather than an unbounded memory fallback", async () => {
  await assert.rejects(
    prepareSpoolStorage(MEMORY_SPOOL_MAX_BYTES + 1, { supported: false }),
    (err) => err.updeaconCause === "storage" && /OPFS support/i.test(err.message)
  );
  await assert.rejects(
    spoolToFile(new ReadableStream(), "large.bin", { expectedBytes: MEMORY_SPOOL_MAX_BYTES + 1 }),
    (err) => err.updeaconCause === "storage"
  );
});

test("small outputs retain the compatibility memory fallback", async () => {
  const prepared = await prepareSpoolStorage(1024, { supported: false });
  assert.deepEqual(prepared, { opfs: false });

  const blob = await spoolToFile(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("reads"));
        controller.close();
      },
    }),
    "small.bin",
    { expectedBytes: 5 }
  );
  assert.equal(await blob.text(), "reads");
});

test("spool preparation requests persistence without guessing the filtered size", async () => {
  let persistCalls = 0;
  const result = await prepareSpoolStorage(80, {
    supported: true,
    persistFn: async () => {
      persistCalls++;
      return true;
    },
  });
  assert.equal(persistCalls, 1);
  assert.deepEqual(result, { opfs: true });
});

test("an actual OPFS quota failure becomes a clear storage error", async () => {
  const originalNavigator = globalThis.navigator;
  const originalHandle = globalThis.FileSystemFileHandle;
  class MockFileHandle {
    createWritable() {}
  }
  Object.defineProperty(globalThis, "FileSystemFileHandle", {
    configurable: true,
    value: MockFileHandle,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        async getDirectory() {
          return {
            async getDirectoryHandle() {
              return {
                async getFileHandle() {
                  return {
                    async createWritable() {
                      const err = new Error("quota full");
                      err.name = "QuotaExceededError";
                      throw err;
                    },
                  };
                },
              };
            },
          };
        },
      },
    },
  });

  try {
    await assert.rejects(
      spoolToFile(new ReadableStream(), "full.bin", { expectedBytes: 1024 }),
      (err) => err.updeaconCause === "storage" && /private storage/i.test(err.message)
    );
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, "FileSystemFileHandle", {
      configurable: true,
      value: originalHandle,
    });
  }
});
