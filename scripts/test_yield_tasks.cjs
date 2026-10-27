// Exercise the actual native-to-browser yield across task/refresh races.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../runtime/src/system.cpp'), 'utf8');
const declaration = source.indexOf('EM_JS(void, ps2_browser_yield,');
assert(declaration >= 0);
const start = source.indexOf(', {', declaration) + 3;
const body = source.slice(start, source.indexOf('\n});', start));
const flush = () => new Promise(resolve => setImmediate(resolve));
const shell = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
const selector = /yieldForBufferedFrames:\s*(.+),/.exec(shell)[1];
for (const [mode, userAgent, expected] of [
  ['asyncify', 'Mozilla/5.0 Chrome/156.0.8078.47 Safari/537.36', true],
  ['asyncify', 'Mozilla/5.0 Chromium/156.0.8078.47', true],
  ['jspi', 'Mozilla/5.0 Chrome/156.0.8078.47 Safari/537.36', false],
  ['asyncify', 'Mozilla/5.0 Gecko/20100101 Firefox/158.0', true],
  ['jspi', 'Mozilla/5.0 Gecko/20100101 Firefox/158.0', false],
  ['asyncify', 'Mozilla/5.0 Version/26.0 Mobile Safari/604.1', false],
  ['asyncify', 'Mozilla/5.0 CriOS/156.0 Mobile Safari/604.1', false],
]) assert.equal(vm.runInNewContext('(' + selector.replaceAll('@PS2_WEB_ASYNC@', mode) + ')', {navigator:{userAgent}}), expected,
  'Enable the optional wait on Chromium and staged-upload Firefox compatibility paths');

function setup(mode) {
  const Module = {}, refreshes = new Map(), timers = new Map(), messages = [], tasks = [];
  let sequence = 0, completed = 0, channels = 0, immediate = 0, suspended = 0, wakes = 0, now = 100;
  const scheduler = mode === 'missing' ? undefined : {
    yield() {
      if (mode === 'throw') throw new Error('Task scheduling unavailable');
      return new Promise((resolve, reject) => tasks.push({resolve, reject}));
    },
  };
  const context = vm.createContext({
    Module, scheduler, performance: { now: () => now },
    queueMicrotask,
    Asyncify: {
      handleSleep(start) {
        let synchronous = true, woke = false;
        const result = new Promise(resolve => start(() => {
          assert.equal(woke, false, 'The native continuation must wake exactly once');
          woke = true;
          ++wakes;
          if (synchronous) ++immediate;
          resolve();
        }));
        synchronous = false;
        if (!woke) ++suspended;
        return result;
      },
    },
    MessageChannel: class {
      constructor() {
        ++channels;
        this.port1 = {};
        this.port2 = {postMessage: () => messages.push(() => this.port1.onmessage())};
      }
    },
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++sequence; refreshes.set(id, callback); return id; },
    cancelAnimationFrame(id) { refreshes.delete(id); },
  });
  const yieldWork = vm.runInContext('(function(){' + body + '})', context);
  return {
    Module, refreshes, timers, messages, tasks,
    yield: () => yieldWork().then(() => ++completed),
    completed: () => completed, channels: () => channels,
    immediate: () => immediate, suspended: () => suspended, wakes: () => wakes,
    advance: delta => { now += delta; },
    retry() { const ready = [...timers.values()]; timers.clear(); for (const callback of ready) callback(); },
    surfaceRefresh() { const wake = Module.surfaceYield; Module.surfaceYield = undefined; if (wake) wake(); },
    refresh() {
      const ready = [...refreshes.values()]; refreshes.clear();
      for (const callback of ready) callback(now);
    },
    deliver() { assert(messages.length); messages.shift()(); },
  };
}

