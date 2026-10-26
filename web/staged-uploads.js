addToLibrary({
  $ps2webUploadBuffers: function(device) {
    var records = [], ready = [], allocated = 0, closed = false;
    var budget = 16 * 1024 * 1024, maximum = 2 * 1024 * 1024;
    var stats = { staged: 0, bytes: 0, fallback: 0, maps: 0, failures: 0, allocatedBytes: 0, buffers: 0 };
    var dispose = function() {
      if (closed) return;
      closed = true;
      ready.length = 0;
      for (var record of records) record.buffer.destroy();
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
          if (allocated + capacity > budget) { ++stats.fallback; return 0; }
          device.pushErrorScope('out-of-memory');
          try {
            var buffer = device.createBuffer({ size: capacity, usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
            record = { buffer: buffer, view: new Uint8Array(buffer.getMappedRange()), capacity: capacity, token: records.length + 1 };
          } catch (_) {
            if (buffer) buffer.destroy();
            fail();
            ++stats.fallback;
            return 0;
          } finally {
            device.popErrorScope().then(function(error) { if (error) fail(); }, fail);
          }
          records.push(record);
          allocated += capacity;
          stats.allocatedBytes = allocated;
          stats.buffers = records.length;
        }
        record.view.set(heap.subarray(data, data + dataBytes), 0);
        record.view.set(heap.subarray(params, params + paramsBytes), dataBytes);
        record.buffer.unmap();
        record.view = null;
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
            record.view = new Uint8Array(record.buffer.getMappedRange());
            ++stats.maps;
            ready.push(record);
          }).catch(fail);
        } catch (_) { fail(); }
      },
    };
  },
});
