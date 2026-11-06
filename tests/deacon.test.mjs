// Engine recovery from a crashed or stalled worker. Tests play the worker's side
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { createDeaconEngine } = await import(`${pathToFileURL(resolve(here, "../deacon.js"))}?test=${Date.now()}`);
const { MSG } = await import(`${pathToFileURL(resolve(here, "../protocol.js"))}?test=${Date.now()}`);

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

class FakeWorker {
  constructor() {
    this.sent = [];
    this.terminated = false;
  }
  postMessage(msg) {
    this.sent.push(msg.type);
  }
  reply(data) {
    this.onmessage({ data });
  }
  terminate() {
    this.terminated = true;
  }
}

function setup({ reloadIndex = async () => new ArrayBuffer(4) } = {}) {
  const workers = [];
  const timers = new Map();
  let seq = 0;
  const loaded = [];
  const errors = [];
  const engine = createDeaconEngine({
    onIndexLoaded: (info) => loaded.push(info),
    onError: (m) => errors.push(m),
    reloadIndex,
    stallMs: 1000,
    makeWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    setTimerFn: (fn) => (timers.set(++seq, fn), seq),
    clearTimerFn: (id) => timers.delete(id),
  });
  const boot = (w) => {
    w.reply({ type: MSG.READY });
  };
  boot(workers[0]);
  engine.loadIndex(new ArrayBuffer(4));
  workers[0].reply({ type: MSG.INDEX_LOADED, info: "k=31, w=15" });
  const fireTimers = () => {
    const fns = [...timers.values()];
    timers.clear();
    fns.forEach((fn) => fn());
  };
  return { engine, workers, timers, loaded, errors, boot, fireTimers };
}

const single = { files: [{ name: "a.fq" }] };

test("a crashed worker fails its file for a retry, then a fresh one reloads the index", async () => {
  const { engine, workers, loaded, boot } = setup();
  const reader = engine.filterGroup(single)[0].stream.getReader();
  const read = reader.read();
  await flush();
  assert.deepEqual(workers[0].sent, [MSG.INIT, MSG.LOAD_INDEX, MSG.FILTER, MSG.PULL]);

  workers[0].onerror({ preventDefault() {} });
  await assert.rejects(read, (err) => err.retry === true && err.kind === "input" && /crashed/.test(err.message));
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);

  // The next file waits for the index to reload
  const next = engine.filterGroup(single)[0].stream.getReader().read();
  await flush();
  assert.deepEqual(workers[1].sent, [MSG.INIT]);
  boot(workers[1]);
  await flush();
  assert.deepEqual(workers[1].sent, [MSG.INIT, MSG.LOAD_INDEX]);
  workers[1].reply({ type: MSG.INDEX_LOADED, info: "k=31, w=15" });
  await flush();
  assert.deepEqual(workers[1].sent, [MSG.INIT, MSG.LOAD_INDEX, MSG.FILTER, MSG.PULL]);
  assert.deepEqual(loaded, ["k=31, w=15"]); // a restart doesn't announce the index again
  workers[1].reply({ type: MSG.OUTPUT_CHUNK_BATCH, chunks: [new Uint8Array([7]).buffer], done: true, stats: {} });
  assert.deepEqual([...(await next).value], [7]);
});

test("a pull with no progress for too long counts as a stall", async () => {
  const { engine, workers, timers, fireTimers } = setup();
  const read = engine.filterGroup(single)[0].stream.getReader().read();
  await flush();
  assert.equal(timers.size, 1); // armed by the PULL
  workers[0].reply({ type: MSG.PROGRESS, bytesProcessed: 1 });
  assert.equal(timers.size, 1); // progress re-arms the same timer
  fireTimers();
  await assert.rejects(read, (err) => err.retry && /stopped responding/.test(err.message));
  assert.equal(workers.length, 2);
});

test("an idle worker waiting on its consumer is never a stall", async () => {
  const { engine, workers, timers } = setup();
  const reader = engine.filterGroup(single)[0].stream.getReader();
  const read = reader.read();
  await flush();
  workers[0].reply({ type: MSG.OUTPUT_CHUNK_BATCH, chunks: [new Uint8Array([1]).buffer], done: false });
  await read;
  await flush();
  // The stream pulls one batch ahead
  workers[0].reply({ type: MSG.OUTPUT_CHUNK_BATCH, chunks: [new Uint8Array([2]).buffer], done: false });
  await flush();
  // The consumer (e.g. an upload waiting for the connection) asks for no more
  assert.equal(workers[0].sent.filter((t) => t === MSG.PULL).length, 2);
  assert.equal(timers.size, 0);
});

test("if the index can't be reloaded, later files fail in a way that stops the run", async () => {
  const { engine, workers } = setup({ reloadIndex: async () => Promise.reject(new Error("not cached")) });
  const read = engine.filterGroup(single)[0].stream.getReader().read();
  await flush();
  workers[0].onerror({ preventDefault() {} });
  await assert.rejects(read, (err) => err.retry);
  const next = engine.filterGroup(single)[0].stream.getReader().read();
  await assert.rejects(next, (err) => err.kind === "storage" && /reload the Deacon index/.test(err.message));
});

test("a filter error is the file's problem, and needs no restart", async () => {
  const { engine, workers } = setup();
  const read = engine.filterGroup(single)[0].stream.getReader().read();
  await flush();
  workers[0].reply({ type: MSG.ERROR, message: "Filtering failed: invalid gzip header" });
  await assert.rejects(read, (err) => err.kind === "input" && !err.retry);
  assert.equal(workers.length, 1);
});
