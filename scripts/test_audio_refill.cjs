// Exercise the production worklet with deterministic concurrent publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shell = fs.readFileSync(process.env.SSX3_WORKLET_SHELL || path.join(__dirname, '../web/shell.html'), 'utf8');
const source = shell.match(/const workletSource = `([\s\S]*?)`;/)?.[1];
assert(source, 'Missing production audio worklet');

const sample = (position, channel) => ((position >>> 0) % 1024 + 1) * (channel ? -8 : 16);
function fixture({ read = 0, queued = 0, duringSample, duringOutput, afterPlayback = false, refillFrames = 128 } = {}) {
  const capacity = 4096;
  const buffer = new SharedArrayBuffer(16 + capacity * 4);
  const ring = new Uint32Array(buffer, 0, 4);
  const samples = new Int16Array(buffer, 16);
  ring[0] = ring[1] = read;
  ring[2] = capacity;
  let published = false, writeLoads = 0, Output;
  function append(count) {
    const write = Atomics.load(ring, 0);
    for (let i = 0; i < count; ++i) {
      const position = (write + i) >>> 0, at = (position & (capacity - 1)) * 2;
      samples[at] = sample(position, 0);
      samples[at + 1] = sample(position, 1);
    }
    Atomics.store(ring, 0, (write + count) >>> 0);
  }
  function publishOnce() { if (!published) { published = true; append(refillFrames); } }
  append(queued);
  const SampleView = function(...args) {
    return new Proxy(new Int16Array(...args), {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (String(property) === String(duringSample)) publishOnce();
        return value;
      },
    });
  };
  const atomics = {
    load(view, index) { if (view.buffer === buffer && index === 0) ++writeLoads; return Atomics.load(view, index); },
    store(view, index, value) {
      // Publication after output has been computed must remain queued.
      if (afterPlayback && view.buffer === buffer && index === 1) publishOnce();
      return Atomics.store(view, index, value);
    },
  };
  vm.runInNewContext(source, {
    AudioWorkletProcessor: class {}, Int16Array: SampleView, Uint32Array, Atomics: atomics,
    registerProcessor(name, type) { assert.equal(name, 'ps2-output'); Output = type; },
  });
  const processor = new Output({ processorOptions: { buffer, base: 0 } });
  const channels = [new Float32Array(128), new Float32Array(128)];
  const left = new Proxy(channels[0], {
    set(target, property, value) {
      target[property] = value;
      if (String(property) === String(duringOutput)) publishOnce();
      return true;
    },
    get(target, property) { return Reflect.get(target, property, target); },
  });
  return {
    ring, channels, process() { return processor.process([], [[left, channels[1]]]); },
    get writeLoads() { return writeLoads; },
  };
}
function exact(channels, start, from = 0, count = 128 - from) {
  for (let i = 0; i < count; ++i) for (let channel = 0; channel < 2; ++channel)
    assert.equal(channels[channel][from + i], sample((start + i) >>> 0, channel) / 32768,
      `Native sample ${i}, channel ${channel} must play once, in order`);
}
for (const read of [0, 0xffffffc0]) {
  // The producer publishes while the last initially available stereo sample
  // is being consumed. The first write snapshot is now stale.
  const last = (((read + 63) >>> 0) & 4095) * 2 + 1;
  const f = fixture({ read, queued: 64, duringSample: last });
  assert.equal(f.process(), true);
  assert.equal(f.ring[1], (read + 128) >>> 0, 'Concurrent samples must be consumed in this callback');
  exact(f.channels, read);
  assert.equal((f.ring[0] - f.ring[1]) >>> 0, 64, 'Unplayed samples must remain queued');
}
{
  // SPU2 publishes 32-frame batches: cover the observed 96/128 boundary.
  const f = fixture({ queued: 96, duringSample: 191, refillFrames: 32 });
  f.process(); exact(f.channels, 0);
  assert.equal(f.ring[1], 128); assert.equal(f.ring[0], 128);
}
{
  const f = fixture({ duringOutput: 3 });
  f.process();
  assert(f.channels.every(channel => channel.subarray(0, 4).every(value => value === 0)));
  exact(f.channels, 0, 4, 124);
  assert.equal(f.ring[1], 124, 'A publication after initial starvation must be played when available');
  assert.equal(f.ring[0], 128);
}
{
  const f = fixture({ queued: 256 });
  f.process(); exact(f.channels, 0); assert.equal(f.ring[1], 128);
  assert.equal(f.writeLoads, 1, 'The normally buffered path needs only one write-counter load');
}
for (const queued of [0, 1, 32, 64, 127]) {
  const f = fixture({ queued }); f.process();
  assert.equal(f.ring[1], queued, 'True starvation cannot invent or advance native samples');
  if (queued) {
    exact(f.channels, 0, 0, queued);
    for (let channel = 0; channel < 2; ++channel)
      assert(Math.abs(f.channels[channel][queued]) < Math.abs(f.channels[channel][queued - 1]));
  } else assert(f.channels.every(channel => channel.every(value => value === 0)));
}
{
  const f = fixture({ afterPlayback: true }); f.process();
  assert.equal(f.ring[1], 0, 'Publication after output cannot hide a real shortage');
  assert.equal(f.ring[0], 128); f.process(); exact(f.channels, 0); assert.equal(f.ring[1], 128);
}
console.log('Audio refill: concurrent publication, stereo order, rollover, true starvation and buffered fast path passed');
