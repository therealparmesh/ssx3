const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/game-runtime-client.js'), 'utf8');
(async () => {
  const calls = [], status = { pauseSequence: 0, pauseReady: 0 }, heap = new Uint8Array(new SharedArrayBuffer(256));
  const ring = new Int32Array(heap.buffer, 32, 4); ring[0] = 4800; ring[1] = 2400;
  let resolveReady, transferred = 0, initialized = 0, cardGeneration = 0, onEvent, savedEvents = 0;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const bridge = { phase: 'ready', ready, cardGeneration: () => cardGeneration, heap: () => heap, status: name => status[name] || 0,
    start(config, transfer) { calls.push(['init', config, transfer]); resolveReady({ audioRing: 32, cardPendingAddress: 64 }); },
    notify(method, args) { calls.push([method, ...args]); return true; },
    request(method, args = []) { calls.push([method, ...args]); return Promise.resolve(method === 'cardExists' ? true : undefined); },
  };
  const Module = { arguments: ['/game/core.elf'], discUrl: 'disc.iso', noCard: false,
    onRuntimeInitialized() { ++initialized; }, print() {}, setStatus() {}, onPresent() {}, onFrame() {}, ps2CardSaved() { ++savedEvents; }, ps2CardSaveFailed() {} };
  const canvas = { width: 1280, height: 760, transferControlToOffscreen() { ++transferred; return { offscreen: true }; } };
  const context = vm.createContext({ Module, canvas, URL, Uint8Array, Int32Array, Atomics,
    Worker: class {}, ps2WorkerRuntime: { createBridge: (worker, options) => { onEvent = options.onEvent; return bridge; } },
    document: { baseURI: 'http://localhost/game/' },
    discSize: async () => 4096, chooseGpu: async () => 'GPU test', acquireCardStorage: async () => {},
    cardStorageOwned: true, fitCanvas() {}, scale: '1', params: new URLSearchParams(), statusEl: {}, failPlayer() {} });
  vm.runInContext(source, context);
  await vm.runInContext("startWorkerPlayer(new URL('http://localhost/game/ps2web.js'))", context);
  assert.equal(transferred, 1); assert.equal(initialized, 1);
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
  bridge.phase = 'closed'; assert.equal(Module._ps2web_audio_queued_ms(), 0);
  const config = calls[0][1]; assert.equal(config.discUrl, 'http://localhost/game/disc.iso'); assert.equal(config.cardStorageOwned, true);
  console.log('PASS: game-worker client pause generations, input ordering, shared audio counters and card dispatch');
})().catch(error => { console.error(error); process.exitCode = 1; });
