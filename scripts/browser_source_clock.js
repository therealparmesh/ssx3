// QA only: compare native fields with source audio, not resampled output counts.
(function(root) {
  const minimumRatio = 0.995, maximumRatio = 1.005;
  const lookahead = 48, limiterBlock = 32, publicationMargin = 32;
  function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
      throw new Error('Invalid source-clock ' + name);
    return value;
  }
  function capture(Module, memory) {
    const ring = new Int32Array(memory.buffer, Module._ps2web_audio_ring(), 4);
    const frameBefore = Module._ps2web_frames();
    const sourceBefore = Module._ps2web_audio_rate_stats(0);
    const writeBefore = Atomics.load(ring, 0) >>> 0;
    // All bounds refer to this read-counter instant. The surrounding writes,
    // source counts and fields bracket concurrent producer progress.
    const read = Atomics.load(ring, 1) >>> 0;
    const writeAfter = Atomics.load(ring, 0) >>> 0;
    const sourceAfter = Module._ps2web_audio_rate_stats(0);
    const frameAfter = Module._ps2web_frames();
    return {frameBefore, frameAfter, sourceBefore, sourceAfter, writeBefore, read, writeAfter,
      capacity: Atomics.load(ring, 2) >>> 0, active: Atomics.load(ring, 3)};
  }
  function bounds(s) {
    for (const name of ['frameBefore', 'frameAfter', 'sourceBefore', 'sourceAfter']) integer(s[name], name);
    for (const name of ['writeBefore', 'read', 'writeAfter']) integer(s[name], name, 0xffffffff);
    integer(s.capacity, 'capacity', 0x7fffffff);
    if (!s.capacity || s.active !== 1 || s.sourceBefore < 256 ||
        s.sourceAfter < s.sourceBefore || s.frameAfter < s.frameBefore ||
        ((s.writeAfter - s.writeBefore) >>> 0) >= 0x80000000)
      throw new Error('Unordered or inactive source-clock observation');
    if (((s.writeAfter - s.read) >>> 0) >= 0x80000000)
      throw new Error('Invalid source-clock write/read ordering');
    const writeAdvance = (s.writeAfter - s.writeBefore) >>> 0;
    if (writeAdvance > Math.ceil((s.sourceAfter - s.sourceBefore + 64) * maximumRatio) + 64)
      throw new Error('Inconsistent source-clock publication');
    const queuedMin = Math.max(0, (s.writeBefore - s.read) | 0);
    // At the read instant the real queue cannot exceed its fixed capacity.
    const queuedMax = Math.min(s.capacity, (s.writeAfter - s.read) >>> 0);
    if (queuedMin > queuedMax) throw new Error('Inconsistent source-clock queue');
    // The source statistic follows ring-write publication by at most one
    // 32-input packet. Keep a margin on both sides, plus PCM rounding margin.
    const lower = s.sourceBefore - 1 - (lookahead + 2) -
      (queuedMax + 2 * limiterBlock - 1) / minimumRatio - 1 - publicationMargin;
    const upper = s.sourceAfter - 1 - (lookahead - 1) -
      (queuedMin + limiterBlock) / maximumRatio + 1 + publicationMargin;
    return {lower, upper, queuedMin, queuedMax};
  }
  function compare(start, end, frequency = 60) {
    if (frequency !== 50 && frequency !== 60) throw new Error('Unsupported source-clock field rate');
    const a = bounds(start), b = bounds(end);
    if (end.frameBefore <= start.frameAfter || end.sourceBefore <= start.sourceAfter)
      throw new Error('Source-clock window moved backwards');
    const readAdvance = (end.read - start.read) >>> 0;
    const sourceAdvance = end.sourceAfter - start.sourceBefore;
    if (!readAdvance || readAdvance >= 0x80000000 ||
        readAdvance > Math.ceil((sourceAdvance + 64) * maximumRatio) + start.capacity)
      throw new Error('Invalid source-clock consumption window');
    const videoElapsedMs = {
      lower: (end.frameBefore - start.frameAfter) * 1000 / frequency,
      upper: (end.frameAfter - start.frameBefore) * 1000 / frequency,
    };
    const sourceElapsedMs = {lower: (b.lower - a.upper) / 48, upper: (b.upper - a.lower) / 48};
    const differenceMs = {
      lower: videoElapsedMs.lower - sourceElapsedMs.upper,
      upper: videoElapsedMs.upper - sourceElapsedMs.lower,
    };
    return {start: a, end: b, videoElapsedMs, sourceElapsedMs, differenceMs,
      passed: differenceMs.lower > -50 && differenceMs.upper < 50, toleranceMs: 50};
  }
  const api = {capture, bounds, compare};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ssx3SourceClock = api;
})(globalThis);
