// Firefox can leave compute-only GPU map completion waiting for its coarse
// device poll. Empty submissions progress only pending READ maps, once per
// owning queue. Buffers created before installation keep their native path.
(function(root) {
  'use strict';
  function install(scope = globalThis, onFailure = () => {}) {
    const device = scope.GPUDevice.prototype, buffer = scope.GPUBuffer.prototype;
    const createBuffer = device.createBuffer, mapAsync = buffer.mapAsync;
    const owners = new WeakMap(), queues = new Map();
    const timers = new Set(), empty = Object.freeze([]);
    let stopped = false;
    function create(...args) {
      const result = createBuffer.apply(this, args);
      if (!stopped) owners.set(result, this.queue);
      return result;
    }
    function schedule(queue, state, delay) {
      if (stopped || !state.pending || state.timer !== null) return;
      const timer = scope.setTimeout(() => {
        timers.delete(timer);
        if (stopped || queues.get(queue) !== state || state.timer !== timer) return;
        state.timer = null;
        try { queue.submit(empty); }
        catch (error) { close(); onFailure(error); return; }
        // A submit hook can reentrantly stop us or register another map.
        schedule(queue, state, 4);
      }, delay);
      state.timer = timer; timers.add(timer);
    }
    function map(...args) {
      const result = mapAsync.apply(this, args);
      // Upload mappings progress with later command submissions and the final
      // frame readback. Polling each upload adds timers and empty submissions
      // while compute work is already being queued. GPUMapMode.READ is 1.
      if (stopped || !(args[0] & 1)) return result;
      const queue = owners.get(this);
      if (!queue) return result;
      let state = queues.get(queue);
      if (!state) { state = { pending: 0, timer: null }; queues.set(queue, state); }
      ++state.pending;
      schedule(queue, state, 1);
      return result.finally(() => {
        if (--state.pending || queues.get(queue) !== state) return;
        if (state.timer !== null) { scope.clearTimeout(state.timer); timers.delete(state.timer); }
        queues.delete(queue);
      });
    }
    function close() {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) scope.clearTimeout(timer);
      timers.clear(); queues.clear();
      if (device.createBuffer === create) device.createBuffer = createBuffer;
      if (buffer.mapAsync === map) buffer.mapAsync = mapAsync;
    }
    device.createBuffer = create; buffer.mapAsync = map;
    return { close, get pendingTimers() { return timers.size; } };
  }
  const api = { install };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ps2ReadbackProgress = api;
})(globalThis);
