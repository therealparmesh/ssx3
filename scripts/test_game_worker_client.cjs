const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/game-runtime-client.js'), 'utf8');
async function exercise(userAgent, query, expectedSplit, failureMode) {
  const calls = [], status = { pauseSequence: 0, pauseReady: 0 }, heap = new Uint8Array(new SharedArrayBuffer(256));
  const ring = new Int32Array(heap.buffer, 32, 4); ring[0] = 4800; ring[1] = 2400;
  let resolveReady, rejectReady, transferred = 0, initialized = 0, cardGeneration = 0, onEvent, onFatal, savedEvents = 0, failures = 0;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const bridge = { phase: 'connecting', ready, cardGeneration: () => bridge.phase === 'ready' ? cardGeneration : 0, heap: () => heap, status: name => status[name] || 0,
    close() { this.phase = 'closed'; rejectReady(new Error('Worker closed')); },
    start(config, transfer) {
      calls.push(['init', config, transfer]);
      if (failureMode === 'early') { workers[1].emit('error', { message: 'Early failure', preventDefault() {} }); return; }
      this.phase = 'ready'; resolveReady({ audioRing: 32, cardPendingAddress: failureMode === 'metadata' ? -1 : 64 });
    },
    notify(method, args) { calls.push([method, ...args]); return true; },
    request(method, args = []) { calls.push([method, ...args]); return Promise.resolve(method === 'cardExists' ? true : undefined); },
  };
  const Module = { arguments: ['/game/core.elf'], discUrl: 'disc.iso', noCard: false,
    onRuntimeInitialized() { ++initialized; }, print() {}, setStatus() {}, onPresent() {}, onFrame() {}, ps2CardSaved() { ++savedEvents; }, ps2CardSaveFailed() {} };
  const canvas = { width: 1280, height: 760, transferControlToOffscreen() { if (failureMode === 'canvas') throw new Error('Canvas transfer failed'); ++transferred; return { offscreen: true }; } };
  const workers = [], ports = [];
  class Worker {
    constructor(url) { if (failureMode === 'constructor' && String(url).includes('pixel-presenter-worker')) throw new Error('Presenter constructor failed'); this.url = String(url); this.listeners = new Map(); this.messages = []; this.terminated = 0; workers.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    postMessage(message, transfer) { this.messages.push({ message, transfer }); }
    terminate() { ++this.terminated; }
    emit(type, event) { this.listeners.get(type)?.(event); }
  }
  class MessageChannel {
    constructor() { this.port1 = { closed: 0, close() { ++this.closed; } }; this.port2 = { closed: 0, close() { ++this.closed; } }; ports.push(this); }
  }
  const context = vm.createContext({ Module, canvas, URL, Uint8Array, Int32Array, Atomics, MessageChannel,
    Worker, ps2WorkerRuntime: { createBridge: (worker, options) => { onEvent = options.onEvent; onFatal = options.onFatal; return bridge; } },
    navigator: { userAgent }, document: { baseURI: 'http://localhost/game/' },
    discSize: async () => 4096, chooseGpu: async () => 'GPU test', acquireCardStorage: async () => {},
    cardStorageOwned: true, cardPersistenceBlocked: false, fitCanvas() {}, scale: '1', params: new URLSearchParams(query), statusEl: {}, failPlayer() { ++failures; } });
  vm.runInContext(source, context);
  const operation = vm.runInContext("startWorkerPlayer(new URL('http://localhost/game/ps2web.js'))", context);
  if (failureMode) {
    await assert.rejects(operation);
    assert.equal(bridge.phase, 'closed'); assert.equal(initialized, 0);
    if (workers[1]) assert.equal(workers[1].terminated, 1);
    assert.equal(ports[0].port1.closed, 1); assert.equal(ports[0].port2.closed, 1);
    if (failureMode === 'metadata') assert.equal(Module._ps2web_card_pending(), false);
    return;
  }
  await operation;
  assert.equal(transferred, 1); assert.equal(initialized, 1);
  assert.equal(workers.length, expectedSplit ? 2 : 1);
  if (expectedSplit) {
    assert.match(workers[1].url, /pixel-presenter-worker.js$/);
    assert.equal(workers[1].messages[0].message.port, ports[0].port2);
    assert.equal(calls[0][1].presenterPort, ports[0].port1);
    assert.equal(calls[0][2][1], ports[0].port1);
    // Renderer errors keep the game filesystem alive for card recovery.
    workers[1].emit('error', { message: 'Renderer failed', preventDefault() {} });
    assert.equal(bridge.phase, 'ready');
    assert(calls.some(call => call[0] === 'presentationFailed'));
    assert.equal(workers[1].terminated, 1);
  }
  assert.equal(Module.HEAPU8, heap);
  assert.equal(Module._ps2web_audio_queued_ms(), 50);
  assert.equal(!!Module._ps2web_card_pending(), false);
  Atomics.store(heap, 64, 1);
  assert.equal(Module._ps2web_card_pending(), true, 'A native write must be visible before the next telemetry tick');
  Atomics.store(heap, 64, 0);
  cardGeneration = 2;
  assert.equal(!!Module._ps2web_card_pending(), true, 'Queued native save notifications must prevent an unguarded unload');
  onEvent('card-saved', { generation: 1 });
  assert.equal(!!Module._ps2web_card_pending(), true, 'Handling one save must not conceal a later queued save');
  onEvent('card-saved', { generation: 2 });
  assert.equal(!!Module._ps2web_card_pending(), false);
  assert.equal(savedEvents, 2);
  ring[0] = 32; ring[1] = -16; assert.equal(Module._ps2web_audio_queued_ms(), 1, 'Audio counters retain uint32 wrap semantics');
  Module._ps2web_pause(1); status.pauseSequence = 1; status.pauseReady = 1;
  assert.equal(Module._ps2web_pause_ready(), 1);
  Module._ps2web_pad(0, 0x4000, 128, 0, 128, 128);
  Module._ps2web_pause(0); Module._ps2web_pause(1);
  assert.equal(Module._ps2web_pause_ready(), false, 'A new pause cannot reuse an old acknowledgement');
  status.pauseSequence = 2; assert.equal(Module._ps2web_pause_ready(), false);
  status.pauseSequence = 3; status.pauseReady = 0; assert.equal(Module._ps2web_pause_ready(), 0);
  status.pauseReady = 1; assert.equal(Module._ps2web_pause_ready(), 1);
  assert.deepEqual(calls.filter(c => ['pad', 'pause'].includes(c[0])).map(c => c[0]), ['pause','pad','pause','pause']);
  assert.equal((await Module.cardFS.analyzePath()).exists, true);
  let syncResult = 'unset'; await Module.cardFS.syncfs(false, error => { syncResult = error; }); assert.equal(syncResult, null);
  bridge.phase = 'failed'; onFatal(new Error('Worker crashed'));
  assert.equal(context.cardPersistenceBlocked, true, 'A lost worker filesystem must allow reload from the stored card');
  assert.equal(Module._ps2web_card_pending(), false, 'A cleared bridge cannot leave a phantom save pending');
  assert.equal(failures, 1);
  bridge.close(); bridge.close();
  if (expectedSplit) assert.equal(workers[1].terminated, 1, 'Presenter cleanup must be idempotent');
  bridge.phase = 'closed'; assert.equal(Module._ps2web_audio_queued_ms(), 0);
  const config = calls[0][1]; assert.equal(config.splitPresenter, expectedSplit); assert.equal(config.discUrl, 'http://localhost/game/disc.iso'); assert.equal(config.cardStorageOwned, true);
}
(async () => {
  for (const [userAgent, query, split] of [['Firefox/158', '', true], ['Chrome/156', '', true], ['Firefox/158', 'presenter=direct', false], ['Chrome/156', 'presenter=direct', false], ['Chrome/156', 'presenter=pixels', true]])
    await exercise(userAgent, query, split);
  for (const failure of ['constructor', 'canvas', 'metadata', 'early']) await exercise('Chrome/156', 'presenter=pixels', true, failure);
  console.log('PASS: renderer selection, worker-crash recovery, pause generations, input ordering, shared audio counters and card dispatch');
})().catch(error => { console.error(error); process.exitCode = 1; });
