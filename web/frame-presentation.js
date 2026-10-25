addToLibrary({
  $ps2webFrameClock: function() {
    var period = 1000 / 60;
    var next = 0, lastRefresh = 0, refreshPeriod = 0;
    var sampleTime = 0, sampleTicks = 0, ticksSincePresented = 0, followDisplay = false;
    return {
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
            refreshPeriod = sampleTime / sampleTicks;
            sampleTime = sampleTicks = 0;
          }
        } else {
          sampleTime = sampleTicks = 0;
          if (elapsed >= period * 2) refreshPeriod = next = 0;
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
      },
    };
  },
});
