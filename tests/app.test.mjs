// One cache token across updeacon and sssender, and the Deacon transform on sssender's contract
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const load = (path) => import(`${pathToFileURL(resolve(root, path))}?test=${Date.now()}`);

test("the source module graph uses one cache token, vendored files included", async () => {
  const files = execFileSync(resolve(root, "scripts/stamp-cache-token.sh"), ["--list"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const tokens = [];
  for (const path of files) {
    const text = await readFile(resolve(root, path), "utf8");
    tokens.push(...[...text.matchAll(/(?:ASSET_VERSION = "|[?]v=)([0-9]{8}-[0-9]{6})/g)].map((m) => m[1]));
  }
  assert.ok(tokens.length >= files.length, `only ${tokens.length} tokens in ${files.length} files`);
  assert.equal(new Set(tokens).size, 1);
});

const file = (path, text = "@r\nACGT\n+\nIIII\n") => {
  const f = new File([text], path.split("/").pop());
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
};

test("Deacon runs one group at a time, gzips names and summarises each pair", async () => {
  const { deaconTransform } = await load("deacon.js");
  const { pairSequenceFiles } = await load("pairing.js");
  const { runUpload } = await load("sssender/core/pipeline.js");

  let active = 0;
  let peak = 0;
  const engine = {
    filterGroup(group, hooks) {
      active++;
      peak = Math.max(peak, active);
      hooks.onStats({ readsIn: 4, readsOut: 3, basesIn: 40, basesOut: 30 }, "2");
      return group.files.map(() => ({ stream: new Blob(["gz"]).stream() }));
    },
  };
  const uploaded = [];
  const uploader = {
    async preflight() {},
    async uploadGroup(item, outputs) {
      assert.equal(outputs.length, item.files.length);
      await new Promise((r) => setImmediate(r));
      active--;
      uploaded.push(...item.keys);
      return item.keys;
    },
    async putSmall(key, body) {
      uploaded.push([key, key.endsWith(".deacon.json") ? JSON.parse(await body.text()) : null]);
    },
  };
  const groups = pairSequenceFiles([
    file("run/s_R1.fastq"),
    file("run/s_R2.fastq"),
    file("run/lone.fq.gz"),
  ]);
  const { keys } = await runUpload({
    groups,
    keyBase: "updeacon/x",
    uploader,
    transform: deaconTransform({ engine, indexMeta: () => ({ filename: "i.idx", k: 31, w: 15 }) }),
    concurrency: 4, // ignored, as Deacon has one worker
  });
  assert.equal(peak, 1);
  assert.deepEqual(keys, [
    "updeacon/x/_CLIENT.json",
    "updeacon/x/run/lone.fq.gz",
    "updeacon/x/run/lone.fq.gz.deacon.json",
    "updeacon/x/run/s_R1.fastq.gz",
    "updeacon/x/run/s_R2.fastq.gz",
    "updeacon/x/run/s_R1.fastq.gz.deacon.json",
  ]);
  const summary = uploaded.find((u) => Array.isArray(u) && u[0].endsWith("s_R1.fastq.gz.deacon.json"))[1];
  assert.equal(summary.input, "run/s_R1.fastq");
  assert.equal(summary.input2, "run/s_R2.fastq");
  assert.equal(summary.output, "updeacon/x/run/s_R1.fastq.gz");
  assert.equal(summary.output2, "updeacon/x/run/s_R2.fastq.gz");
  assert.equal(summary.seqs_removed, 1);
  const single = uploaded.find((u) => Array.isArray(u) && u[0].endsWith("lone.fq.gz.deacon.json"))[1];
  assert.equal(single.input2, null);
  assert.equal(single.output2, null);
});

test("a file Deacon can't read is skipped, and the rest of the run goes on", async () => {
  const { deaconTransform } = await load("deacon.js");
  const { runUpload } = await load("sssender/core/pipeline.js");
  const engine = {
    filterGroup(group) {
      const bad = group.files[0].name.startsWith("bad");
      const stream = new ReadableStream({
        pull(c) {
          if (bad) c.error(Object.assign(new Error("Filtering failed: invalid gzip header"), { kind: "input" }));
          else (c.enqueue(new Uint8Array([1])), c.close());
        },
      });
      return [{ stream }];
    },
  };
  const small = [];
  const uploader = {
    async preflight() {},
    async uploadGroup(item, outputs) {
      await new Response(outputs[0].stream).arrayBuffer();
      return item.keys;
    },
    async putSmall(key, body) {
      small.push([key, await body.text()]);
    },
  };
  const { failed, keys } = await runUpload({
    groups: [file("run/bad.fq.gz"), file("run/good.fq")].map((f) => ({ label: f.name, size: f.size, files: [f] })),
    keyBase: "updeacon/x",
    uploader,
    transform: deaconTransform({ engine, indexMeta: () => ({ filename: "i", k: 31, w: 15 }) }),
  });
  assert.equal(failed.length, 1);
  assert.deepEqual(keys, [
    "updeacon/x/_CLIENT.json",
    "updeacon/x/run/good.fq.gz",
    "updeacon/x/run/good.fq.gz.deacon.json",
    "updeacon/x/_FAILED.txt",
  ]);
  assert.deepEqual(small.find(([k]) => k.endsWith("_FAILED.txt"))[1], "run/bad.fq.gz\tFiltering failed: invalid gzip header\n");
});
