import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(resolve(here, "../pairing.js"), "utf8");
const pairing = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const { pairSequenceFiles, describeGroups } = pairing;

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
  assert.equal(groups[0].kind, "paired");
  assert.equal(groups[0].file1.name, "sample_S1_L001_R1_001.fastq.gz");
  assert.equal(groups[0].file2.name, "sample_S1_L001_R2_001.fastq.gz");
});

test("keeps unpaired filenames as single-end groups", () => {
  const groups = pairSequenceFiles([file("run/reads.fastq.gz")]);
  assert.deepEqual(groups.map((g) => g.kind), ["single"]);
});

test("does not treat sample or lane numbers as mate tokens", () => {
  const groups = pairSequenceFiles([file("run/sample_S1_L001.fastq.gz")]);
  assert.deepEqual(groups.map((g) => g.kind), ["single"]);
});

test("pairs simple trailing _1/_2 filenames", () => {
  const groups = pairSequenceFiles([file("run/reads_1.fq.gz"), file("run/reads_2.fq.gz")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "paired");
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
  const pair = { kind: "paired" };
  const single = { kind: "single" };
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
