const assert = require('node:assert/strict');
const { create, VERSION } = require('../web/pixel-producer.js');
class Worker {
  constructor() { Worker.last = this; this.listeners = new Map(); this.messages = []; this.terminated = 0; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  postMessage(value) { this.messages.push(structuredClone(value)); }
  emit(value) { this.listeners.get('message')?.({ data: value }); }
  terminate() { ++this.terminated; }
}
(async () => {
  let shown = 0, wakes = 0;
  const p = create({ Worker, url: 'presenter.js', canvas: {}, slotBytes: 4, onPresent: () => ++shown, onCapacity: () => ++wakes });
  const worker = Worker.last, init = worker.messages[0], state = new Int32Array(init.slotState);
  worker.emit({ type: 'ready', version: VERSION }); await p.ready;
  const publish = n => p.publish(new Uint8Array([n, n, n, 255]), 1, 1, false);
  publish(1); publish(2); publish(3);
  assert.equal(p.frames.length, 3); assert.equal(p.free.length, 0);
  const pinned = p.frames[0]; Atomics.store(state, pinned.id * 2, 2);
  publish(4); assert.equal(p.replacements, 1);
  assert.equal(new Uint8Array(init.buffers[pinned.id])[0], 1, 'A pinned GPU upload must never be overwritten');
  Atomics.store(state, pinned.id * 2, 0);
  worker.emit({ type: 'release', id: pinned.id, sequence: pinned.sequence, shown: 1, refresh: 1000 / 60 });
  assert.equal(p.free.length, 1); assert.equal(wakes, 1); assert.equal(shown, 1);
  worker.emit({ type: 'release', id: pinned.id, sequence: pinned.sequence, shown: 1 });
  assert.equal(p.free.length, 1); assert.equal(shown, 1, 'A repeated release cannot free or count a frame twice');
  // Grow a released slot. Its new generation carries the larger SAB; the
  // existing views remain valid for a consumer still processing older events.
  p.publish(new Uint8Array(8).fill(9), 2, 1, true);
  const grown = worker.messages.at(-1);
  assert(grown.buffer instanceof SharedArrayBuffer); assert.equal(grown.buffer.byteLength, 8);
  assert.equal(new Uint8Array(grown.buffer)[0], 9); assert.equal(init.buffers[grown.id].byteLength, 4);
  // A physically consumed slot may have a release notification queued behind
  // producer work. Reusing it must not let that older event free its new data.
  for (const f of p.frames) Atomics.store(state, f.id * 2, 2);
  const stale = p.frames[0], oldSequence = stale.sequence; Atomics.store(state, stale.id * 2, 0);
  publish(8); const reused = p.frames.find(f => f.id === stale.id); assert.notEqual(reused.sequence, oldSequence);
  const count = p.free.length;
  worker.emit({ type: 'release', id: stale.id, sequence: oldSequence, shown: 2 });
  assert.equal(p.free.length, count, 'A delayed release cannot free a reused generation');
  // Sequence zero is valid after uint32 wrap and must be represented unsigned.
  Atomics.store(state, reused.id * 2, 0); Atomics.store(state, reused.id * 2 + 1, -1);
  publish(10); assert.equal(worker.messages.at(-1).sequence, 0);
  const before = p.frames.length; assert.throws(() => p.publish(new Uint8Array(3), 1, 1, false), /dimensions/);
  assert.equal(p.frames.length, before);
  p.close(); p.close(); assert.equal(worker.terminated, 1); assert.equal(worker.listeners.size, 0);
  const early = create({ Worker, url: 'presenter.js', canvas: {}, slotBytes: 4 }); early.close();
  await assert.rejects(early.ready, { name: 'AbortError' });
  class Port extends Worker {
    start() { this.started = (this.started || 0) + 1; }
    close() { this.closed = (this.closed || 0) + 1; }
  }
  const port = new Port(), connected = create({ port, canvas: {}, slotBytes: 4 });
  assert.equal(port.started, 1); port.emit({ type: 'ready', version: VERSION }); await connected.ready;
  connected.publish(new Uint8Array([1, 2, 3, 255]), 1, 1, false);
  assert.equal(port.messages.at(-1).type, 'frame');
  connected.close(); connected.close();
  assert.equal(port.messages.at(-1).type, 'stop'); assert.equal(port.closed, 1); assert.equal(port.terminated, 0);
  assert.equal(port.listeners.size, 0);
  console.log('PASS: pixel pool pinning, bounded replacement, growth, stale releases, wrap and teardown');
})().catch(error => { console.error(error); process.exitCode = 1; });
