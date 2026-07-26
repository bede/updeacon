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

  for (const cause of ["link", "size", "cors"]) {
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
