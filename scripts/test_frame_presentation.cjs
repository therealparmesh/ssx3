// Exercise both real EM_JS presenters and their shared clock. Simulated display
// refreshes must deliver ordered images, even when audio catch-up produces pairs.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');

function makePresenter(kind) {
  const gpu = kind === 'surface';
  const source = fs.readFileSync(path.join(root, gpu ? 'runtime/src/gs/gpu/gpu.cpp' : 'host/web.cpp'), 'utf8');
  const marker = gpu ? 'EM_JS(void, ps2_webgpu_queue_frame,' : 'EM_JS(void, ps2web_blit,';
  const declaration = source.indexOf(marker);
  assert(declaration >= 0);
  const start = source.indexOf(', {', declaration) + 3;
  assert(start > declaration);
  const body = source.slice(start, source.indexOf('\n});', start));
  const presented = [], callbacks = [], canvases = [];
  let now = -1, wallNow = -1, notified = 0, uniforms = 0, params;
  const record = (value, width, height) => presented.push({ value, width, height, time: now });
  class ImageData {
    constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
  }
  class OffscreenCanvas {
    constructor(width, height) {
      this.width = width; this.height = height; this.pixel = 0;
      this.context = { putImageData: image => { this.pixel = image.data[0]; }, drawImage: source => { this.pixel = source.pixel; } };
      canvases.push(this);
    }
    getContext() { return this.context; }
  }
  const copy = { fillRect() {}, drawImage(source) { record(source.pixel, source.width, source.height); } };
  const surface = { getCurrentTexture: () => ({ createView: () => ({}) }) };
  const pass = { setPipeline() {}, setBindGroup() {}, setViewport() {}, draw() {}, end() {} };
  const device = {
    createBuffer: () => (++uniforms, {}), createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
  };
  const queue = { writeBuffer: (buffer, offset, data) => { params = [...data]; }, submit: () => record(params[2], params[0], params[1]) };
  const objects = [device, queue, { getBindGroupLayout: () => ({}) }, {}];
  const Module = { canvas: { width: 8, height: 6, getContext: name => name === 'webgpu' ? surface : copy },
    paused: false, failed: false, onPresent: () => ++notified };
  const heap = new Uint8Array(64), library = {};
  const context = vm.createContext({ Module, performance: { now: () => wallNow }, HEAPU8: heap, ImageData, OffscreenCanvas,
    WebGPU: { getJsObject: pointer => objects[pointer] }, GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2 },
    addToLibrary: entries => Object.assign(library, entries), requestAnimationFrame: callback => callbacks.push(callback) });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/frame-presentation.js'), 'utf8'), context);
  context.ps2webFrameClock = library.$ps2webFrameClock;
  const args = gpu ? 'device_ptr,queue_ptr,pipeline_ptr,pixels_ptr,width,height,current,previous,blend,wide' : 'rgba,width,height,wide';
  const send = vm.runInContext('(function(' + args + '){' + body + '})', context);
  const ready = () => gpu ? Module.surfaceFrames : Module.blitFrames;
  const free = () => gpu ? Module.surfaceFree : Module.blitFree;
  return {
    Module, presented,
    produce(value, width = 4, height = 3, wide = 0) {
      if (gpu) send(0, 1, 2, 3, width, height, value, value - 1, 0, wide);
      else { heap.fill(value); send(0, width, height, wide); heap.fill(255); }
    },
    refresh(time, actualTime = time) {
      assert(time > now, 'Refresh timestamps must increase'); now = time; wallNow = actualTime;
      for (const callback of callbacks.splice(0)) callback(now);
      assert.equal(callbacks.length, 1, 'Exactly one presentation callback is scheduled');
      assert.equal(notified, presented.length, 'Only real image submissions notify onPresent');
      assert.equal(ready().length + free().length, 3, 'The presentation pool never grows');
      if (gpu) assert.equal(uniforms, 3, 'GPU uniform buffers are allocated only once');
    },
    sourceCanvases: () => canvases.length,
  };
}

