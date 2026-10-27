const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const shell = fs.readFileSync(process.env.SSX3_TEST_PROBE_SHELL || path.join(__dirname, '../web/shell.html'), 'utf8');
const policyStart = shell.indexOf('function preferFrameCopy()');
const policyEnd = shell.indexOf('\nvar Module', policyStart);
assert(policyStart >= 0 && policyEnd > policyStart);
const policy = shell.slice(policyStart, policyEnd);
for (const [mode, userAgent, query, expected] of [
  ['jspi', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0 Safari/537.36', '', true],
  ['jspi', 'Mozilla/5.0 (X11; Linux x86_64) Chromium/156.0', '', true],
  ['jspi', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0 Edg/156.0', '', true],
  ['asyncify', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0', '', false],
  ['jspi', 'Mozilla/5.0 (Windows NT 10.0) Chrome/156.0', '', false],
  ['jspi', 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/156.0', '', false],
  ['jspi', 'Mozilla/5.0 (Linux; Android 16) Chrome/156.0 Mobile Safari/537.36', '', false],
  ['jspi', 'Mozilla/5.0 (Linux) Chrome/156.0 Mobile', '', false],
  ['jspi', 'Mozilla/5.0 (X11; CrOS x86_64) Chrome/156.0', '', false],
  ['jspi', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/158.0', '', false],
  ['asyncify', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/158.0', '', false],
  ['asyncify', 'Mozilla/5.0 (iPhone) Version/26.0 Mobile Safari/604.1', '', false],
  ['jspi', 'Mozilla/5.0 (Windows NT 10.0) Chrome/156.0', 'copy', true],
  ['asyncify', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/158.0', 'copy', true],
]) {
  assert.equal(vm.runInNewContext(policy.replaceAll('@PS2_WEB_ASYNC@', mode) + '\npreferFrameCopy()', {
    navigator: { userAgent }, params: new URLSearchParams(query),
  }), expected, 'Select the qualified presentation path while preserving the explicit copy request');
}
console.log('Presentation selection: 14 browser/build/explicit-request cases passed');
const copyPreparation = shell.match(/prepareCopyFrames:\s*([^,\n]+)/)?.[1];
assert(copyPreparation, 'The browser build must declare its copy preparation policy');
for (const mode of ['jspi', 'asyncify']) {
  assert.equal(vm.runInNewContext(copyPreparation.replaceAll('@PS2_WEB_ASYNC@', mode)), mode === 'jspi',
    'Only the qualified primary build enables prepared copy frames');
}
const first = shell.indexOf('async function canPresent(');
const last = shell.indexOf('\nfunction webgpuHelp', first);
assert(first >= 0 && last > first);
const source = shell.slice(first, last);

async function probe(mode) {
  let time = 0, id = 0, retiredCanvas, releaseDevice, releaseBitmap;
  const timers = new Map(), refreshes = new Map();
  const state = { devices: [], bitmaps: [], snapshots: 0, warnings: [], canvases: [] };
  const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const flush = async () => { for (let n = 0; n < 16; ++n) await Promise.resolve(); };
  const queue = {
    submit() { retiredCanvas.alive = true; },
    onSubmittedWorkDone() {
      if (mode === 'work-timeout') return new Promise(() => {});
      // Model automatic expiry before completion is delivered to script.
      return Promise.resolve().then(() => { retiredCanvas.alive = false; });
    },
  };
  const device = {
    queue, lost: new Promise(() => {}), destroy() { ++state.devices[0].destroyed; },
    createCommandEncoder: () => ({ beginRenderPass: () => ({ end() {} }), finish: () => ({}) }),
  };
  const canvas = () => ({
    alive: false, removed: 0, style: {},
    remove() { ++this.removed; },
    getContext(type) {
      if (type === 'webgpu') {
        retiredCanvas = this;
        return { configure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
      }
      let red = false;
      return {
        drawImage(image) { red = image.red === undefined ? image.alive : image.red; },
        getImageData: () => ({ data: red ? [255, 64, 0, 255] : [0, 0, 0, 0] }),
      };
    },
  });
  const context = vm.createContext({
    console: { warn: message => state.warnings.push(message) },
    navigator: { gpu: {
      requestAdapter: async () => ({ info: { vendor: 'test', architecture: 'adapter' }, requestDevice() {
        state.devices.push({ destroyed: 0 });
        if (mode === 'device-rejected') return Promise.reject(new Error('device unavailable'));
        if (mode === 'late-device') { const pending = defer(); releaseDevice = () => pending.resolve(device); return pending.promise; }
        return Promise.resolve(device);
      } }),
      getPreferredCanvasFormat: () => 'rgba8unorm',
    } },
    document: { body: { appendChild(c) { state.canvases.push(c); } }, createElement: canvas },
    createImageBitmap(c) {
      ++state.snapshots;
      if (mode === 'snapshot-rejected') return Promise.reject(new Error('snapshot unavailable'));
      if (mode === 'late-rejection') { const pending = defer(); releaseBitmap = () => pending.reject(new Error('late snapshot')); return pending.promise; }
      const image = { red: mode !== 'blank' && c.alive, closed: 0, close() { ++this.closed; } };
      state.bitmaps.push(image);
      if (mode === 'late-snapshot') { const pending = defer(); releaseBitmap = () => pending.resolve(image); return pending.promise; }
      return Promise.resolve(image);
    },
    requestAnimationFrame(callback) { refreshes.set(++id, callback); return id; },
    cancelAnimationFrame(key) { refreshes.delete(key); },
    setTimeout(callback, delay) { timers.set(++id, { callback, due: time + delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
  });
  vm.runInContext(source, context);
  let done = false, result;
  const running = context.canPresent('high-performance').then(value => { result = value; done = true; });
  for (let step = 0; !done && step < 700; ++step) {
    await flush();
    time += 16;
    if (mode !== 'held-refresh') {
      const current = [...refreshes.values()]; refreshes.clear();
      for (const callback of current) callback(time);
    }
    for (const [key, timer] of [...timers]) if (timer.due <= time) { timers.delete(key); timer.callback(); }
  }
  await running;
  if (mode === 'late-device') releaseDevice();
  if (mode === 'late-snapshot' || mode === 'late-rejection') releaseBitmap();
  await flush();
  const success = mode === 'expiry' || mode === 'held-refresh';
  assert.equal(result, success ? 'test adapter' : null, mode);
  if (mode !== 'device-rejected') assert.equal(state.devices[0].destroyed, 1, mode + ' device cleanup');
  assert(state.canvases.every(c => c.removed === 1), mode + ' canvas cleanup');
  assert(state.bitmaps.every(image => image.closed === 1), mode + ' bitmap cleanup');
  assert.equal(timers.size, 0, mode + ' timer cleanup');
  assert.equal(refreshes.size, 0, mode + ' refresh cleanup');
  if (success) assert.equal(state.snapshots, 3, mode + ' three independent frames');
}

(async () => {
  for (const mode of ['expiry', 'held-refresh', 'blank', 'device-rejected', 'snapshot-rejected', 'work-timeout', 'late-device', 'late-snapshot', 'late-rejection']) await probe(mode);
  console.log('GPU probe: canvas expiry, asynchronous snapshots, blank fallback, rejection, deadline, late completion and resource cleanup passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
