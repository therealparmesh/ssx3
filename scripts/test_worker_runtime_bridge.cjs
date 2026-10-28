const assert = require('node:assert/strict');
const api = require('../web/worker-runtime-bridge.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function pair() {
  function port() {
    const listeners = new Map();
    return {
      terminated: 0,
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      emit(type, value) { for (const listener of [...(listeners.get(type) || [])]) listener(value); },
      postMessage(value, transfer = []) {
        const cloned = structuredClone(value, { transfer });
        queueMicrotask(() => { if (!this.terminated) this.peer.emit('message', { data: cloned }); });
      },
      terminate() { ++this.terminated; this.peer.terminated = this.terminated; },
    };
  }
  const worker = port(), scope = port(); worker.peer = scope; scope.peer = worker;
  return { worker, scope };
}

async function connected(handlers = {}, options = {}) {
  const ports = pair(), session = 'test-session';
  const status = api.makeStatus(), memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const bridge = api.createBridge(ports.worker, { ...options, session });
  const host = api.installHost(ports.scope, session, handlers);
  bridge.start({ test: true }); host.ready({ status, memory }); await bridge.ready;
  return { ...ports, bridge, host, status, memory, close() { host.close(); bridge.close(); } };
}

(async () => {
  const events = [];
  const c = await connected({
    sum: (a, b) => a + b,
    fail: () => { const error = new Error('Card write rejected'); error.code = 'CardWriteFailed'; throw error; },
    notify: value => events.push(value),
    notifyFail: () => { throw new Error('Input dispatch failed'); },
  }, { onEvent: (...event) => events.push(event) });
  const ready = await c.bridge.ready;
  assert.equal(ready.memory, undefined, 'The fulfilled ready promise must not retain the shared heap');
  assert.equal(ready.status, undefined);
  assert.equal(await c.bridge.request('sum', [17, 25]), 42);
  await assert.rejects(c.bridge.request('fail'), error => error.code === 'CardWriteFailed');
  await assert.rejects(c.bridge.request('toString'), /Unknown worker runtime method/);
  assert.equal(c.bridge.notify('notify', [7]), true); await delay(0); assert(events.includes(7));
  c.bridge.notify('notifyFail'); await delay(0); assert(events.some(x => Array.isArray(x) && x[0] === 'notify-error'));
  c.host.event('runtime-failed', { message: 'Graphics device lost' }); await delay(0);
  assert.equal(c.bridge.phase, 'ready', 'GPU failure must leave card recovery RPC available');
  assert.equal(await c.bridge.request('sum', [1, 2]), 3);

  const values = api.fields.map((_, i) => i + 10);
  api.publishStatus(c.status, values); assert.equal(c.bridge.status('frames'), 10);
  assert.equal(c.bridge.cardGeneration(), 0);
  assert.equal(api.markCardSaved(c.status), 1);
  assert.equal(c.bridge.cardGeneration(), 1);
  const header = new Int32Array(c.status, 0, 4), data = new Float64Array(c.status, 16, api.fields.length);
  Atomics.add(header, 1, 1); data[0] = 999;
  api.markCardSaved(c.status);
  assert.equal(c.bridge.cardGeneration(), 2, 'Save completion must remain visible during an unfinished telemetry publication');
  assert.equal(c.bridge.status('frames'), 10, 'An unfinished publication must retain the last complete snapshot');
  Atomics.add(header, 1, 1); assert.equal(c.bridge.status('frames'), 999);
  assert.throws(() => c.bridge.status('__proto__'), /Unknown runtime status/);
  assert.throws(() => api.publishStatus(c.status, new Array(api.fields.length)), /Invalid runtime status/);
  const originalHeap = c.bridge.heap(); originalHeap[123] = 77; c.memory.grow(1);
  assert.equal(c.bridge.heap().length, 131072); assert.equal(c.bridge.heap()[123], 77);
  assert.equal(originalHeap[123], 77, 'Audio may keep a view of the original shared-memory prefix');
  c.close(); c.close(); assert.equal(c.worker.terminated, 1);
  assert.equal(c.bridge.notify('notify'), false); assert.throws(() => c.bridge.heap(), /not ready/);
  await assert.rejects(c.bridge.request('sum'), /closed/);

  let owned;
  const transfer = await connected({ bytes() { owned = new Uint8Array([1, 3, 5]); return api.transferResult(owned, [owned.buffer]); } });
  const bytes = await transfer.bridge.request('bytes'); assert.deepEqual([...bytes], [1, 3, 5]);
  assert.equal(owned.byteLength, 0, 'Transferred card/state buffers must detach rather than be copied'); transfer.close();

  let release;
  const timed = await connected({ wait: () => new Promise(resolve => { release = resolve; }) }, { timeoutMs: 10 });
  await assert.rejects(timed.bridge.request('wait'), error => error.code === 'RuntimeRequestTimeout' && error.outcome === 'unknown');
  assert.equal(timed.bridge.pendingCount, 0); release(42); await delay(0);
  assert.equal(timed.bridge.pendingCount, 0, 'A late reply cannot revive a timed-out request'); timed.close();

  const crashed = await connected({ wait: () => new Promise(() => {}) });
  const one = crashed.bridge.request('wait'), two = crashed.bridge.request('wait'); await delay(0);
  crashed.worker.emit('error', { message: 'Worker crashed', preventDefault() {} });
  await assert.rejects(one, /Worker crashed/); await assert.rejects(two, /Worker crashed/);
  assert.equal(crashed.bridge.pendingCount, 0); assert.equal(crashed.worker.terminated, 1); crashed.host.close();

  const unknown = pair(); let fatals = 0;
  const invalid = api.createBridge(unknown.worker, { session: 'invalid', onFatal: () => ++fatals }); invalid.start({});
  unknown.scope.postMessage({ type: 'ready', session: 'invalid', version: 999 });
  await assert.rejects(invalid.ready, /Invalid worker runtime handshake/); assert.equal(fatals, 1);

  const stopped = pair(); const stoppedBridge = api.createBridge(stopped.worker);
  stoppedBridge.close(); await assert.rejects(stoppedBridge.ready, /stopped/);

  const startup = pair(); const startupBridge = api.createBridge(startup.worker, { readyTimeoutMs: 10 });
  startupBridge.start({}); await assert.rejects(startupBridge.ready, /startup timed out/);
  assert.equal(startup.worker.terminated, 1);

  const cloning = pair(); const cloningBridge = api.createBridge(cloning.worker);
  cloningBridge.start({ unsupported: () => {} });
  await assert.rejects(cloningBridge.ready, /could not be cloned/); assert.equal(cloning.worker.terminated, 1);
  console.log('PASS: worker RPC ownership, recovery events, status publication, memory growth, transfer, timeout and teardown');
})().catch(error => { console.error(error); process.exitCode = 1; });