(async () => {
  const task = setup('native');
  const first = task.yield();
  assert.equal(task.tasks.length, 1);
  assert.equal(task.channels(), 0, 'Supported native scheduling needs no fallback channel');
  const staleRefresh = [...task.refreshes.values()][0];
  task.tasks.shift().resolve(); await first;
  assert.equal(task.refreshes.size, 0);
  staleRefresh(); await flush();
  assert.equal(task.completed(), 1, 'Late refresh must not resume native work twice');

  const race = setup('native');
  const old = race.yield();
  const oldTask = race.tasks.shift();
  race.refresh(); await old;
  race.advance(3);
  const next = race.yield();
  oldTask.resolve(); await flush();
  assert.equal(race.completed(), 1, 'Late scheduler completion cannot consume a new yield');
  race.tasks.shift().resolve(); await next;
  assert.equal(race.completed(), 2);
  assert.equal(race.refreshes.size, 0);

  for (const mode of ['missing', 'throw']) {
    const fallback = setup(mode);
    const pending = fallback.yield();
    assert.equal(fallback.messages.length, 1);
    assert.equal(fallback.timers.size, 0, 'Ordinary posted work needs no recovery timer');
    fallback.deliver();
    assert.equal(fallback.wakes(), 0, 'A posted callback must finish retiring its FIFO before native work resumes');
    await pending;
    assert.equal(fallback.Module.yieldWaiters.length, 0);
    assert.equal(fallback.refreshes.size, 0);

    const earlier = fallback.yield();
    fallback.refresh(); await earlier;
    fallback.advance(3);
    const later = fallback.yield();
    fallback.deliver(); await flush();
    assert.equal(fallback.completed(), 2, 'A late posted fallback must retain FIFO ownership');
    fallback.deliver(); await later;
    assert.equal(fallback.completed(), 3);
    assert.equal(fallback.Module.yieldWaiters.length, 0);
  }

  const rejected = setup('native');
  const pending = rejected.yield();
  rejected.tasks.shift().reject(new Error('Inherited task aborted')); await flush();
  assert.equal(rejected.messages.length, 1, 'Rejected native scheduling must fall back');
  rejected.deliver(); await pending;
  assert.equal(rejected.completed(), 1);
  assert.equal(rejected.refreshes.size, 0);

  const retired = setup('native');
  const completed = retired.yield();
  retired.refresh(); await completed;
  retired.tasks.shift().reject(new Error('Late abort')); await flush();
  assert.equal(retired.channels(), 0, 'Late rejection must not schedule redundant work');
  assert.equal(retired.completed(), 1);

  const bounded = setup('missing');
  const waiting = bounded.yield(); bounded.refresh(); await waiting;
  for (let i = 0; i < 8; ++i) await bounded.yield();
  assert.equal(bounded.immediate(), 8, 'All eight bounded continuations must return synchronously');
  assert.equal(bounded.suspended(), 1, 'Immediate continuations must not suspend the native stack');
  assert.equal(bounded.messages.length, 1, 'Continuation burst needs no further posted tasks');
  assert.equal(bounded.refreshes.size, 0);
  const limited = bounded.yield();
  assert.equal(bounded.suspended(), 2, 'Exhausting the continuation count must suspend again');
  assert.equal(bounded.messages.length, 1, 'Frozen clock must wait without adding another posted wake');
  bounded.deliver(); await flush();
  assert.equal(bounded.completed(), 9, 'Stale callback must not release the bounded wait');
  bounded.deliver(); await limited;

  const timed = setup('missing');
  const initial = timed.yield(); timed.refresh(); await initial;
  timed.advance(1); await timed.yield();
  timed.advance(2);
  const expired = timed.yield();
  assert.equal(timed.immediate(), 1);
  assert.equal(timed.suspended(), 2, 'The time budget also bounds synchronous continuations');
  assert.equal(timed.messages.length, 1, 'Expired burst must wait while retaining only one posted wake');
  timed.deliver(); await flush(); assert.equal(timed.completed(), 2);
  timed.deliver(); await expired;

  const recovery = setup('missing');
  const held = recovery.yield(); recovery.refresh(); await held;
  const recoveryUntil = recovery.Module.yieldTaskRetryUntil;
  recovery.advance(4);
  const retried = recovery.yield();
  assert.equal(recovery.timers.size, 1);
  const staleTimer = [...recovery.timers.values()][0];
  recovery.retry(); await retried;
  assert.equal(recovery.Module.yieldTaskRetryUntil, recoveryUntil, 'Recovery timer must not extend its own mode indefinitely');
  assert.equal(recovery.Module.yieldResumesLeft, 8);
  recovery.deliver(); staleTimer(); await flush();
  assert.equal(recovery.completed(), 2, 'Retired posted/timer callbacks cannot resume again');
  recovery.advance(251);
  const ordinary = recovery.yield();
  assert.equal(recovery.timers.size, 0, 'Recovery mode must expire');
  recovery.deliver(); await ordinary;

  const direct = setup('missing'); direct.Module.bufferedSurface = true;
  const gpuWait = direct.yield(); direct.refresh(); await gpuWait;
  direct.advance(4);
  const gpuNext = direct.yield();
  assert.equal(direct.timers.size, 0, 'Prepared GPU surfaces need no readback recovery timer');
  direct.deliver(); await flush(); assert.equal(direct.completed(), 1);
  direct.deliver(); await gpuNext;

  const buffered = setup('native');
  Object.assign(buffered.Module, { yieldForBufferedFrames:true, bufferedSurface:true, surfaceFrames:[{},{}], audioQueuedMs:()=>80,
    surfaceClock:{refreshInterval:()=>1000/60},
    yieldResumesLeft:8, yieldResumeUntil:103 });
  const displayFirst = buffered.yield();
  assert.equal(buffered.tasks.length, 0, 'A healthy two-image queue must yield to display rather than another posted task');
  assert.equal(buffered.refreshes.size, 0, 'Capacity wait uses the existing presenter callback');
  assert.equal(typeof buffered.Module.surfaceYield, 'function', 'The presenter owns the pending capacity wake');
  assert.equal(buffered.Module.yieldResumesLeft, 0, 'Capacity wait must override the continuation burst');
  assert.equal(buffered.immediate(), 0, 'A full display queue must never take the synchronous fast path');
  await flush(); assert.equal(buffered.completed(), 0);
  buffered.surfaceRefresh();
  assert.equal(buffered.wakes(), 0, 'A presenter callback must finish before native work resumes');
  await displayFirst;
  assert.equal(buffered.completed(), 1);
  buffered.Module.surfaceFrames.pop();
  const refill = buffered.yield();
  assert.equal(buffered.tasks.length, 1, 'A one-image queue must prepare work promptly');
  buffered.tasks.shift().resolve(); await refill;
  buffered.Module.surfaceFrames.push({}); buffered.Module.audioQueuedMs = () => 79;
  const catchUp = buffered.yield();
  assert.equal(buffered.tasks.length, 1, 'Audio below the reserve for two refreshes and a render slice must refill promptly');
  buffered.tasks.shift().resolve(); await catchUp;
  assert.equal(buffered.refreshes.size, 0);
  buffered.Module.yieldForBufferedFrames = false; buffered.Module.audioQueuedMs = () => 80;
  const primary = buffered.yield();
  assert.equal(buffered.tasks.length, 1, 'The primary build retains its existing task scheduling');
  buffered.tasks.shift().resolve(); await primary;
  buffered.Module.yieldForBufferedFrames = true;
  buffered.Module.surfaceClock.refreshInterval = () => 1000/120;
  buffered.Module.audioQueuedMs = () => 64;
  const fasterDisplay = buffered.yield();
  assert.equal(buffered.tasks.length, 0, 'A faster display needs less reserve for its two refresh waits');
  buffered.surfaceRefresh(); await fasterDisplay;
  buffered.Module.audioQueuedMs = () => 62;
  const reserveLow = buffered.yield();
  assert.equal(buffered.tasks.length, 1, 'A fast display must also retain its calculated audio reserve');
  buffered.tasks.shift().resolve(); await reserveLow;

  const deferred = setup('missing');
  for (let i = 0; i < 512; ++i) {
    const work = deferred.yield(); deferred.refresh(); await work; deferred.advance(4);
    assert.equal(deferred.messages.length, 1, 'Extended deferral must not grow the browser task queue');
    assert.equal(deferred.Module.yieldWaiters.length, 1, 'Extended deferral retains one retired callback');
    assert.equal(deferred.timers.size, 0);
  }
  const live = deferred.yield();
  deferred.deliver(); await flush();
  assert.equal(deferred.completed(), 512, 'Retired wake must post a new task rather than consume the current waiter');
  deferred.deliver(); await live;
  assert.equal(deferred.messages.length, 0);
  assert.equal(deferred.Module.yieldWaiters.length, 0);
  assert.equal(deferred.Module.yieldNextPost, undefined);

  const stress = setup('native');
  for (let i = 0; i < 512; ++i) {
    const work = stress.yield(), native = stress.tasks.shift();
    if (i % 3 === 0) { stress.refresh(); await work; native.resolve(); }
    else if (i % 3 === 1) native.resolve();
    else { native.reject(new Error('Abort')); await flush(); stress.deliver(); }
    await work; await flush(); stress.advance(3);
    assert.equal(stress.completed(), i + 1);
    assert.equal(stress.refreshes.size, 0);
    assert.equal(stress.messages.length, 0);
    assert.equal(stress.timers.size, 0);
    assert.equal(stress.Module.yieldWaiters?.length || 0, 0);
  }
  console.log('Browser yield: scheduler/refresh races, missing/rejected/throwing APIs, FIFO fallback, bounded continuation windows, temporary timer recovery and repeated resumes passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
