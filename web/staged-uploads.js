addToLibrary({
  $ps2webUploadBuffers: function(device) {
    var records = [], ready = [], allocated = 0, closed = false;
    var budget = 16 * 1024 * 1024, maximum = 2 * 1024 * 1024;
    var stats = { staged: 0, bytes: 0, fallback: 0, maps: 0, failures: 0, allocatedBytes: 0, buffers: 0, retired: 0 };
    var dispose = function() {
      if (closed) return;
      closed = true;
      ready.length = 0;
      for (var record of records) if (record) record.buffer.destroy();
    };
    var fail = function() { if (!closed) { ++stats.failures; dispose(); } };
    device.lost.then(dispose, dispose);
    return {
      stats: stats,
      dispose: dispose,
      stage: function(encoder, dataTarget, paramsTarget, heap, data, dataBytes, params, paramsBytes) {
        var total = dataBytes + paramsBytes;
        if (closed || !total || total > maximum) { ++stats.fallback; return 0; }
        var best = -1;
        for (var i = 0; i < ready.length; ++i)
          if (ready[i].capacity >= total && (best < 0 || ready[i].capacity < ready[best].capacity)) best = i;
        var record;
        if (best >= 0) {
          record = ready[best];
          ready[best] = ready[ready.length - 1];
          ready.pop();
        } else {
          var capacity = Math.pow(2, Math.ceil(Math.log2(Math.max(65536, total))));
          if (allocated + capacity > budget) {
            // Cold boot can fill the budget with small uploads. Reclaim only
            // completed, mapped buffers so later size classes can still fit.
            var reclaimable = 0;
            for (var free of ready) reclaimable += free.capacity;
            if (allocated + capacity - reclaimable > budget) { ++stats.fallback; return 0; }
            while (allocated + capacity > budget) {
              var largest = 0;
              for (var i = 1; i < ready.length; ++i)
                if (ready[i].capacity > ready[largest].capacity) largest = i;
              var retired = ready[largest];
              ready[largest] = ready[ready.length - 1];
              ready.pop();
              retired.buffer.destroy();
              records[retired.token - 1] = null;
              allocated -= retired.capacity;
              --stats.buffers;
              ++stats.retired;
            }
            stats.allocatedBytes = allocated;
          }
          var slot = 0;
          while (slot < records.length && records[slot]) ++slot;
          device.pushErrorScope('out-of-memory');
          try {
            var buffer = device.createBuffer({ size: capacity, usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
            record = { buffer: buffer, capacity: capacity, token: slot + 1 };
          } catch (_) {
            if (buffer) buffer.destroy();
            fail();
            ++stats.fallback;
            return 0;
          } finally {
            device.popErrorScope().then(function(error) { if (error) fail(); }, fail);
          }
          records[slot] = record;
          allocated += capacity;
          stats.allocatedBytes = allocated;
          ++stats.buffers;
        }
        // Reused size classes can be much larger than this upload. Expose only
        // its bytes, without creating mapped ArrayBuffers while a slot is idle.
        try {
          var view = new Uint8Array(record.buffer.getMappedRange(0, total));
          view.set(heap.subarray(data, data + dataBytes), 0);
          view.set(heap.subarray(params, params + paramsBytes), dataBytes);
          record.buffer.unmap();
        } catch (_) { fail(); ++stats.fallback; return 0; }
        record.queued = true;
        if (dataBytes) encoder.copyBufferToBuffer(record.buffer, 0, dataTarget, 0, dataBytes);
        if (paramsBytes) encoder.copyBufferToBuffer(record.buffer, dataBytes, paramsTarget, 0, paramsBytes);
        ++stats.staged;
        stats.bytes += total;
        return record.token;
      },
      submitted: function(token) {
        var record = records[token - 1];
        if (closed || !record || !record.queued) return;
        record.queued = false;
        // Mapping starts after queue.submit: pending mappings cannot be used
        // by a command buffer. Reuse only after the GPU has finished its copy.
        try {
          record.buffer.mapAsync(GPUMapMode.WRITE).then(function() {
            if (closed) return;
            ++stats.maps;
            ready.push(record);
          }).catch(fail);
        } catch (_) { fail(); }
      },
    };
  },
});
