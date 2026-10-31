addToLibrary({
  $ps2webglCreateReadbacks: function(gl) {
    var pending = new Map(), free = [], next = 1, closed = false;
    var stats = { enqueued: 0, collected: 0, canceled: 0, allocated: 0, peakBuffers: 0, polls: 0, pending: 0 };
    var release = function(record, reuse) {
      if (!record.active) return;
      record.active = false;
      pending.delete(record.id);
      stats.pending = pending.size;
      if (record.sync) gl.deleteSync(record.sync);
      record.sync = null;
      if (reuse && !closed && !gl.isContextLost()) free.push(record);
      else { gl.deleteBuffer(record.buffer); --stats.allocated; }
    };
    var bind = function(buffer, action) {
      var previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      try { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer); return action(); }
      finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous); }
    };
    var ready = function(record) {
      if (!record.active || closed) throw new Error('WebGL readback was canceled');
      if (gl.isContextLost()) throw new Error('The WebGL graphics connection was lost');
      var status = gl.clientWaitSync(record.sync, 0, 0);
      if (status === gl.WAIT_FAILED) throw new Error('WebGL readback fence failed');
      return status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED;
    };
    return {
      stats: stats,
      enqueue: function(x, y, width, height) {
        if (closed || gl.isContextLost()) throw new Error('WebGL readback is unavailable');
        var bytes = width * height * 4;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
            !Number.isSafeInteger(bytes) || bytes > 16 * 1024 * 1024)
          throw new Error('Invalid WebGL readback dimensions');
        if (pending.size >= 2) throw new Error('WebGL readback queue is full');
        var record = free.pop();
        if (!record) {
          var buffer = gl.createBuffer();
          if (!buffer) throw new Error('Could not allocate a WebGL readback buffer');
          record = { buffer: buffer, capacity: 0 };
          ++stats.allocated;
          stats.peakBuffers = Math.max(stats.peakBuffers, stats.allocated);
        }
        record.id = next++;
        if (next > 0x7fffffff) next = 1;
        record.active = true;
        record.bytes = bytes;
        pending.set(record.id, record);
        stats.pending = pending.size;
        try {
          bind(record.buffer, function() {
            // Retire the preceding GPU store before rewriting a reused
            // buffer. Drivers may retain its accelerated readback shadow.
            gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
            if (record.capacity !== bytes) {
              record.capacity = bytes;
              record.scratch = new Uint8Array(bytes);
            }
            var names = [gl.PACK_ALIGNMENT, gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS];
            var previous = names.map(function(name) { return gl.getParameter(name); });
            try {
              names.forEach(function(name, index) { gl.pixelStorei(name, index ? 0 : 4); });
              gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
            } finally { names.forEach(function(name, index) { gl.pixelStorei(name, previous[index]); }); }
          });
          record.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          if (!record.sync || gl.getError() !== gl.NO_ERROR) throw new Error('WebGL readback submission failed');
          gl.flush();
          ++stats.enqueued;
          return record.id;
        } catch (error) { release(record, false); throw error; }
      },
      collectNow: function(id, consume) {
        var record = pending.get(id), success = false;
        if (!record || record.collecting) throw new Error('Invalid WebGL readback ticket');
        try { if (!ready(record)) return false; }
        catch (error) { release(record, false); throw error; }
        record.collecting = true;
        try {
          bind(record.buffer, function() { gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, record.scratch); });
          if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL readback collection failed');
          consume(record.scratch); ++stats.collected; success = true; return true;
        } finally { record.collecting = false; release(record, success); }
      },
      collect: async function(id, consume) {
        var record = pending.get(id), success = false;
        if (!record || record.collecting) throw new Error('Invalid WebGL readback ticket');
        record.collecting = true;
        var deadline = performance.now() + 10000;
        try {
          if (!ready(record)) await new Promise(function(resolve, reject) {
            var poll = function() {
              try {
                ++stats.polls;
                if (ready(record)) { resolve(); return; }
                if (performance.now() >= deadline) throw new Error('WebGL readback timed out');
                setTimeout(poll, 0);
              } catch (error) { reject(error); }
            };
            setTimeout(poll, 0);
          });
          bind(record.buffer, function() {
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, record.scratch);
          });
          if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL readback collection failed');
          consume(record.scratch);
          ++stats.collected;
          success = true;
        } finally { record.collecting = false; release(record, success); }
      },
      cancel: function(id) {
        var record = pending.get(id);
        if (record) { ++stats.canceled; release(record, false); }
      },
      dispose: function() {
        if (closed) return;
        closed = true;
        for (var record of pending.values()) release(record, false);
        for (var record of free) { gl.deleteBuffer(record.buffer); --stats.allocated; }
        free.length = 0;
      },
    };
  },
});
