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
  console.log(`Display capacity: ${cases.length} selection gates, ${reserveGates} reserve gates and 9 wait/recovery scenarios passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
