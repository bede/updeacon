import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = (name) => `${pathToFileURL(resolve(here, "../seq2bucket", name))}?test=${Date.now()}`;
const { signingKey, sanitise, makePrefix, mintMagicLink, POST_MAX_BYTES } = await import(lib("mint.js"));
const { parseMagicLink } = await import(lib("link.js"));

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const NOW = new Date("2026-07-09T14:22:00Z");
const BASE = { endpoint: "https://s3.example.test", bucket: "b", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" };
// Suffix a1b2: letter 0, digit 1, letter 1, digit 2
const fixedSuffix = () => { const picks = [0, 1, 1, 2]; return () => picks.shift(); };

test("signing key matches AWS's published SigV4 example", async () => {
  const key = await signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
  assert.equal(hex(key), "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
});

test("policy and signature are byte-identical to scripts/mint-magic-link.py", async () => {
  // Expected values printed by the Python script for the same inputs
  const { fields, prefix } = await mintMagicLink({ ...BASE, name: "X", randomFn: fixedSuffix(), baseUrl: "https://x.test/", now: NOW });
  assert.equal(prefix, "x-a1b2/");
  assert.equal(
    fields.policy,
    "eyJleHBpcmF0aW9uIjoiMjAyNi0wNy0xNlQxNDoyMjowMFoiLCJjb25kaXRpb25zIjpbeyJidWNrZXQiOiJiIn0sWyJzdGFydHMtd2l0aCIsIiRrZXkiLCJ4LWExYjIvIl0sWyJjb250ZW50LWxlbmd0aC1yYW5nZSIsMCw1MzY4NzA5MTIwXSxbInN0YXJ0cy13aXRoIiwiJENvbnRlbnQtVHlwZSIsIiJdLHsieC1hbXotYWxnb3JpdGhtIjoiQVdTNC1ITUFDLVNIQTI1NiJ9LHsieC1hbXotY3JlZGVudGlhbCI6IkFLSUFFWEFNUExFLzIwMjYwNzA5L3VzLWVhc3QtMS9zMy9hd3M0X3JlcXVlc3QifSx7IngtYW16LWRhdGUiOiIyMDI2MDcwOVQxNDIyMDBaIn1dfQ=="
  );
  assert.equal(fields["x-amz-signature"], "74d40cb0a0bfc98548bbd50402947fd8083bf7f35cce880025a852d4249e8d7f");
  assert.deepEqual(Object.keys(fields), ["x-amz-algorithm", "x-amz-credential", "x-amz-date", "policy", "x-amz-signature"]);
});

test("a minted link is read back by the upload pages", async () => {
  const { link, expiresAt } = await mintMagicLink({
    ...BASE,
    endpoint: "https://s3.example.test/",
    name: "batch",
    raw: true,
    randomFn: fixedSuffix(),
    days: 3,
    maxBytes: 1024,
    baseUrl: "https://bede.im/seq2bucket",
    now: NOW,
  });
  assert.match(link, /^https:\/\/bede\.im\/seq2bucket\/#u=[\w-]+$/);
  const parsed = parseMagicLink(new URL(link).hash);
  assert.equal(parsed.endpoint, "https://s3.example.test");
  assert.equal(parsed.bucket, "b");
  assert.equal(parsed.prefix, "raw/batch-a1b2/");
  assert.equal(parsed.maxBytes, 1024);
  assert.equal(parsed.expiresAt, expiresAt.getTime());
  assert.equal(expiresAt.toISOString(), "2026-07-12T14:22:00.000Z");
});

test("prefixes are sanitised, suffixed letter-digit-letter-digit, and rooted under raw/ on request", () => {
  assert.equal(sanitise("  INRB Batch 3!! "), "inrb-batch-3");
  assert.throws(() => sanitise("!!!"), /letter or digit/);
  assert.match(makePrefix("Smoke Test!!"), /^smoke-test-[a-z][0-9][a-z][0-9]\/$/);
  assert.match(makePrefix("Smoke Test!!", { raw: true }), /^raw\/smoke-test-[a-z][0-9][a-z][0-9]\/$/);
});

test("errors name the empty fields by their labels, in on-screen order", async () => {
  const args = { ...BASE, name: "x", baseUrl: "https://x.test/", now: NOW };
  await assert.rejects(mintMagicLink({ ...args, endpoint: "", secretAccessKey: "" }), {
    message: "Enter the server address and secret access key.",
  });
  // Credentials are checked before the name, so a blank form asks for them first
  await assert.rejects(mintMagicLink({ ...args, bucket: "", name: "" }), { message: "Enter the bucket." });
  await assert.rejects(mintMagicLink({ ...args, name: "" }), { message: "Enter a name for the link." });
  await assert.rejects(mintMagicLink({ ...args, name: "!!!" }), /at least one letter or digit/);
});

test("refuses out-of-range lifetimes and file sizes, too small as well as too large", async () => {
  const args = { ...BASE, name: "x", baseUrl: "https://x.test/", now: NOW };
  for (const days of [0, 8, 2.5, NaN]) {
    await assert.rejects(mintMagicLink({ ...args, days }), /whole number of days from 1 to 7/);
  }
  for (const maxBytes of [0, -1, NaN, POST_MAX_BYTES + 1]) {
    await assert.rejects(mintMagicLink({ ...args, maxBytes }), /greater than 0 and at most 5 GB/);
  }
});
