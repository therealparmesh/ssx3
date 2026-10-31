// Three owned pixel slots bridge the Wasm readback producer and the lightweight
// presenter. A slot remains pinned until the upload call has copied its contents.
(function(root) {
  'use strict';
  const VERSION = 1, FREE = 0, READY = 1, READING = 2, WRITING = 3, COUNT = 3;
  function create(options) {
    const primeFrames = options.primeFrames === undefined ? 2 : options.primeFrames;
    if (!Number.isInteger(primeFrames) || primeFrames < 2 || primeFrames > COUNT)
      throw new Error('Invalid presenter priming depth.');
    const worker = options.port || new (options.Worker || Worker)(options.url, { name: 'ssx3-presenter' });
    const state = new Int32Array(new SharedArrayBuffer(COUNT * 2 * 4));
    const slots = Array.from({ length: COUNT }, (_, id) => ({ id,
      bytes: new Uint8Array(new SharedArrayBuffer(options.slotBytes || 4 * 1024 * 1024)), sequence: 0 }));
    const frames = [], free = slots.slice();
    let closed = false, failed = false, initialized = false, lastShown = 0, refresh = 1000 / 60, resolveReady, rejectReady;
    let replacements = 0;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    function failure(error) {
      if (closed || failed) return;
      failed = true;
      rejectReady(error);
      options.onFailure?.(error);
    }
    function onError(event) { event.preventDefault?.(); failure(new Error(event.message || 'The presenter stopped.')); }
    function onMessageError() { failure(new Error('Could not receive a presenter message.')); }
    function onMessage({ data: message }) {
      if (closed || failed || !message) return;
      if (message.type === 'ready') {
        if (message.version !== VERSION) { failure(new Error('Presenter version mismatch.')); return; }
        if (initialized) return;
        initialized = true; resolveReady();
      } else if (message.type === 'failure') {
        failure(new Error(message.error || 'The presenter could not continue.'));
      } else if (message.type === 'release') {
        if (!Number.isInteger(message.id) || message.id < 0 || message.id >= COUNT ||
            !Number.isInteger(message.sequence) || message.sequence < 0 || message.sequence > 0xFFFFFFFF ||
            !Number.isSafeInteger(message.shown) || message.shown < 1) { failure(new Error('Invalid presenter slot release.')); return; }
        if (message.shown <= lastShown) return;
        lastShown = message.shown;
        if (Number.isFinite(message.refresh) && message.refresh > 0) refresh = message.refresh;
        options.onPresent?.();
        const index = frames.findIndex(frame => frame.id === message.id && frame.sequence === message.sequence);
        // A consumed slot can be reused before its release event is delivered.
        // Its old event must not free the newer generation a second time.
        if (index < 0) return;
        free.push(frames.splice(index, 1)[0]);
        options.onCapacity?.();
      }
    }
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    worker.start?.();
    worker.postMessage({ type: 'init', version: VERSION, canvas: options.canvas,
      buffers: slots.map(slot => slot.bytes.buffer), slotState: state.buffer,
      primeFrames, lowPower: !!options.lowPower }, [options.canvas]);
    return {
      ready, frames, free,
      clock: { refreshInterval: () => refresh },
      get replacements() { return replacements; },
      publish(bytes, width, height, wide) {
        if (closed || failed) return;
        const size = width * height * 4;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
            width > 4096 || height > 4096 || size > 64 * 1024 * 1024 || !(bytes instanceof Uint8Array) || bytes.byteLength !== size)
          throw new Error('Invalid game frame dimensions.');
        let frame = free.pop();
        if (frame) {
          if (Atomics.compareExchange(state, frame.id * 2, FREE, WRITING) !== FREE)
            throw new Error('Presenter slot was not free.');
        } else {
          const index = frames.findIndex(candidate => {
            const value = Atomics.load(state, candidate.id * 2);
            if (value !== FREE && value !== READY) return false;
            if (Atomics.compareExchange(state, candidate.id * 2, value, WRITING) !== value) return false;
            if (value === READY) ++replacements;
            return true;
          });
          if (index < 0) throw new Error('No writable presenter slot.');
          frame = frames.splice(index, 1)[0];
        }
        frame.sequence = (Atomics.add(state, frame.id * 2 + 1, 1) + 1) >>> 0;
        let buffer;
        if (size > frame.bytes.byteLength) {
          frame.bytes = new Uint8Array(new SharedArrayBuffer(2 ** Math.ceil(Math.log2(size))));
          buffer = frame.bytes.buffer;
        }
        frame.bytes.set(bytes);
        frames.push(frame);
        Atomics.store(state, frame.id * 2, READY);
        // A larger backing store travels with its generation. The consumer
        // cannot pin that generation before receiving the matching metadata.
        worker.postMessage({ type: 'frame', id: frame.id, sequence: frame.sequence,
          width, height, wide: !!wide, buffer });
      },
      pause(value) { if (!closed) worker.postMessage({ type: 'pause', value: !!value }); },
      resize(width, height) { if (!closed) worker.postMessage({ type: 'resize', width, height }); },
      close() {
        if (closed) return;
        closed = true;
        const error = new Error('Presenter stopped.'); error.name = 'AbortError'; rejectReady(error);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onMessageError);
        if (options.port) { worker.postMessage({ type: 'stop' }); worker.close(); }
        else worker.terminate();
        frames.length = free.length = slots.length = 0;
      },
    };
  }
  const api = { VERSION, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ps2PixelProducer = api;
})(globalThis);
