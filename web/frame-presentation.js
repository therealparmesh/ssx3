addToLibrary({
  $ps2webSubmitCommand: function(queue, command) {
    // Web IDL consumes the sequence during submit(). Borrow its array only
    // for that call; a reentrant submission receives a separate array.
    var commands = Module.singleCommandSubmission || [null];
    Module.singleCommandSubmission = null;
    try {
      commands[0] = command;
      queue.submit(commands);
    } finally {
      // An idle argument array must not retain a submitted GPU command buffer.
      commands[0] = null;
      if (!Module.singleCommandSubmission) Module.singleCommandSubmission = commands;
    }
  },
  $ps2webFrameClock: function() {
    var period = 1000 / 60;
    var next = 0, lastRefresh = 0, refreshPeriod = 0;
    var sampleTime = 0, sampleTicks = 0, ticksSincePresented = 0, followDisplay = false;
    var haveAverage = false;
    return {
      refreshInterval: function() { return refreshPeriod || period; },
      due: function(now) {
        var elapsed = now - lastRefresh;
        lastRefresh = now;
        var ticks = 1;
        if (elapsed > 0 && elapsed < period * 2) {
          if (!refreshPeriod) refreshPeriod = elapsed;
          ticks = Math.max(1, Math.round(elapsed / refreshPeriod));
          sampleTime += elapsed;
          sampleTicks += ticks;
          if (sampleTicks >= 16) {
            // Firefox timestamps can vary by ~1 ms at a steady refresh rate.
            // Average several refreshes before selecting a display multiple.
            var measured = sampleTime / sampleTicks;
            // A short burst of late/early timestamps must not repeatedly
            // switch a steady 120 Hz display into fractional pacing.
            // Adopt a real display-rate change promptly, while damping
            // smaller timestamp fluctuations within the same display mode.
            refreshPeriod = !haveAverage || Math.abs(measured - refreshPeriod) > refreshPeriod * 0.1
              ? measured : refreshPeriod * 0.75 + measured * 0.25;
            haveAverage = true;
            sampleTime = sampleTicks = 0;
          }
        } else {
          sampleTime = sampleTicks = 0;
          if (elapsed >= period * 2) {
            refreshPeriod = next = 0;
            haveAverage = false;
          }
        }
        ticksSincePresented += ticks;
        var multiple = Math.max(1, Math.round(period / refreshPeriod));
        followDisplay = refreshPeriod > 0 && (refreshPeriod >= period - 0.25 || Math.abs(multiple * refreshPeriod - period) < 0.25);
        // Count refreshes near 60/120/180/240 Hz. Absolute 60 Hz deadlines
        // would periodically add a refresh on a nominal 120.005 Hz display.
        return followDisplay ? ticksSincePresented >= multiple : now + 0.5 >= next;
      },
      presented: function(now) {
        // Preserve fractional deadlines at rates such as 90/144 Hz. Rounding
        // every deadline up to a refresh would turn 60 fps into 48 at 144 Hz.
        // Restart after a pause/stall rather than draining images in a burst.
        next = followDisplay || !next || now - next >= period
          ? now + period : next + period;
        ticksSincePresented = 0;
      },
      reset: function() {
        next = lastRefresh = refreshPeriod = sampleTime = sampleTicks = ticksSincePresented = 0;
        haveAverage = false;
      },
    };
  },
});
