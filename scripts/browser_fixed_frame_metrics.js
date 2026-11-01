// QA only: observe copy presentation and worklet output at native field boundaries.
(function(root) {
  async function measure({Module, memory, audioContext, qa, first, last, timeoutMs = 120000}) {
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last <= first)
      throw Error('Invalid fixed native-frame window');
    if (!qa.processorInstrumented) throw Error('Audio worklet instrumentation required');
    if (Module._ps2web_frames() >= first)
      throw Error('Fixed window must be armed before frame ' + first);
    const ints = new Int32Array(qa.buffer, 0, 16), sums = new Float64Array(qa.buffer, 128, 8);
    const originalFrame = Module.onFrame, originalPresent = Module.onPresent;
    const times = [], audioSamples = [];
    const capture = () => ({
      time: performance.now(), audioTime: audioContext.currentTime,
      frame: Module._ps2web_frames(),
      sourceClock: root.ssx3SourceClock.capture(Module, memory),
    });
    let phase = 'waiting', start, end, before, after, deadline;
    Module.onPresent = function(...args) {
      if (phase === 'running') {
        times.push(performance.now());
        audioSamples.push(Module.audioQueuedMs());
      }
      return originalPresent.apply(Module, args);
    };
    try {
      await new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(Error('Fixed native-frame window timeout')), timeoutMs);
        Module.onFrame = function(...args) {
          try {
            const result = originalFrame.apply(Module, args), frame = Module._ps2web_frames();
            // Capture inside the callback: a promise continuation can run after
            // the emulator advances another field before yielding to the host.
            if (phase === 'waiting' && frame >= first) {
              if (frame !== first) throw Error('Skipped starting frame ' + frame);
              ints.fill(0); sums.fill(0); ints[8] = 0x7fffffff;
              before = {...Module.ps2OrderedRaster.stats};
              start = capture(); phase = 'running'; Atomics.store(ints, 0, 1);
            } else if (phase === 'running' && frame >= last) {
              Atomics.store(ints, 0, 0);
              end = capture(); after = {...Module.ps2OrderedRaster.stats}; phase = 'done';
              if (frame !== last) throw Error('Skipped ending frame ' + frame);
              resolve();
            }
            return result;
          } catch (error) {
            phase = 'done'; reject(error);
          }
        };
      });
    } finally {
      clearTimeout(deadline);
      Module.onFrame = originalFrame; Module.onPresent = originalPresent;
      Atomics.store(ints, 0, 0);
    }
    // Retire any quantum already processing when the flag was cleared.
    await new Promise(resolve => setTimeout(resolve, 10));
    const ms = end.time - start.time, gaps = times.slice(1).map((time, i) => time - times[i]);
    return {
      first, last, ms, images: times.length, fps: times.length * 1000 / ms,
      nativeFrames: end.frame - start.frame, nativeFps: (end.frame - start.frame) * 1000 / ms,
      maxGap: gaps.reduce((maximum, gap) => Math.max(maximum, gap), 0),
      over25: gaps.filter(gap => gap > 25).length,
      minAudio: audioSamples.reduce((minimum, value) => Math.min(minimum, value), Infinity),
      statsDelta: Object.fromEntries(Object.keys(after).map(key => [key, after[key] - (before[key] || 0)])),
      av: {
        start, end, sampleRate: audioContext.sampleRate, frames: ints[2], quanta: ints[1],
        underrunFrames: ints[3], underrunQuanta: ints[4], nativeFramesConsumed: ints[12],
        minimumQueuedFrames: ints[8], peak: ints[5] / 32768,
      },
      times, gaps,
    };
  }
  root.ssx3MeasureFixedFrames = measure;
})(globalThis);
