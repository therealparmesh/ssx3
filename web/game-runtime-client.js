// Adapt the established DOM shell to a worker-owned game. Only read-only
// telemetry is cached; pause completion is tied to the page's latest request.
async function startWorkerPlayer(runtimeUrl) {
  const splitPresenter = params.get('presenter') !== 'direct';
  Module.ENV = {};
  Module.presentCopy = false;
  Module.bufferedSurface = true;
  const [bytes, gpu] = await Promise.all([discSize(), chooseGpu(), Module.noCard ? Promise.resolve() : acquireCardStorage()]);
  if (Module.failed) return;
  if (Module.presentCopy || Module.noSurface) throw new Error('This experimental renderer requires direct WebGPU presentation.');
  Module.discSize = bytes; Module.gpuInfo = gpu;
  Module.presentCopy = splitPresenter; Module.bufferedSurface = !splitPresenter;
  fitCanvas();
  const worker = new Worker(new URL('game-runtime-worker.js', runtimeUrl), { name: 'ssx3-runtime' });
  let presenter = null, presenterChannel = null;
  function stopPresenter() {
    if (presenter) {
      presenter.removeEventListener('error', presenterError);
      presenter.removeEventListener('messageerror', presenterError);
      presenter.terminate(); presenter = null;
    }
    presenterChannel?.port1.close(); presenterChannel?.port2.close();
    presenterChannel = null;
  }
  function presenterError(event) {
    event.preventDefault?.();
    const message = event.message || 'The presentation worker stopped.';
    stopPresenter();
    // Preserve the game worker's filesystem for export after a renderer crash.
    // Before readiness the game has not started or modified its stored card.
    if (bridge.phase === 'ready') bridge.notify('presentationFailed', [message]);
    else {
      cardPersistenceBlocked = true;
      bridge.close();
      failPlayer('The display could not start. Reload to try again.', new Error(message));
    }
  }
  let pauseSequence = 0, audioRing = 0, cardPendingAddress = 0, handledCardGeneration = 0;
  const bridge = Module.workerRuntime = ps2WorkerRuntime.createBridge(worker, {
    onFatal: error => {
      stopPresenter();
      // A terminated worker has lost its filesystem. Keep the stored card and
      // allow recovery instead of waiting forever for an unavailable writer.
      cardPersistenceBlocked = true;
      failPlayer('The game worker stopped. Reload to return to your last stored save.', error);
    },
    onEvent(name, value) {
      if (name === 'card-saved') {
        handledCardGeneration = value.generation;
        Module.ps2CardSaved();
      }
      else if (name === 'card-save-failed') Module.ps2CardSaveFailed();
      else if (name === 'runtime-failed') {
        stopPresenter();
        failPlayer('The player could not continue. Export your memory card, then reload.', value);
      }
      else if (name === 'status') Module.setStatus(value);
      else if (name === 'log') Module.print(value);
    },
  });
  const closeBridge = bridge.close.bind(bridge);
  bridge.close = (...args) => { stopPresenter(); closeBridge(...args); };
  if (splitPresenter) {
    try {
      // Chromium requires the display worker to be created by a window for
      // worker animation callbacks. Transfer only a port to the game owner.
      presenterChannel = new MessageChannel();
      presenter = new Worker(new URL('pixel-presenter-worker.js', runtimeUrl), { name: 'ssx3-presenter' });
      presenter.addEventListener('error', presenterError);
      presenter.addEventListener('messageerror', presenterError);
      presenter.postMessage({ type: 'connect', port: presenterChannel.port2 }, [presenterChannel.port2]);
    } catch (error) { bridge.close(); throw error; }
  }
  Module._ps2web_pause = value => bridge.notify('pause', [value, ++pauseSequence]);
  Module._ps2web_pause_ready = () => bridge.status('pauseSequence') === pauseSequence && bridge.status('pauseReady');
  Module._ps2web_card_pending = () => {
    if (bridge.phase !== 'ready') return false;
    const pending = cardPendingAddress
      ? Atomics.load(bridge.heap(), cardPendingAddress) : bridge.status('cardPending');
    return !!pending || bridge.cardGeneration() !== handledCardGeneration;
  };
  Module._ps2web_pad = (...args) => bridge.notify('pad', args);
  Module._ps2web_pad_connected = (...args) => bridge.notify('connected', args);
  Module._ps2web_pressure = (...args) => bridge.notify('pressure', args);
  Module._ps2web_resize = (...args) => bridge.notify('resize', args);
  Module._ps2web_rumble = port => bridge.status(port ? 'rumble1' : 'rumble0');
  Module._ps2web_frames = () => bridge.status('frames');
  Module._ps2web_primitives = () => bridge.status('primitives');
  Module._ps2web_gpu_ms = () => bridge.status('gpuMs');
  Module._ps2web_idle_ms = which => bridge.status(['eeIdleMs', 'renderIdleMs', 'vuIdleMs'][which]);
  Module._ps2web_vu_interpreted = () => bridge.status('vuInterpreted');
  Module._ps2web_audio_ring = () => audioRing;
  Module._ps2web_audio_queued_ms = () => {
    if (!audioRing || bridge.phase !== 'ready') return 0;
    const ring = new Int32Array(bridge.heap().buffer, audioRing, 4);
    return ((Atomics.load(ring, 0) - Atomics.load(ring, 1)) >>> 0) / 48;
  };
  Object.defineProperty(Module, 'HEAPU8', { get: () => bridge.heap() });
  Module.callMain = () => bridge.request('start');
  Module.cardFS = {
    analyzePath: async () => ({ exists: await bridge.request('cardExists') }),
    readFile: () => bridge.request('readCard'),
    writeFile: (path, bytes) => bridge.request('writeCard', [bytes]),
    unlink: () => bridge.request('removeCard'),
    syncfs: (populate, callback) => bridge.request('syncCard').then(() => callback(null), callback),
  };
  try {
    const offscreen = canvas.transferControlToOffscreen();
    Module.offscreenTransferred = true;
    Module.workerCanvasWidth = canvas.width; Module.workerCanvasHeight = canvas.height;
    bridge.start({ canvas: offscreen, runtimeUrl: runtimeUrl.href,
      splitPresenter, presenterPort: presenterChannel?.port1,
      assetBase: new URL(globalThis.SSX3_ASSET_BASE || '.', runtimeUrl).href,
      arguments: Module.arguments, discUrl: new URL(Module.discUrl, document.baseURI).href,
      discSize: bytes, stateUrl: Module.stateUrl ? new URL(Module.stateUrl, document.baseURI).href : null,
      fastBoot: Module.fastBoot, fullEffects: Module.fullEffects, noCard: Module.noCard,
      cardStorageOwned, scale, debug: params.has('debug'), stagedUploads: Module.stagedUploads,
      lowPower: Module.ENV.PS2_GPU_LOW_POWER === '1',
    }, presenterChannel ? [offscreen, presenterChannel.port1] : [offscreen]);
    const metadata = await bridge.ready;
    const address = metadata.cardPendingAddress;
    if (!Number.isInteger(address) || address <= 0 || address >= bridge.heap().byteLength)
      throw new Error('The game worker returned an invalid memory-card status address.');
    audioRing = metadata.audioRing; cardPendingAddress = address;
  } catch (error) {
    cardPersistenceBlocked = true;
    bridge.close();
    throw error;
  }
  // A resize posted during startup may precede the ready handshake. Apply the
  // latest dimensions once the owner can accept commands.
  Module._ps2web_resize(Module.workerCanvasWidth, Module.workerCanvasHeight);
  statusEl.textContent = params.has('debug') ? 'Ready, ' + gpu : 'Ready to play';
  Module.onRuntimeInitialized();
}
