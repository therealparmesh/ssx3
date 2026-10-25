// JSPI calls must be allowed to unwind before a discarded document loses its
// event loop. A never-settled suspension can otherwise retain the old Wasm heap.
// Asyncify and the synchronous game workers keep their existing import paths.
#if JSPI
addToLibrary({
  $ps2JspiLifecycle__deps: ['$Asyncify', '$PThread', 'pthread_self', '__set_thread_state'],
  $ps2JspiLifecycle__force: true,
  $ps2JspiLifecycle__postset: 'ps2JspiLifecycle();',
  $ps2JspiLifecycle: () => {
    if (ENVIRONMENT_IS_PTHREAD) return;
    const pending = new Set();
    const reason = new Error('Player runtime discarded');
    let stopped = false;
    const cancel = () => {
      if (stopped) return;
      stopped = true;
      Module['stoppedForReload'] = true;
      for (const reject of pending) reject(reason);
      pending.clear();
    };
    const stop = () => {
      cancel();
      Module['running'] = false;
      Module['paused'] = true;
      const thread = _pthread_self();
      if (thread) {
        ___set_thread_state(0, 0, 0, 1);
        PThread.clearMailboxAwait(thread);
      }
      // The document will dispose its workers on navigation. Force-terminating
      // a worker inside Wasm can report uncaught exceptions in Firefox.
    };
    Module['stopJspiRuntime'] = stop;
    const instrument = Asyncify.instrumentWasmImports;
    // Use the same configured import selection as Emscripten's JSPI wrapper.
    const pattern = {{{ new RegExp(`^(${ASYNCIFY_IMPORTS_EXCEPT_JS_LIBS.map(x => x.split('.')[1]).join('|').replace(/\*/g, '.*')})$`) }}};
    Asyncify.instrumentWasmImports = (imports) => {
      for (const [name, original] of Object.entries(imports)) {
        if (typeof original !== 'function' || !(original.isAsync || pattern.test(name))) continue;
        // Indirect-call bridges already propagate their leaf import's result.
        // Cancelling both layers would resume nested JSPI activations separately.
        if (name.startsWith('invoke_')) continue;
        const wrapped = function(...args) {
          if (stopped) return Promise.reject(reason);
          const value = original.apply(this, args);
          if (!value || typeof value.then !== 'function') return value;
          let reject;
          const cancelled = new Promise((_, rejectWait) => { reject = rejectWait; });
          pending.add(reject);
          return Promise.race([value, cancelled]).finally(() => pending.delete(reject));
        };
        Object.assign(wrapped, original);
        imports[name] = wrapped;
      }
      return instrument(imports);
    };
    window.addEventListener('pagehide', (event) => {
      // A cached document is frozen for a later return, rather than discarded.
      if (event.persisted) return;
      if (Module['_ps2web_frames']) stop();
      else cancel();
    });
  },
});
#endif
