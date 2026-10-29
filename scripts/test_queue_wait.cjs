// Run the actual browser-side render-queue wait, holding native wake delivery
// after the worker changes its shared predicate. Ready work must not wait 50 ms.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../runtime/src/gs/queue.cpp'), 'utf8');
const marker = 'EM_ASYNC_JS(void, ps2_wait_async,';
const declaration = source.indexOf(marker);
assert(declaration >= 0);
const start = source.indexOf(', {', declaration) + 3;
const body = source.slice(start, source.indexOf('\n});', start));
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(seen = 17, immediate = false, proxy = true) {
  const Module = {yieldForBufferedFrames: proxy};
  const heap = new Int32Array(new SharedArrayBuffer(16));
  Atomics.store(heap, 1, seen);
  const callbacks = new Map();
  let sequence = 0, complete = 0, wake, calls = 0;
  const native = new Promise(resolve => { wake = resolve; });
  const context = vm.createContext({
    Module,
    HEAP32: heap,
    Atomics: {
      load: Atomics.load,
      waitAsync(array, index, expected, timeout) {
        ++calls;
        assert.equal(array, heap); assert.equal(index, 1);
        assert.equal(expected, seen); assert.equal(timeout, 50);
        return immediate ? {async:false,value:'not-equal'} : {async:true,value:native};
      },
    },
    requestAnimationFrame(callback) { const id = ++sequence; callbacks.set(id, callback); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
  });
  const wait = vm.runInContext('(async function(word,seen,timeout_ms){' + body + '})', context);
  const promise = wait(4, seen, 50).then(() => ++complete);
  return { heap, callbacks, promise, wake, Module,
    signal(address = 4) { Module.renderWorkWake?.(address); },
    completed: () => complete, calls: () => calls,
    refresh() {
      const ready = [...callbacks.values()]; callbacks.clear();
      for (const callback of ready) callback(100);
    },
  };
}

(async () => {
  const immediate = setup(17, true);
  await immediate.promise;
  assert.equal(immediate.calls(), 1);
  assert.equal(immediate.callbacks.size, 0, 'An immediate wait result must not schedule a refresh');
  assert.equal(immediate.Module.renderWorkWake, undefined);

  const legacy = setup(17, false, false);
  assert.equal(legacy.Module.renderWorkWake, undefined, 'The JSPI/native wait path must not register a compatibility wake');
  legacy.wake('ok'); await legacy.promise;
  assert.equal(legacy.completed(), 1);
  assert.equal(legacy.callbacks.size, 0);

  for (const seen of [17, -2147483648, 2147483648, 4294967295]) {
    const producer = setup(seen);
    const stale = producer.Module.renderWorkWake;
    assert.equal(typeof stale, 'function', 'A producer needs a registered main-thread wake');
    producer.signal(); await flush();
    assert.equal(producer.completed(), 0, 'An unchanged predicate must stay asleep');
    Atomics.store(producer.heap, 1, (seen + 1) >>> 0);
    producer.signal(8); await flush();
    assert.equal(producer.completed(), 0, 'A different word must not wake this waiter');
    producer.signal(); await producer.promise;
    assert.equal(producer.completed(), 1, 'Posted work must wake before RAF or delayed native promise delivery');
    assert.equal(producer.callbacks.size, 0);
    assert.equal(producer.Module.renderWorkWake, undefined, 'Completing a wait retires its producer callback');
    const later = () => {};
    producer.Module.renderWorkWake = later;
    stale(4); producer.wake('timed-out'); await flush();
    assert.equal(producer.completed(), 1, 'Stale producer/native callbacks cannot resume again');
    assert.equal(producer.Module.renderWorkWake, later, 'An old wait cannot clear a newer callback');
  }

  const normal = setup();
  const stale = [...normal.callbacks.values()][0];
  normal.wake('ok'); await normal.promise;
  assert.equal(normal.callbacks.size, 0, 'Native wake cancels the fallback refresh');
  assert.equal(normal.Module.renderWorkWake, undefined);
  if (stale) stale();
  await flush();
  assert.equal(normal.completed(), 1, 'A late refresh cannot resume or schedule work again');
  assert.equal(normal.callbacks.size, 0);

  for (const seen of [17, -2147483648, 2147483648, 4294967295]) {
    const delayed = setup(seen);
    for (let i = 0; i < 3; ++i) {
      delayed.refresh(); await flush();
      assert.equal(delayed.completed(), 0, 'Unchanged work must stay asleep, including signed counters');
      assert(delayed.callbacks.size <= 1, 'At most one fallback refresh may remain queued');
    }
    Atomics.store(delayed.heap, 1, (seen + 1) >>> 0);
    delayed.refresh(); await flush();
    assert.equal(delayed.completed(), 1, 'Observe ready work at the next refresh even while native wake is delayed');
    assert.equal(delayed.callbacks.size, 0);
    delayed.wake('timed-out'); await flush();
    assert.equal(delayed.completed(), 1, 'A late native timeout must not resume an already completed wait');
  }

  const background = setup();
  background.wake('timed-out'); await background.promise;
  assert.equal(background.callbacks.size, 0, 'Native timeout still completes when animation callbacks are suspended');
  assert.equal(background.Module.renderWorkWake, undefined);

  const race = setup();
  Atomics.store(race.heap, 1, 18);
  race.refresh(); race.wake('ok');
  await race.promise; await flush();
  assert.equal(race.completed(), 1, 'Competing wake paths resume the wait exactly once');
  assert.equal(race.callbacks.size, 0);
  console.log('Render-queue wait: explicit producer wake, prompt/delayed native notification, signed/wrapped predicates, callback ownership, background timeout and single-resume races passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
