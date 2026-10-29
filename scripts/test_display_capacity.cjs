const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../host/web.cpp'), 'utf8');
const start = source.indexOf('EM_ASYNC_JS(void, ps2web_wait_shown,');
const a = source.indexOf(', {', start) + 3, b = source.indexOf('\n});', a);
assert(start >= 0 && a > start && b > a);
const body = source.slice(a, b);
const safeStart = source.indexOf('EM_JS(int, ps2web_wait_capacity_safe,');
const safeA = source.indexOf(', {', safeStart) + 3, safeB = source.indexOf('\n});', safeA);
assert(safeStart >= 0 && safeA > safeStart && safeB > safeA);
const safeBody = source.slice(safeA, safeB);
function fixture() {
  const Module = { yieldForBufferedFrames: true, bufferedSurface: true, surfaceFrames: [{}, {}, {}],
    surfaceClock: { refreshInterval: () => 1000 / 60 }, audioQueuedMs: () => 44,
    surfacePresentedAt: 85.7, shownPending: false, shownWaiters: [] };
  const context = vm.createContext({ Module, performance: { now: () => 100 } });
  const wait = vm.runInContext('(async function(capacity_only){' + body + '})', context);
  const safe = vm.runInContext('(function(audio_ms){' + safeBody + '})', context);
  return { Module, wait, safe, wake() { const wake = Module.surfaceYield; Module.surfaceYield = undefined; assert.equal(typeof wake, 'function'); wake(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const cases = [
    [{}, true], [{ surfaceClock: { refreshInterval: () => 16.5 } }, true],
    [{ surfaceClock: { refreshInterval: () => 1000 / 60 + 0.25 } }, true],
    [{ surfaceClock: { refreshInterval: () => 1000 / 60 + 0.251 } }, false],
    [{ surfaceClock: { refreshInterval: () => 1000 / 120 } }, false],
    [{ surfaceClock: { refreshInterval: () => 20 } }, false],
    [{ surfaceClock: { refreshInterval: () => NaN } }, false],
    [{ yieldForBufferedFrames: false }, false], [{ bufferedSurface: false }, false],
    [{ paused: true }, false], [{ failed: true }, false], [{ stoppedForReload: true }, false],
    [{ surfaceFrames: [{}, {}] }, false], [{ surfaceFrames: [{}] }, false],
    [{ surfaceFrames: [] }, false], [{ surfaceFrames: undefined }, false],
    [{ surfaceFrames: [{}, {}, {}, {}] }, false],
    [{ shownPending: true }, true],
  ];
  let reserveGates = 0;
  {
    const f = fixture(); assert.equal(f.safe(36.667), 1); ++reserveGates;
    f.Module.surfacePresentedAt = 93.08; assert.equal(f.safe(38.667), 1); ++reserveGates;
    f.Module.surfacePresentedAt = 74.5; assert.equal(f.safe(33.333), 1); ++reserveGates;
    f.Module.surfacePresentedAt = 85.7; const budget = 40 - 14.3;
    assert.equal(f.safe(budget + 0.0001), 1); ++reserveGates;
    assert.equal(f.safe(budget - 0.0001), 0); ++reserveGates;
    assert.equal(f.safe(19), 0); ++reserveGates;
    f.Module.surfacePresentedAt = 100; assert.equal(f.safe(39.999), 0); ++reserveGates;
    assert.equal(f.safe(40), 1); ++reserveGates;
  }
  for (const value of [undefined, 50, 101]) { const f = fixture(); f.Module.surfacePresentedAt = value; assert.equal(f.safe(38), 0); ++reserveGates; }
  for (const [change, selected] of cases) {
    const f = fixture(); Object.assign(f.Module, change); assert.equal(f.safe(36.667), selected ? 1 : 0); ++reserveGates; const task = f.wait();
    assert.equal(typeof f.Module.surfaceYield === 'function', selected);
    if (selected) { assert.equal(f.Module.shownWaiters.length, 0); f.Module.surfaceFrames.pop(); f.wake(); }
    await task;
  }
  {
    const f = fixture(); let finished = false; const task = f.wait().then(() => { finished = true; });
    await flush(); assert(!finished, 'A consumed completion callback does not prove an image slot is free');
    f.Module.surfaceFrames.pop(); f.wake(); await task;
  }
  {
    const f = fixture(); let finished = false; const task = f.wait().then(() => { finished = true; });
    const stale = f.Module.surfaceYield; f.wake(); await flush(); assert(!finished);
    const current = f.Module.surfaceYield; stale(); await flush(); assert.equal(f.Module.surfaceYield, current, 'An old wake cannot release a newer wait');
    f.Module.surfaceFrames.pop(); f.wake(); await task;
  }
  for (const change of [{ audioQueuedMs: () => 39 }, { paused: true }, { failed: true }, { stoppedForReload: true }]) {
    const f = fixture(), task = f.wait(); Object.assign(f.Module, change); f.wake(); await task;
  }
  {
    const f = fixture(); f.Module.yieldForBufferedFrames = false; f.Module.shownPending = true;
    const task = f.wait(); assert.equal(f.Module.shownWaiters.length, 1); assert.equal(f.Module.surfaceYield, undefined);
    f.Module.shownWaiters.shift()(); await task;
    f.Module.surfaceFrames.pop(); f.Module.surfaceFrames.pop(); await f.wait(); assert.equal(f.Module.shownWaiters.length, 0);
  }
  {
    const f = fixture(); let finished = false; const task = f.wait(1).then(() => { finished = true; });
    f.Module.audioQueuedMs = () => 35; f.wake(); await flush(); assert(!finished, 'A reserved low-audio wait may continue until capacity arrives');
    f.Module.audioQueuedMs = () => 19; f.wake(); await task;
  }
  {
    const f = fixture(); f.Module.surfaceClock.refreshInterval = () => 1000 / 120; f.Module.shownPending = true;
    const task = f.wait(0); assert.equal(f.Module.surfaceYield, undefined); assert.equal(f.Module.shownWaiters.length, 1);
    f.Module.shownWaiters.shift()(); await task;
  }
  // New native rate control must not turn low audio into image replacement.
  for (const hz of [60, 90, 120, 144, 240]) {
    for (const yieldForBufferedFrames of [false, true]) {
      const f = fixture();
      Object.assign(f.Module, { _ps2web_audio_rate_stats() {}, yieldForBufferedFrames,
        surfaceClock: { refreshInterval: () => 1000 / hz }, audioQueuedMs: () => 0 });
      assert.equal(f.safe(0), 1);
      let finished = false; const task = f.wait(0).then(() => { finished = true; });
      f.wake(); await flush(); assert(!finished, 'Low reserve cannot discard a queued image');
      f.Module.surfaceFrames.pop(); f.wake(); await task;
    }
  }
  for (const flag of ['paused', 'failed', 'stoppedForReload']) {
    const f = fixture(); f.Module._ps2web_audio_rate_stats = () => 0;
    const task = f.wait(1); f.Module[flag] = true; f.wake(); await task;
    assert.equal(f.safe(0), 0);
  }
  for (const refresh of [20, 0, -1, NaN, Infinity]) {
    const f = fixture(); f.Module._ps2web_audio_rate_stats = () => 0;
    f.Module.surfaceClock.refreshInterval = () => refresh;
    assert.equal(f.safe(0), 0); await f.wait(0);
  }
  for (const count of [0, 1, 2, 3]) {
    const f = fixture(); f.Module.bufferedSurface = false; f.Module.prepareCopyFrames = true; f.Module.shownPending = true;
    // A retired surface queue must not govern a copy presenter's capacity.
    f.Module.blitFrames = Array.from({ length: count }, () => ({}));
    let finished = false; const task = f.wait(0).then(() => { finished = true; });
    await flush();
    assert.equal(finished, count < 2, 'Prepare available copy slots before waiting for a refresh');
    assert.equal(f.Module.shownWaiters.length, count < 2 ? 0 : 1);
    assert.equal(f.Module.surfaceYield, undefined, 'Copying must not enter the GPU-surface capacity wait');
    if (count >= 2) { f.Module.blitFrames.shift(); f.Module.shownWaiters.shift()(); }
    await task;
  }
  {
    const f = fixture(); f.Module.bufferedSurface = false; f.Module.shownPending = true;
    f.Module.surfaceFrames = undefined; f.Module.blitFrames = [{}];
    const task = f.wait(0);
    assert.equal(f.Module.shownWaiters.length, 1, 'Compatibility retains its prior refresh wait with a partial copy queue');
    f.Module.shownWaiters.shift()(); await task;
  }
  {
    const f = fixture(); f.Module.bufferedSurface = false; f.Module.prepareCopyFrames = true; f.Module.shownPending = true;
    const task = f.wait(0);
    assert.equal(f.Module.shownWaiters.length, 1, 'An uninitialized or direct presenter retains its refresh wait');
    f.Module.shownWaiters.shift()(); await task;
  }
  for (const hz of [60, 90, 120, 144, 240]) {
    const f = fixture();
    Object.assign(f.Module, { bufferedSurface: false, prepareCopyFrames: true, yieldForBufferedFrames: false,
      blitFrames: [{}, {}, {}], blitClock: { refreshInterval: () => 1000 / hz }, audioQueuedMs: () => 19 });
    assert.equal(f.safe(19), 1, 'An acknowledged copy can wait while the EE fills audio'); ++reserveGates;
    let finished = false; const task = f.wait(1).then(() => { finished = true; });
    await flush(); assert(!finished); assert.equal(f.Module.shownWaiters.length, 0);
    f.wake(); await flush(); assert(!finished, 'A wake without a free slot cannot discard a prepared image');
    f.Module.blitFrames.pop(); f.wake(); await task;
    assert.equal(f.Module.surfaceFrames.length, 3, 'A stale surface queue must not govern copy capacity');
  }
  for (const refresh of [20, 1000 / 30, 0, -1, NaN]) {
    const f = fixture();
    Object.assign(f.Module, { bufferedSurface: false, prepareCopyFrames: true, blitFrames: [{}, {}, {}],
      blitClock: { refreshInterval: () => refresh }, shownPending: true });
    assert.equal(f.safe(38), 0, 'Retain the existing fallback when display cadence cannot sustain 60'); ++reserveGates;
    const task = f.wait(0); assert.equal(f.Module.surfaceYield, undefined);
    assert.equal(f.Module.shownWaiters.length, 1); f.Module.shownWaiters.shift()(); await task;
  }
  for (const flag of ['paused', 'failed', 'stoppedForReload']) {
    const f = fixture();
    Object.assign(f.Module, { bufferedSurface: false, prepareCopyFrames: true, blitFrames: [{}, {}, {}],
      blitClock: { refreshInterval: () => 1000 / 60 } });
    const task = f.wait(1); f.Module[flag] = true; f.wake(); await task;
    assert.equal(f.safe(38), 0); ++reserveGates;
  }
  {
    const start = source.indexOf('EM_JS(void, ps2web_blit,');
    const first = source.indexOf(', {', start) + 3, last = source.indexOf('\n});', first);
    assert(start >= 0 && first > start && last > first);
    const refreshes = [], microtasks = [];
    let draws = 0;
    const drawing = { fillRect() {}, putImageData() {}, drawImage() { ++draws; } };
    const Module = { canvas: { width: 1, height: 1, getContext: () => drawing } };
    const clock = { due: () => true, presented() {}, reset() {}, refreshInterval: () => 1000 / 60 };
    const context = vm.createContext({ Module, ps2webFrameClock: () => clock,
      requestAnimationFrame: callback => refreshes.push(callback), queueMicrotask: callback => microtasks.push(callback),
      HEAPU8: Uint8Array.from([1, 2, 3, 255]),
      ImageData: class { constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); } },
      OffscreenCanvas: class { constructor(width, height) { this.width = width; this.height = height; } getContext() { return drawing; } },
    });
    const blit = vm.runInContext('(function(rgba,width,height,wide){' + source.slice(first, last) + '})', context);
    const tick = (expectedDraws, expectedFree) => {
      let resumed = false;
      Module.surfaceYield = () => { resumed = true; assert.equal(Module.blitFree.length, expectedFree); };
      const before = draws; refreshes.shift()(100);
      assert.equal(draws - before, expectedDraws);
      assert.equal(Module.surfaceYield, undefined, 'Retire the wake before native work resumes');
      assert.equal(resumed, false, 'Native work must not reenter the presenter before bookkeeping finishes');
      assert.equal(refreshes.length, 1); assert.equal(microtasks.length, 1);
      microtasks.shift()(); assert(resumed);
    };
    blit(0, 1, 1, 0); assert.equal(Module.blitClock, clock); tick(0, 2);
    blit(0, 1, 1, 0); tick(1, 2);
    blit(0, 1, 1, 0); blit(0, 1, 1, 0);
    for (const flag of ['paused', 'failed', 'stoppedForReload']) {
      Module[flag] = true; tick(0, 0); Module[flag] = false;
    }
  }
  for (const flag of ['paused', 'failed', 'stoppedForReload']) {
    const f = fixture();
    Object.assign(f.Module, { [flag]: true, shownPending: true });
    await f.wait(0); assert.equal(f.Module.shownWaiters.length, 0);
    assert.equal(f.Module.surfaceYield, undefined, 'Inactive players cannot create a new display wait');
  }
  {
    const start = source.indexOf('EM_JS(void, ps2web_release_presenter,');
    const first = source.indexOf(', {', start) + 3, last = source.indexOf('\n});', first);
    assert(start >= 0 && first > start && last > first);
    const jobs = []; let capacityWakes = 0, refreshWakes = 0;
    const Module = { surfaceYield: () => { ++capacityWakes; },
      shownWaiters: [() => { ++refreshWakes; }], shownPending: true };
    const context = vm.createContext({ Module, queueMicrotask: job => jobs.push(job) });
    const release = vm.runInContext('(function(){' + source.slice(first, last) + '})', context);
    release(); assert.equal(Module.surfaceYield, undefined); assert.equal(Module.shownWaiters.length, 0);
    assert.equal(Module.shownPending, true, 'Pause must not let a stale RAF retire a future refresh');
    assert.equal(capacityWakes + refreshWakes, 0, 'Pause cannot reenter suspended native work synchronously');
    release(); assert.equal(jobs.length, 2, 'Each old waiter is released only once');
    for (const job of jobs) job(); assert.equal(capacityWakes, 1); assert.equal(refreshWakes, 1);
  }
  console.log(`Display capacity: ${cases.length} selection gates, ${reserveGates} reserve gates and legacy plus rate-controlled wait/recovery scenarios passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
