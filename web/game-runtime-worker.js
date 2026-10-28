// Dedicated owner of the Wasm renderer, emulation threads and memory-card FS.
// DOM/audio gestures stay in the page. GPU failure preserves card-recovery RPC.
'use strict';
importScripts('./worker-runtime-bridge.js');
let initialized = false;
self.addEventListener('message', async function initialize(event) {
  const message = event.data;
  if (message?.type !== 'init' || initialized) return;
  initialized = true;
  const core = ps2WorkerRuntime, config = message.config;
  self.Module = {};
  let producer, readbackProgress;
  const status = core.makeStatus(), values = new Float64Array(core.fields.length);
  let ready = false, started = false, shown = 0, pauseSequence = 0, statusTimer;
  const card = '/memcard/Mcd001.ps2';
  function publish() {
    if (!ready) return;
    values[0] = Module._ps2web_frames(); values[1] = Module._ps2web_primitives();
    values[2] = Module._ps2web_gpu_ms(); values[3] = Module._ps2web_idle_ms(0);
    values[4] = Module._ps2web_idle_ms(1); values[5] = Module._ps2web_idle_ms(2);
    values[6] = Module._ps2web_vu_interpreted(); values[7] = Module._ps2web_pause_ready();
    values[8] = Module._ps2web_card_pending(); values[9] = Module._ps2web_rumble(0);
    values[10] = Module._ps2web_rumble(1); values[11] = shown;
    values[12] = Module._ps2web_audio_queued_ms(); values[13] = pauseSequence;
    core.publishStatus(status, values);
  }
  function safeCard() {
    if (started && !Module._ps2web_pause_ready()) throw new Error('The game has not finished pausing.');
    if (Module._ps2web_card_pending()) throw new Error('The game still has unsaved memory-card changes.');
  }
  function failure(error) {
    if (Module.failed || Module.stoppedForReload) return;
    Module.failed = true; Module.paused = true;
    producer?.pause(true); readbackProgress?.close();
    if (ready && started) Module._ps2web_pause(1);
    if (ready) { publish(); host.event('runtime-failed', String(error?.message || error)); }
    else host.fatal(error instanceof Error ? error : new Error(String(error)));
  }
  const host = core.installHost(self, message.session, {
    start() {
      if (started) throw new Error('Game already started');
      started = true; Module.running = true;
      const result = Module.callMain(Module.arguments);
      if (result?.catch) result.catch(failure);
      return { started: true };
    },
    pause(value, sequence) {
      Module.paused = !!value;
      producer?.pause(value);
      Module._ps2web_pause(value ? 1 : 0);
      pauseSequence = sequence; publish();
    },
    pad(...args) { Module._ps2web_pad(...args); },
    connected(...args) { Module._ps2web_pad_connected(...args); },
    pressure(...args) { Module._ps2web_pressure(...args); },
    resize(width, height) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384)
        throw new Error('Invalid display size');
      if (producer) producer.resize(width, height);
      else if (started) Module._ps2web_resize(width, height);
      else { Module.canvas.width = width; Module.canvas.height = height; }
    },
    cardExists() { return FS.analyzePath(card).exists; },
    readCard() {
      safeCard();
      const bytes = FS.readFile(card);
      return core.transferResult(bytes, [bytes.buffer]);
    },
    writeCard(bytes) {
      safeCard();
      if (!(bytes instanceof Uint8Array) || bytes.length !== 8650752) throw new Error('Invalid memory card');
      FS.writeFile(card, bytes, { canOwn: true });
    },
    removeCard() { safeCard(); if (FS.analyzePath(card).exists) FS.unlink(card); },
    syncCard() {
      if (!config.cardStorageOwned || config.noCard) throw new Error('Memory-card storage is not owned');
      return new Promise((resolve, reject) => FS.syncfs(false, error => error ? reject(error) : resolve()));
    },
    stop() {
      Module.stoppedForReload = true; Module.paused = true; Module.running = false;
      clearInterval(statusTimer);
      readbackProgress?.close(); producer?.close();
      PThread.terminateAllThreads();
    },
  }, { onNotifyError: failure });
  self.addEventListener('unhandledrejection', event => { event.preventDefault(); failure(event.reason); });
  if (config.splitPresenter) {
    try {
      importScripts('./pixel-producer.js', './readback-progress.js');
      readbackProgress = ps2ReadbackProgress.install(self, failure);
      producer = ps2PixelProducer.create({ canvas: config.canvas,
        url: new URL('pixel-presenter-worker.js', config.runtimeUrl), lowPower: config.lowPower,
        onFailure: failure, onPresent: () => Module.onPresent(),
        onCapacity: () => { const wake = Module.surfaceYield; Module.surfaceYield = undefined; if (wake) wake(); } });
    } catch (error) { failure(error); return; }
  }
  self.Module = {
    canvas: producer ? new OffscreenCanvas(1, 1) : config.canvas, noInitialRun: true,
    mainScriptUrlOrBlob: config.runtimeUrl,
    locateFile: file => new URL(file, config.assetBase).href,
    arguments: config.arguments, discUrl: config.discUrl, discSize: config.discSize,
    stateUrl: config.stateUrl, fastBoot: config.fastBoot, fullEffects: config.fullEffects,
    noCard: config.noCard, noSurface: false, presentCopy: !!producer, bufferedSurface: !producer,
    prepareCopyFrames: !!producer,
    yieldForBufferedFrames: true, stagedUploads: config.stagedUploads,
    print: text => host.event('log', text), printErr: text => host.event('log', text),
    setStatus: text => host.event('status', text),
    onAbort: failure, onHalt: failure,
    audioQueuedMs: () => Module._ps2web_audio_queued_ms(),
    ps2CardSaved() {
      const generation = core.markCardSaved(status);
      publish(); host.event('card-saved', { generation });
    },
    ps2CardSaveFailed() { publish(); host.event('card-save-failed'); },
    // The page samples telemetry on its existing animation callback. Avoid
    // scheduling two DOM messages for every frame rendered in this worker.
    onPresent() { ++shown; },
    onFrame() {},
    preRun: [() => {
      ENV.PS2_SCALE = config.scale;
      ENV.PS2_GPU_TIMESTAMPS = config.debug ? '1' : '0';
      if (config.lowPower) ENV.PS2_GPU_LOW_POWER = '1';
      if (!config.noCard) {
        Module.addRunDependency('card');
        try {
          if (!config.cardStorageOwned) throw new Error('Memory-card storage is not owned');
          FS.mkdir('/memcard'); FS.mount(IDBFS, {}, '/memcard');
          FS.syncfs(true, error => {
            if (error) failure(new Error('Could not load your saved memory card.', { cause: error }));
            Module.removeRunDependency('card');
          });
        } catch (error) { failure(error); Module.removeRunDependency('card'); }
      }
    }],
    async onRuntimeInitialized() {
      if (Module.failed) return;
      if (producer) await producer.ready;
      else GL.offscreenCanvases.canvas = Module.canvas;
      if (Module.failed) return;
      ready = true; publish();
      host.ready({ memory: wasmMemory, status, audioRing: Module._ps2web_audio_ring(), cardPendingAddress: Module._ps2web_card_pending_address(), cardExists: FS.analyzePath(card).exists });
      statusTimer = setInterval(publish, 16);
    },
  };
  if (producer) {
    Module.blitFrames = producer.frames; Module.blitFree = producer.free; Module.blitClock = producer.clock;
    Module.pixelProducer = producer;
    Module.transferFrame = (pointer, width, height, wide) => {
      if (!Module.paused && !Module.failed && !Module.stoppedForReload)
        producer.publish(new Uint8Array(wasmMemory.buffer, pointer, width * height * 4), width, height, wide);
    };
  }
  try { importScripts(config.runtimeUrl); } catch (error) { failure(error); }
});