for (const kind of ['copy', 'surface']) {
  const p = makePresenter(kind), step = 1000 / 60;
  let tick = 0;
  const refresh = () => p.refresh(tick++ * step);
  p.produce(1); refresh(); assert.equal(p.presented.length, 0, 'Prime before consuming the only completed frame');
  p.produce(2); refresh();
  let next = 3;
  for (let i = 0; i < 100; ++i) {
    if (i % 2) { p.produce(next++); p.produce(next++); }
    refresh();
  }
  assert.deepEqual(p.presented.map(f => f.value), Array.from({ length: 101 }, (_, i) => i + 1), kind + ': FIFO with zero/two-frame production at 60 Hz');
  assert(p.sourceCanvases() <= 4, 'At most three source canvases and one scaling canvas are needed');
  p.Module.paused = true;
  let pausedWake = 0;
  if (kind === 'surface') p.Module.surfaceYield = () => ++pausedWake;
  for (const value of [150, 151, 152, 153]) p.produce(value);
  const count = p.presented.length;
  refresh(); refresh(); assert.equal(p.presented.length, count, 'Pause freezes the displayed image');
  if (kind === 'surface') assert.equal(pausedWake, 1, 'Pause releases a pending capacity wake without submitting an image');
  p.Module.paused = false;
  refresh(); refresh(); refresh();
  assert.deepEqual(p.presented.slice(-3).map(f => f.value), [151, 152, 153], 'Overflow keeps the newest three images');
  refresh(); assert.equal(p.presented.length, count + 3, 'An empty queue must not report a duplicate');
  p.produce(160, 2, 2, 1); refresh(); assert.equal(p.presented.at(-1).value, 160, 'Size and aspect changes retain the new frame');
  p.Module.failed = true; p.produce(170); refresh(); assert.equal(p.presented.at(-1).value, 160, 'Failure stops presentation');

  // The old presenter drains a pair on adjacent 120 Hz refreshes, resulting in
  // alternating 8.3/25 ms image gaps despite its apparently correct 60 fps average.
  const paired = makePresenter(kind);
  let released = 0;
  if (kind === 'surface') paired.Module.surfaceYield = () => {
    assert.equal(paired.presented.length, 1, 'Submit the prepared image before waking native preparation');
    assert.equal(paired.Module.surfaceYield, undefined, 'Retire the wake before resuming its producer');
    ++released;
  };
  let value = 1;
  for (let i = 0; i < 1200; ++i) {
    if (i % 4 === 0) { paired.produce(value++ % 251); paired.produce(value++ % 251); }
    paired.refresh(i * 1000 / 120);
  }
  assert.equal(paired.presented.length, 600, kind + ': paired producer sustains 60 fps on a 120 Hz display');
  if (kind === 'surface') assert.equal(released, 1, 'The presenter releases a capacity suspension exactly once');
  assert.deepEqual(paired.presented.map(f => f.value), Array.from({ length: 600 }, (_, i) => (i + 1) % 251));
  for (let i = 1; i < paired.presented.length; ++i)
    assert(Math.abs(paired.presented[i].time - paired.presented[i - 1].time - step) < 1e-6, kind + ': no 8.3/25 ms catch-up judder');

  for (const hz of [64, 72, 75, 90, 120, 144, 165, 240]) {
    const paced = makePresenter(kind), expected = [];
    let produced = 0;
    const produce = () => { const value = ++produced % 251; expected.push(value); paced.produce(value); };
    produce(); produce();
    if (kind === 'surface') assert.equal(paced.Module.surfaceClock.refreshInterval(), step, 'Before calibration the audio reserve assumes a 60 Hz refresh');
    for (let i = 0; i <= hz * 5; ++i) {
      while (produced < 2 + Math.floor(i * 60 / hz + 1e-8)) produce();
      paced.refresh(i * 1000 / hz);
    }
    assert.equal(paced.presented.length, 301, kind + ': retain 60 fps rather than rounding deadlines at ' + hz + ' Hz');
    if (kind === 'surface') assert(Math.abs(paced.Module.surfaceClock.refreshInterval() - 1000 / hz) < 1e-6, 'The audio reserve uses the measured display period at ' + hz + ' Hz');
    assert.deepEqual(paced.presented.map(f => f.value), expected.slice(0, 301));
    for (let i = 1; i < paced.presented.length; ++i) {
      const ticks = (paced.presented[i].time - paced.presented[i - 1].time) * hz / 1000;
      assert(ticks >= Math.floor(hz / 60) - 1e-6 && ticks <= Math.ceil(hz / 60) + 1e-6, 'Use adjacent available display intervals');
    }
  }

  // Real display clocks are rarely exact nominal multiples. Avoid periodic
  // third-refresh gaps at 120.005 Hz and follow 119.88 Hz without phase skips.
  for (const hz of [119.88, 120.0048, 239.76, 240.0096]) {
    const paced = makePresenter(kind), multiple = Math.round(hz / 60);
    let produced = 0;
    for (let i = 0; i < hz * 180; ++i) {
      while (produced < 2 + Math.floor(i * 60 / hz + 1e-8)) paced.produce(++produced % 251);
      paced.refresh(i * 1000 / hz);
      assert.equal(paced.presented.length, Math.floor(i / multiple) + 1, kind + ': follow nominal display multiple without clock-drift skips at ' + hz + ' Hz');
    }
  }

  // Uneven timestamp precision must not turn a steady display into a
  // different refresh rate. Warm up the estimate, then check actual delivery.
  for (const hz of [60, 120]) {
    const noisy = makePresenter(kind), multiple = hz / 60;
    let produced = 0;
    for (let i = 0; i < hz * 10; ++i) {
      while (produced < 2 + Math.floor(i / multiple)) noisy.produce(++produced % 251);
      const timestamp = i * 1000 / hz + [0, -0.25, -0.5][i % 3];
      noisy.refresh(timestamp);
      if (i > 100) {
        const previous = noisy.presented.at(-2), last = noisy.presented.at(-1);
        const gap = last.time - previous.time;
        assert(gap >= 1000 / 60 - 0.51 && gap <= 1000 / 60 + 0.51, kind + ': timestamp noise must not skip a display interval');
      }
    }
  }

  for (const hz of [50, 59.94, 60, 60.0024]) {
    const paced = makePresenter(kind);
    let produced = 0;
    for (let i = 0; i < hz * 180; ++i) {
      while (produced < 2 + Math.floor(i * 60 / hz + 1e-8)) paced.produce(++produced % 251);
      paced.refresh(i * 1000 / hz);
      assert.equal(paced.presented.length, i + 1, kind + ': follow near-60/slow refresh directly without phase-drift skips at ' + hz + ' Hz');
    }
  }

  // Firefox timestamp error can drift across several refreshes, so a short
  // average temporarily resembles 117/123 Hz despite a steady 120 Hz stream.
  // There are no missing callbacks: every pair must still deliver one image.
  const drifting = makePresenter(kind);
  let produced = 0, lastDelivery = -2;
  for (let i = 0; i < 2400; ++i) {
    if (i % 4 === 0) { drifting.produce(++produced % 251); drifting.produce(++produced % 251); }
    let jitter = 0;
    if (i >= 240) {
      const phase = (i - 240) % 64;
      jitter = phase < 16 ? phase * 0.2 : phase < 48 ? 3.2 - (phase - 16) * 0.2 : -3.2 + (phase - 48) * 0.2;
    }
    const count = drifting.presented.length;
    drifting.refresh(i * 1000 / 120 + jitter);
    if (drifting.presented.length !== count) {
      assert.equal(i - lastDelivery, 2, kind + ': gradual timestamp drift must not produce one/three-refresh judder');
      lastDelivery = i;
    }
  }
  assert.equal(drifting.presented.length, 1200);
  assert.deepEqual(drifting.presented.map(f => f.value), Array.from({ length: 1200 }, (_, i) => (i + 1) % 251));

  const changing = makePresenter(kind);
  let time = 0, generated = 0;
  for (const hz of [60, 120, 90, 144, 240, 60]) {
    const start = time;
    for (let i = 0; i < hz * 3; ++i) {
      const now = start + i * 1000 / hz;
      while (generated < 2 + Math.floor(now * 60 / 1000 + 1e-8)) changing.produce(++generated % 251);
      changing.refresh(now);
    }
    time += 3000;
    const settled = changing.presented.filter(frame => frame.time >= start + 1000 && frame.time < time);
    assert(settled.length >= 118 && settled.length <= 122, kind + ': retain 60 fps after changing to ' + hz + ' Hz');
    for (let i = 1; i < settled.length; ++i)
      assert(settled[i].time - settled[i - 1].time <= Math.ceil(hz / 60) * 1000 / hz + 0.51, 'Display-rate changes must not leave the clock in the previous pacing mode');
  }

  // Recover from a long pause/stall at high refresh without draining stale
  // deadlines as a rapid burst. The queue must remain bounded throughout.
  for (const pause of [false, true]) {
    const resumed = makePresenter(kind);
    resumed.produce(1); resumed.produce(2); resumed.refresh(0);
    if (pause) { resumed.Module.paused = true; resumed.refresh(1000 / 120); }
    for (const value of [3, 4, 5, 6]) resumed.produce(value);
    resumed.Module.paused = false;
    for (let i = 0; i < 6; ++i) resumed.refresh(1000 + i * 1000 / 120);
    assert.deepEqual(resumed.presented.map(f => f.value), [1, 4, 5, 6]);
    assert.deepEqual(resumed.presented.slice(1).map(f => Math.round(f.time * 1000)), [1000000, 1016667, 1033333]);
  }
}
{
  const p = makePresenter('surface');
  p.produce(1); p.produce(2); p.refresh(10, 15.4);
  assert.equal(p.Module.surfacePresentedAt, 15.4, 'Capacity prediction uses actual submission time when RAF timestamps lag');
  p.Module.paused = true; p.refresh(26.7, 35);
  assert.equal(p.Module.surfacePresentedAt, 15.4, 'A paused refresh does not claim a new submission');
  p.Module.paused = false; p.refresh(43.4, 49);
  assert.equal(p.Module.surfacePresentedAt, 49, 'Resuming records the next actual submission');
}
console.log('Both presenters: FIFO pixels/fields, 50–240 Hz pacing, paired production, timestamp drift and display changes, bounded pool, pause/stall recovery, resize and failure passed');
