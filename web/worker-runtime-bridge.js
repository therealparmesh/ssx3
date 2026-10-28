// Transport and shared status for a Wasm runtime owned by a dedicated worker.
// GPU failures are ordinary events so the UI can still request card recovery;
// a broken worker or transport closes the bridge and settles every request.
(function (root) {
  'use strict';
  const VERSION = 1;
  const fields = Object.freeze([
    'frames', 'primitives', 'gpuMs', 'eeIdleMs', 'renderIdleMs', 'vuIdleMs',
    'vuInterpreted', 'pauseReady', 'cardPending', 'rumble0', 'rumble1',
    'presented', 'audioQueuedMs',
  ]);
  const indexes = Object.fromEntries(fields.map((name, index) => [name, index]));
  const statusBytes = 16 + fields.length * 8;
  let serial = 0;
  const transferTag = Symbol('worker-runtime-transfer');

  function errorFrom(value, fallback = 'Worker runtime failed') {
    const error = new Error(value?.message || fallback);
    error.name = value?.name || 'Error';
    if (value?.code) error.code = value.code;
    if (value?.stack) error.remoteStack = value.stack;
    return error;
  }
  function serialized(error) {
    return { name: error?.name || 'Error', message: String(error?.message || error),
      code: error?.code, stack: error?.stack };
  }
  function makeStatus() {
    const buffer = new SharedArrayBuffer(statusBytes);
    Atomics.store(new Int32Array(buffer, 0, 4), 0, VERSION);
    return buffer;
  }
  function publishStatus(buffer, values) {
    if (values.length !== fields.length)
      throw new TypeError('Invalid runtime status');
    for (let i = 0; i < fields.length; ++i)
      if (!Number.isFinite(values[i])) throw new TypeError('Invalid runtime status');
    const header = new Int32Array(buffer, 0, 4), data = new Float64Array(buffer, 16, fields.length);
    if (Atomics.load(header, 0) !== VERSION) throw new Error('Runtime status version mismatch');
    Atomics.add(header, 1, 1);
    for (let i = 0; i < fields.length; ++i) data[i] = values[i];
    Atomics.add(header, 1, 1);
  }

  function createBridge(worker, options = {}) {
    const session = options.session || 'runtime-' + (++serial);
    const pending = new Map();
    let phase = 'connecting', started = false, nextId = 0, memory, heap, header, data;
    let lastSequence = -1, snapshot = new Float64Array(fields.length), scratch = new Float64Array(fields.length);
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // The UI also receives onFatal; keep startup failures from becoming an
    // unhandled rejection before its asynchronous loader attaches to ready.
    ready.catch(() => {});
    const readyTimer = setTimeout(() => fail(new Error('Worker runtime startup timed out')),
      options.readyTimeoutMs ?? 120000);

    function detach() {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    }
    function finish(error, failed) {
      if (phase === 'closed' || phase === 'failed') return;
      phase = failed ? 'failed' : 'closed';
      clearTimeout(readyTimer);
      detach();
      rejectReady(error);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      memory = heap = header = data = undefined;
      worker.terminate();
      if (failed) options.onFatal?.(error);
    }
    function fail(error) { finish(error, true); }
    function onError(event) {
      event.preventDefault?.();
      fail(new Error(event.message || 'Worker runtime crashed'));
    }
    function onMessageError() { fail(new Error('Worker runtime message could not be decoded')); }
    function onMessage(event) {
      const value = event.data;
      if (!value || value.session !== session || phase === 'closed' || phase === 'failed') return;
      if (value.type === 'ready') {
        if (phase !== 'connecting' || !started) return;
        if (value.version !== VERSION || !(value.memory instanceof WebAssembly.Memory) ||
            !(value.memory.buffer instanceof SharedArrayBuffer) ||
            !(value.status instanceof SharedArrayBuffer) || value.status.byteLength < statusBytes) {
          fail(new Error('Invalid worker runtime handshake'));
          return;
        }
        const incoming = new Int32Array(value.status, 0, 4);
        if (Atomics.load(incoming, 0) !== VERSION) {
          fail(new Error('Worker runtime status version mismatch'));
          return;
        }
        memory = value.memory;
        heap = new Uint8Array(memory.buffer);
        header = incoming;
        data = new Float64Array(value.status, 16, fields.length);
        phase = 'ready';
        clearTimeout(readyTimer);
        // A fulfilled promise retains its value. Keep the large shared heap
        // out of ready so close() can release it while the UI retains a bridge.
        const { memory: ignoredMemory, status: ignoredStatus, ...metadata } = value;
        resolveReady(metadata);
      } else if (value.type === 'reply') {
        const entry = pending.get(value.id);
        if (!entry) return;
        pending.delete(value.id);
        clearTimeout(entry.timer);
        if (value.error) entry.reject(errorFrom(value.error));
        else entry.resolve(value.result);
      } else if (value.type === 'fatal') fail(errorFrom(value.error));
      else if (value.type === 'event') options.onEvent?.(value.name, value.value);
    }
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);

    return {
      ready,
      get phase() { return phase; },
      get pendingCount() { return pending.size; },
      start(config, transfer = []) {
        if (started || phase !== 'connecting') throw new Error('Worker runtime already started');
        started = true;
        try { worker.postMessage({ type: 'init', session, config }, transfer); }
        catch (error) { fail(error); }
      },
      async request(method, args = [], transfer = []) {
        await ready;
        if (phase !== 'ready') throw new Error('Worker runtime is closed');
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            const error = new Error('Worker runtime request timed out: ' + method);
            error.code = 'RuntimeRequestTimeout'; error.method = method;
            // A timeout does not establish whether a stateful operation ran.
            // The UI must reconcile its result before offering a retry.
            error.outcome = 'unknown';
            reject(error);
          }, options.timeoutMs ?? 10000);
          pending.set(id, { resolve, reject, timer });
          try { worker.postMessage({ type: 'request', session, id, method, args }, transfer); }
          catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
      },
      notify(method, args = [], transfer = []) {
        if (phase !== 'ready') return false;
        worker.postMessage({ type: 'notify', session, method, args }, transfer);
        return true;
      },
      status(name) {
        if (!Object.hasOwn(indexes, name)) throw new Error('Unknown runtime status: ' + name);
        const index = indexes[name];
        if (!header) return 0;
        const sequence = Atomics.load(header, 1);
        if (sequence !== lastSequence && !(sequence & 1)) {
          for (let i = 0; i < fields.length; ++i) scratch[i] = data[i];
          if (sequence === Atomics.load(header, 1)) {
            const old = snapshot; snapshot = scratch; scratch = old; lastSequence = sequence;
          }
        }
        return snapshot[index];
      },
      heap() {
        if (!memory) throw new Error('Worker runtime is not ready');
        if (heap.byteLength !== memory.buffer.byteLength) heap = new Uint8Array(memory.buffer);
        return heap;
      },
      close(reason = 'Worker runtime stopped') {
        const error = new Error(reason); error.name = 'AbortError'; finish(error, false);
      },
    };
  }

  function installHost(scope, session, handlers, options = {}) {
    let closed = false;
    const send = scope.postMessage.bind(scope);
    const post = (value, transfer = []) => { if (!closed) send({ ...value, session }, transfer); };
    const onMessage = async event => {
      const message = event.data;
      if (closed || !message || message.session !== session ||
          !['request', 'notify'].includes(message.type)) return;
      try {
        if (!Object.hasOwn(handlers, message.method) || typeof handlers[message.method] !== 'function')
          throw new Error('Unknown worker runtime method: ' + message.method);
        const result = await handlers[message.method](...(message.args || []));
        if (message.type === 'request') {
          const transferred = result?.[transferTag];
          post({ type: 'reply', id: message.id, result: transferred ? result.value : result },
            transferred ? result.transfer : []);
        }
      } catch (error) {
        if (message.type === 'request') post({ type: 'reply', id: message.id, error: serialized(error) });
        else if (options.onNotifyError) options.onNotifyError(error);
        else post({ type: 'event', name: 'notify-error', value: serialized(error) });
      }
    };
    scope.addEventListener('message', onMessage);
    return {
      ready(payload, transfer = []) { post({ ...payload, type: 'ready', version: VERSION }, transfer); },
      event(name, value) { post({ type: 'event', name, value }); },
      fatal(error) { post({ type: 'fatal', error: serialized(error) }); },
      close() { closed = true; scope.removeEventListener('message', onMessage); },
    };
  }

  function transferResult(value, transfer) { return { [transferTag]: true, value, transfer }; }
  const api = { VERSION, fields, makeStatus, publishStatus, createBridge, installHost, transferResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ps2WorkerRuntime = api;
})(globalThis);
