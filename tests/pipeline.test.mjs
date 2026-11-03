import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { buildUploadItems, clientEnvironment, clientRecord, findOversizeFiles, rawTransform, runUpload } =
  await import(`${pathToFileURL(resolve(here, "../seq2bucket/pipeline.js"))}?test=${Date.now()}`);

const file = (path, text = "@r\nACGT\n+\nIIII\n") => {
  const f = new File([text], path.split("/").pop());
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
};
const single = (f) => ({ kind: "single", file: f, label: f.name, size: f.size });
const paired = (f1, f2) => ({ kind: "paired", file1: f1, file2: f2, label: "pair", size: f1.size + f2.size });

// Records every call in order, so tests can assert on the protocol sequence
function fakeUploader({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    async preflight(keyBase) {
      calls.push(["preflight", keyBase]);
    },
    async uploadGroup(item, outputs, hooks) {
      if (failOn === item.key) throw new Error("boom");
      const keys = item.kind === "paired" ? [item.key, item.key2] : [item.key];
      hooks.onUploadStart(item.size);
      hooks.onUploadProgress(item.size);
      calls.push(["group", keys, outputs]);
      return keys;
    },
    async putSmall(key, body) {
      calls.push(["small", key, await body.text()]);
    },
  };
}

test("runUpload follows the protocol: preflight, groups, extras, manifest last", async () => {
  const uploader = fakeUploader();
  const transform = {
    name: "t",
    outputName: (p) => p + ".out",
    start: () => ({ stream: "s" }),
    extras: (item) => [{ key: `${item.key}.json`, body: new Blob(["{}"]), contentType: "application/json" }],
  };
  const { keys } = await runUpload({
    groups: [single(file("d/a.fastq"))],
    keyBase: "p/run",
    uploader,
    transform,
  });
  assert.deepEqual(
    uploader.calls.map((c) => [c[0], c[1]]),
    [
      ["preflight", "p/run"],
      ["group", ["p/run/d/a.fastq.out"]],
      ["small", "p/run/d/a.fastq.out.json"],
      ["small", "p/run/_MANIFEST.txt"],
    ]
  );
  assert.deepEqual(keys, ["p/run/d/a.fastq.out", "p/run/d/a.fastq.out.json"]);
  assert.equal(uploader.calls.at(-1)[2], keys.join("\n") + "\n");
});

test("raw uploads hand over the input files untouched, under their own names", async () => {
  const uploader = fakeUploader();
  const r1 = file("s_R1.fastq");
  const r2 = file("s_R2.fastq");
  await runUpload({ groups: [paired(r1, r2)], keyBase: "p/run", uploader, transform: rawTransform });
  const [, keys, outputs] = uploader.calls.find((c) => c[0] === "group");
  assert.deepEqual(keys, ["p/run/s_R1.fastq", "p/run/s_R2.fastq"]);
  assert.equal(outputs.bodyR1, r1);
  assert.equal(outputs.bodyR2, r2);
  // No extras: only the manifest follows the data
  assert.deepEqual(uploader.calls.filter((c) => c[0] === "small").map((c) => c[1]), ["p/run/_MANIFEST.txt"]);
});

test("a failure inside the file loop names the failed group and skips the manifest", async () => {
  const uploader = fakeUploader({ failOn: "p/run/b.fastq" });
  const hooksSeen = [];
  await assert.rejects(
    runUpload({
      groups: [single(file("a.fastq")), single(file("b.fastq"))],
      keyBase: "p/run",
      uploader,
      transform: rawTransform,
      hooks: { onGroupDone: (i) => hooksSeen.push(i) },
    }),
    (err) => err.groupIndex === 1
  );
  assert.deepEqual(hooksSeen, [0]);
  assert.ok(!uploader.calls.some((c) => c[1] === "p/run/_MANIFEST.txt"));
});

test("runUpload reports progress per group through its hooks", async () => {
  const events = [];
  await runUpload({
    groups: [single(file("a.fastq"))],
    keyBase: "p",
    uploader: fakeUploader(),
    transform: {
      name: "t",
      outputName: (p) => p,
      start: (_g, hooks) => {
        hooks.onProgress({ bytesProcessed: 3 });
        hooks.onStats({ readsIn: 1 }, "0.5");
        return { stream: "s" };
      },
    },
    hooks: {
      onGroupStart: (i) => events.push(["start", i]),
      onTransformProgress: (i, m) => events.push(["progress", i, m.bytesProcessed]),
      onUploadStart: (i, n) => events.push(["upload", i, n > 0]),
      onGroupDone: (i, _item, result) => events.push(["done", i, result.stats.readsIn, result.elapsed]),
      onFinalising: () => events.push(["finalising"]),
    },
  });
  assert.deepEqual(events, [
    ["start", 0],
    ["progress", 0, 3],
    ["upload", 0, true],
    ["done", 0, 1, 0.5],
    ["finalising"],
  ]);
});

test("buildUploadItems keys by relative path, through the transform's naming", () => {
  const [item] = buildUploadItems([single(file("run1/a.fastq"))], "p/ts", (p) => p + ".gz");
  assert.equal(item.key, "p/ts/run1/a.fastq.gz");
});

test("findOversizeFiles checks every file of every group against the cap", () => {
  const small = file("a.fastq", "@");
  const big = file("b_R2.fastq", "@".repeat(10));
  assert.deepEqual(findOversizeFiles([single(small), paired(small, big)], 5), [big]);
  assert.deepEqual(findOversizeFiles([single(big)], null), []);
});

test("clientRecord names the app and transform and counts the input", () => {
  const rec = clientRecord({
    app: "seq2bucket",
    transform: "raw",
    groups: [single(file("a.fastq", "@@@@"))],
    extra: { note: 1 },
  });
  assert.equal(rec.app, "seq2bucket");
  assert.equal(rec.transform, "raw");
  assert.equal(rec.groups, 1);
  assert.equal(rec.input_bytes, 4);
  assert.equal(rec.note, 1);
  assert.ok(typeof rec.app_version === "string" && typeof rec.commit === "string");
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

test("seq2bucket imports only its own modules, never Deacon or the apps", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = resolve(here, "../seq2bucket");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".js"))) {
    const text = await readFile(resolve(dir, name), "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import\()\s*["'`]([^"'`]+)["'`]/g)) {
      assert.match(spec, /^\.\/[\w./-]+(\?v=[\w-]+)?$/, `${name} imports ${spec}`);
      assert.doesNotMatch(spec, /\.\.|deacon|protocol|worker/i, `${name} imports ${spec}`);
    }
  }
});
