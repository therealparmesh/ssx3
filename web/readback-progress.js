// Firefox can leave compute-only GPU map completion waiting for its coarse
// device poll. Empty submissions progress only maps that are still pending.
(function(root) {
  'use strict';
  function install(scope = globalThis, onFailure = () => {}) {
    const adapter = scope.GPUAdapter.prototype, buffer = scope.GPUBuffer.prototype;
    const requestDevice = adapter.requestDevice, mapAsync = buffer.mapAsync;
    const timers = new Set(), empty = Object.freeze([]);
    let stopped = false, queue;
    async function request(...args) {
      const device = await requestDevice.apply(this, args);
      if (!stopped) queue = device.queue;
      return device;
    }
    function map(...args) {
      const result = mapAsync.apply(this, args);
      if (stopped) return result;
      let pending = true, timer;
      const poll = () => {
        timers.delete(timer);
        if (!pending || stopped) return;
        try { queue?.submit(empty); }
        catch (error) { close(); onFailure(error); return; }
        if (stopped || !pending) return;
        timer = scope.setTimeout(poll, 4); timers.add(timer);
      };
      timer = scope.setTimeout(poll, 1); timers.add(timer);
      return result.finally(() => {
        pending = false; scope.clearTimeout(timer); timers.delete(timer);
      });
    }
    function close() {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) scope.clearTimeout(timer);
      timers.clear(); queue = undefined;
      if (adapter.requestDevice === request) adapter.requestDevice = requestDevice;
      if (buffer.mapAsync === map) buffer.mapAsync = mapAsync;
    }
    adapter.requestDevice = request; buffer.mapAsync = map;
    return { close, get pendingTimers() { return timers.size; } };
  }
  const api = { install };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ps2ReadbackProgress = api;
})(globalThis);
