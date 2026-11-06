import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { pairSequenceFiles, describeGroups } = await import(
  `${pathToFileURL(resolve(here, "../pairing.js"))}?test=${Date.now()}`
);
// sssender groups have no kind. A pair is a two-file group
const kind = (g) => (g.files.length === 2 ? "paired" : "single");

function file(path, size = 1) {
  const name = path.split("/").pop();
  return { name, size, webkitRelativePath: path };
}

test("pairs standard Illumina R1/R2 filenames in the same directory", () => {
  const groups = pairSequenceFiles([
    file("run/sample_S1_L001_R1_001.fastq.gz"),
    file("run/sample_S1_L001_R2_001.fastq.gz"),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(kind(groups[0]), "paired");
  assert.deepEqual(groups[0].files.map((f) => f.name), [
    "sample_S1_L001_R1_001.fastq.gz",
    "sample_S1_L001_R2_001.fastq.gz",
  ]);
});

test("keeps unpaired filenames as single-end groups", () => {
  const groups = pairSequenceFiles([file("run/reads.fastq.gz")]);
  assert.deepEqual(groups.map(kind), ["single"]);
});

test("does not treat sample or lane numbers as mate tokens", () => {
  const groups = pairSequenceFiles([file("run/sample_S1_L001.fastq.gz")]);
  assert.deepEqual(groups.map(kind), ["single"]);
});

test("pairs simple trailing _1/_2 filenames", () => {
  const groups = pairSequenceFiles([file("run/reads_1.fq.gz"), file("run/reads_2.fq.gz")]);
  assert.equal(groups.length, 1);
  assert.equal(kind(groups[0]), "paired");
});

test("does not pair _1/_2 when other numbered chunks share the prefix (ONT)", () => {
  const groups = pairSequenceFiles([
    file("run/barcode02_0.fastq"),
    file("run/barcode02_1.fastq"),
    file("run/barcode02_2.fastq"),
    file("run/barcode02_3.fastq"),
    file("run/barcode02_10.fastq"),
  ]);
  assert.deepEqual(
    groups.map(kind),
    ["single", "single", "single", "single", "single"]
  );
});

test("does not pair files across directories", () => {
  assert.throws(
    () =>
      pairSequenceFiles([
        file("laneA/sample_R1.fastq.gz"),
        file("laneB/sample_R2.fastq.gz"),
      ]),
    /Ambiguous or incomplete pair/
  );
});

test("rejects orphan mates", () => {
  assert.throws(
    () => pairSequenceFiles([file("run/sample_R1.fastq.gz")]),
    /Ambiguous or incomplete pair/
  );
});

test("rejects duplicate mates", () => {
  assert.throws(
    () =>
      pairSequenceFiles([
        file("run/sample_R1.fastq.gz"),
        file("run/sample_R1.fq.gz"),
        file("run/sample_R2.fastq.gz"),
      ]),
    /Ambiguous or incomplete pair/
  );
});

test("describeGroups names pairs and files, never conflating them", () => {
  const pair = { files: [1, 2] };
  const single = { files: [1] };
  assert.equal(describeGroups([pair]), "1 pair");
  assert.equal(describeGroups([pair, pair]), "2 pairs");
  assert.equal(describeGroups([single]), "1 file");
  // The old label called three unpaired files "3 pairs"
  assert.equal(describeGroups([single, single, single]), "3 files");
  assert.equal(describeGroups([pair, single, single]), "1 pair and 2 files");
  assert.equal(describeGroups([pair, pair, single]), "2 pairs and 1 file");
  assert.equal(describeGroups([]), "0 files");
});

test("describeGroups counts real groups from pairSequenceFiles", () => {
  const groups = pairSequenceFiles([
    file("run/a_R1.fastq.gz"),
    file("run/a_R2.fastq.gz"),
    file("run/lonely.fastq"),
  ]);
  assert.equal(describeGroups(groups), "1 pair and 1 file");
});
