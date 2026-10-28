// A delayed presentation must fail QA even when RAF timestamps look regular.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, 'browser_frame_metrics.js'), 'utf8')
  .replace('SSX3_DISABLE_JSPI', 'false');

function fixture(kind) {
  let now = 0, observe;
  let domCreates = 0, resizeObservers = 0;
  const callbacks = [];
  class CanvasRenderingContext2D {
    constructor(id) { this.canvas = { id }; }
    drawImage() { if (this.fail) throw new Error('draw failed'); return 7; }
  }
  class GPUCanvasContext {
    constructor(id) { this.canvas = { id }; }
    getCurrentTexture() { return {}; }
  }
  class GPUQueue { submit() { if (this.fail) throw new Error('submit failed'); return 9; } }
  class GPUBuffer { mapAsync() {} }
  const context = vm.createContext({ performance: { now: () => now }, CanvasRenderingContext2D,
    GPUCanvasContext, GPUQueue, GPUBuffer,
    Module: { blitFrames: kind === 'copy' ? [] : undefined,
      surfaceFrames: kind === 'surface' ? [] : undefined,
      running: true, _ps2web_frames: () => 100, audioQueuedMs: () => 80 },
    document: { body: { append() {} }, createElement() { ++domCreates; return { style: {} }; } },
    ResizeObserver: class { constructor(callback) { ++resizeObservers; observe = callback; } observe() {} },
    requestAnimationFrame: callback => callbacks.push(callback),
  });
  context.window = context;
  vm.runInContext(source, context);
  const canvas = kind === 'copy' ? new CanvasRenderingContext2D('canvas') : new GPUCanvasContext('canvas');
  const queue = new GPUQueue();
  const f = {
    context, canvas, queue,
    at(time) { now = time; },
    submit() { if (kind === 'copy') return canvas.drawImage({}, 0, 0); canvas.getCurrentTexture(); return queue.submit([]); },
    refresh(stamp) {
      for (const callback of callbacks.splice(0)) callback(stamp);
      if (observe) observe();
    },
    begin() {
      context.qaPhase('test'); context.qaInstall(); context.qaActive(true);
      assert.equal(domCreates, 0, 'Measurement must not create a layout sentinel');
      assert.equal(resizeObservers, 0, 'Measurement must not request per-refresh resize entries');
    },
    presenter(images) {
      let index = 0;
      const present = () => {
        for (let n = 0; n < images[index]; ++n) f.submit();
        ++index;
        callbacks.push(present);
      };
      // Both buffered/copy presenters register their persistent callback before QA.
      callbacks.push(present);
    },
  };
  return f;
}

for (const kind of ['copy', 'surface']) {
  const f = fixture(kind), { qa, Module } = f.context;
  f.begin();
  for (const [stamp, actual] of [[1000, 1000], [1016.667, 1016.667], [1033.334, 1050]]) {
    f.at(actual); assert.equal(f.submit(), kind === 'copy' ? 7 : 9); f.refresh(stamp);
  }
  assert.equal(qa.total.longRafGaps, 0, 'Nominal timestamps reproduce the previous false pass');
  assert.equal(qa.wall.intervals, 2);
  assert.equal(qa.wall.longGaps, 1, kind + ': actual delayed presentation is counted');
  assert(Math.abs(qa.wall.maxGapMs - 33.333) < 0.001);
  assert.equal(qa.wall.events[0].phase, 'test');

  f.context.qaActive(false); f.at(5000); f.submit();
  f.context.qaActive(true); f.at(6000); f.submit(); f.at(6016); f.submit();
  assert.equal(qa.wall.intervals, 1);
  assert.equal(qa.wall.longGaps, 0, 'Setup/pause time must not enter a new measurement');
  for (const flag of ['paused', 'failed', 'running']) {
    Module[flag] = flag !== 'running'; f.at(7000); f.submit();
    Module[flag] = flag === 'running'; f.at(8000); f.submit();
    assert.equal(qa.wall.longGaps, 0, 'Inactive player output cannot bridge a timing interval');
  }

  f.context.qaActive(true); f.at(0); f.submit(); f.at(30); f.submit();
  assert.equal(qa.wall.intervals, 1, 'A zero-valued first timestamp is valid');
  for (let i = 2; i <= 300; ++i) { f.at(i * 30); f.submit(); }
  assert.equal(qa.wall.longGaps, 300);
  assert.equal(qa.wall.events.length, 200, 'Diagnostic storage stays bounded');

  const before = qa.id;
  if (kind === 'copy') {
    new f.context.CanvasRenderingContext2D('other').drawImage({}, 0, 0);
    f.canvas.fail = true; assert.throws(() => f.submit(), /draw failed/);
  } else {
    new f.context.GPUCanvasContext('other').getCurrentTexture(); f.queue.submit([]);
    f.queue.fail = true; assert.throws(() => f.submit(), /submit failed/);
    f.queue.fail = false; f.queue.submit([]);
  }
  assert.equal(qa.id, before, 'Unrelated or failed output cannot count as a successful presentation');
}

for (const kind of ['copy', 'surface']) {
  const f = fixture(kind);
  f.presenter([1, 1, 0, 2, 1]);
  f.begin();
  for (let i = 0; i < 5; ++i) {
    const stamp = 1000 + i * 1000 / 60;
    f.at(stamp + (i === 3 ? 13 : 0));
    f.refresh(stamp);
  }
  assert.equal(f.context.qa.total.intervals, 4);
  assert.equal(f.context.qa.total.withoutImage, 1, kind + ': a skipped refresh fails QA');
  assert.equal(f.context.qa.total.overwritten, 1, kind + ': two images in one refresh fail QA');
  assert(f.context.qa.wall.longGaps > 0, kind + ': nominal stamps cannot hide a late callback');
}

for (const kind of ['copy', 'surface']) {
  const f = fixture(kind), module = f.context.Module;
  module.presentCopy = kind === 'copy';
  const frames = module.presentCopy ? module.blitFrames : module.surfaceFrames;
  const free = module.presentCopy ? (module.blitFree = [{}]) : (module.surfaceFree = [{}]);
  frames.push({}, {}); f.presenter([1, 0, 0]); f.begin();
  f.at(1000); f.refresh(1000); f.at(1016.667); f.refresh(1016.667);
  assert.equal(f.context.qa.events[0].queuedImages, 2, 'A skipped image with queued frames must remain distinguishable');
  assert.equal(f.context.qa.events[0].freeSlots, 1);
  frames.length = 0; free.push({}, {}); f.at(1033.334); f.refresh(1033.334);
  assert.equal(f.context.qa.events[1].queuedImages, 0, 'An empty producer queue must be recorded directly');
  assert.equal(f.context.qa.events[1].freeSlots, 3);
}

{
  const f = fixture('copy');
  delete f.context.Module.blitFrames;
  assert.throws(() => f.context.qaInstall(), /Initialize the buffered or copy presenter/);
}
console.log('Frame metrics: copy/GPU delayed delivery, lifecycle boundaries, failed output and bounded diagnostics passed');
