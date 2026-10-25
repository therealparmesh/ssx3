// Exercise the actual native-to-browser yield across task/refresh races.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../runtime/src/system.cpp'), 'utf8');
const declaration = source.indexOf('EM_ASYNC_JS(void, ps2_browser_yield,');
assert(declaration >= 0);
const start = source.indexOf(', {', declaration) + 3;
const body = source.slice(start, source.indexOf('\n});', start));
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(mode) {
  const Module = {}, refreshes = new Map(), messages = [], tasks = [];
  let sequence = 0, completed = 0, channels = 0;
  const scheduler = mode === 'missing' ? undefined : {
    yield() {
      if (mode === 'throw') throw new Error('Task scheduling unavailable');
      return new Promise((resolve, reject) => tasks.push({resolve, reject}));
    },
  };
  const context = vm.createContext({
    Module, scheduler,
    MessageChannel: class {
      constructor() {
        ++channels;
        this.port1 = {};
        this.port2 = {postMessage: () => messages.push(() => this.port1.onmessage())};
      }
    },
    requestAnimationFrame(callback) { const id = ++sequence; refreshes.set(id, callback); return id; },
    cancelAnimationFrame(id) { refreshes.delete(id); },
  });
  const yieldWork = vm.runInContext('(async function(){' + body + '})', context);
  return {
    Module, refreshes, messages, tasks,
    yield: () => yieldWork().then(() => ++completed),
    completed: () => completed, channels: () => channels,
    refresh() {
      const ready = [...refreshes.values()]; refreshes.clear();
      for (const callback of ready) callback(100);
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
    fallback.deliver(); await pending;
    assert.equal(fallback.Module.yieldWaiters.length, 0);
    assert.equal(fallback.refreshes.size, 0);

    const earlier = fallback.yield();
    fallback.refresh(); await earlier;
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

  const stress = setup('native');
  for (let i = 0; i < 512; ++i) {
    const work = stress.yield(), native = stress.tasks.shift();
    if (i % 3 === 0) { stress.refresh(); await work; native.resolve(); }
    else if (i % 3 === 1) native.resolve();
    else { native.reject(new Error('Abort')); await flush(); stress.deliver(); }
    await work; await flush();
    assert.equal(stress.completed(), i + 1);
    assert.equal(stress.refreshes.size, 0);
    assert.equal(stress.messages.length, 0);
    assert.equal(stress.Module.yieldWaiters?.length || 0, 0);
  }
  console.log('Browser yield: scheduler/refresh races, missing/rejected/throwing APIs, FIFO fallback and bounded repeated resumes passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
