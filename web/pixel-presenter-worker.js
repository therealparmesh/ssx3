// Keep frame presentation in a small realm, isolated from the Wasm runtime's
// garbage collection. Pixel ownership uses a fixed three-slot shared pool.
'use strict';
importScripts('./frame-clock.js');
(function(scope) {
  const VERSION = 1, FREE = 0, READY = 1, READING = 2, COUNT = 3;
  let initialized = false, running = false, stopped = false, paused = false, failed = false;
  let transport = scope;
  const send = message => transport.postMessage(message);
  let device, context, pipeline, sampler, texture, bundle, canvas, state, buffers, clock;
  let uploadBuffer, uploadDestination, uploadLayout, uploadSize, uploadSource;
  const attachment = { view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] };
  const passDescriptor = { colorAttachments: [attachment] };
  let format, textureWidth = 0, textureHeight = 0, primed = false, shown = 0;
  const frames = [], uploadViews = new Array(COUNT), commands = [null], bundles = [null];
  function failure(error) {
    if (stopped) return;
    stopped = failed = true; running = false;
    send({ type: 'failure', error: String(error?.message || error) });
  }
  scope.addEventListener('unhandledrejection', event => { event.preventDefault(); failure(event.reason); });
  scope.onmessage = event => {
    if (event.data?.type !== 'connect') return receive(event);
    try {
      if (initialized || transport !== scope || !(event.data.port instanceof MessagePort))
        throw new Error('Invalid presenter connection.');
      transport = event.data.port;
      transport.onmessage = receive;
      transport.start();
    } catch (error) { failure(error); }
  };
  async function receive({ data: message }) {
    try {
      if (stopped) return;
      if (message?.type === 'init') {
        if (initialized) throw new Error('Presenter already initialized.');
        initialized = true;
        if (message.version !== VERSION || message.buffers?.length !== COUNT ||
            !(message.slotState instanceof SharedArrayBuffer) || message.slotState.byteLength !== COUNT * 8)
          throw new Error('Invalid presenter initialization.');
        canvas = message.canvas; state = new Int32Array(message.slotState);
        buffers = message.buffers.map(buffer => {
          if (!(buffer instanceof SharedArrayBuffer)) throw new Error('Invalid pixel storage.');
          return new Uint8Array(buffer);
        });
        clock = ps2webFrameClock();
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: message.lowPower ? 'low-power' : 'high-performance' });
        if (stopped) return;
        if (!adapter) throw new Error('No graphics adapter is available for presentation.');
        const requestedDevice = await adapter.requestDevice();
        if (stopped) { requestedDevice.destroy(); return; }
        device = requestedDevice;
        device.lost.then(info => failure(new Error('The graphics connection was lost. ' + info.message)));
        device.addEventListener('uncapturederror', event => failure(event.error));
        context = canvas.getContext('webgpu'); format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'opaque' });
        const shader = device.createShaderModule({ code: `
          @group(0) @binding(0) var image: texture_2d<f32>;
          @group(0) @binding(1) var filtering: sampler;
          struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
          @vertex fn vs(@builtin(vertex_index) index: u32) -> Vertex {
            let uv = array<vec2f, 3>(vec2f(0, 0), vec2f(2, 0), vec2f(0, 2))[index];
            var out: Vertex; out.uv = uv; out.position = vec4f(uv.x * 2 - 1, 1 - uv.y * 2, 0, 1); return out;
          }
          @fragment fn fs(vertex: Vertex) -> @location(0) vec4f {
            return textureSample(image, filtering, vertex.uv);
          }` });
        pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' },
          fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
        sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        running = true; requestAnimationFrame(present);
        send({ type: 'ready', version: VERSION });
      } else if (message?.type === 'frame' && !stopped) {
        if (!Number.isInteger(message.id) || message.id < 0 || message.id >= COUNT ||
            !Number.isInteger(message.sequence) || message.sequence < 0 || message.sequence > 0xFFFFFFFF ||
            !Number.isInteger(message.width) || !Number.isInteger(message.height) ||
            message.width < 1 || message.height < 1 || message.width > 4096 || message.height > 4096)
          throw new Error('Invalid presenter frame.');
        if (message.buffer !== undefined) {
          if (!(message.buffer instanceof SharedArrayBuffer)) throw new Error('Invalid resized pixel storage.');
          buffers[message.id] = new Uint8Array(message.buffer); uploadViews[message.id] = undefined;
        }
        if (message.width * message.height * 4 > buffers[message.id].byteLength)
          throw new Error('Frame exceeds its pixel storage.');
        const old = frames.findIndex(frame => frame.id === message.id);
        if (old >= 0) frames.splice(old, 1);
        if (frames.length >= COUNT) throw new Error('Presenter queue exceeded its capacity.');
        frames.push(message);
      } else if (message?.type === 'pause') {
        paused = !!message.value; clock?.reset();
      } else if (message?.type === 'resize') {
        const { width, height } = message;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384)
          throw new Error('Invalid presentation size.');
        canvas.width = width; canvas.height = height;
      } else if (message?.type === 'stop') {
        stopped = true; running = false; paused = true;
        frames.length = 0;
        uploadBuffer?.destroy(); texture?.destroy(); device?.destroy(); context?.unconfigure();
        if (transport !== scope) transport.close();
      }
    } catch (error) { failure(error); }
  }
  function present(stamp) {
    if (stopped) return;
    try {
      if (paused) clock.reset();
      else {
        if (frames.length >= 2) primed = true;
        if (primed && clock.due(stamp)) {
          let frame;
          while (frames.length) {
            const candidate = frames.shift(), offset = candidate.id * 2;
            if ((Atomics.load(state, offset + 1) >>> 0) !== candidate.sequence) continue;
            if (Atomics.compareExchange(state, offset, READY, READING) !== READY) continue;
            // Revalidate after pinning: the producer could have replaced a
            // ready slot between our first version read and the CAS.
            if ((Atomics.load(state, offset + 1) >>> 0) !== candidate.sequence) {
              Atomics.store(state, offset, READY); continue;
            }
            frame = candidate; break;
          }
          if (frame) {
            draw(frame);
            ++shown; clock.presented(stamp);
            Atomics.store(state, frame.id * 2, FREE);
            send({ type: 'release', id: frame.id, sequence: frame.sequence,
              shown, refresh: clock.refreshInterval() });
          }
        }
      }
    } catch (error) { failure(error); }
    if (!stopped) requestAnimationFrame(present);
  }
  function draw(frame) {
    if (textureWidth !== frame.width || textureHeight !== frame.height) {
      uploadBuffer?.destroy(); uploadBuffer = undefined;
      texture?.destroy(); textureWidth = frame.width; textureHeight = frame.height;
      texture = device.createTexture({ size: [textureWidth, textureHeight], format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
      uploadDestination = { texture };
      uploadLayout = { bytesPerRow: textureWidth * 4, rowsPerImage: textureHeight };
      uploadSize = { width: textureWidth, height: textureHeight, depthOrArrayLayers: 1 };
      // Buffer-to-texture copies require aligned rows. Other widths retain
      // the ordinary texture upload, with the same pixels and filtering.
      if ((textureWidth * 4) % 256 === 0) {
        uploadBuffer = device.createBuffer({ size: textureWidth * textureHeight * 4,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        uploadSource = { buffer: uploadBuffer, bytesPerRow: textureWidth * 4, rowsPerImage: textureHeight };
      }
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }] });
      const encoder = device.createRenderBundleEncoder({ colorFormats: [format] });
      encoder.setPipeline(pipeline); encoder.setBindGroup(0, group); encoder.draw(3);
      bundle = encoder.finish(); bundles[0] = bundle;
    }
    const bytes = textureWidth * textureHeight * 4;
    if (!uploadViews[frame.id] || uploadViews[frame.id].byteLength !== bytes)
      uploadViews[frame.id] = buffers[frame.id].subarray(0, bytes);
    // Both upload calls snapshot the pinned shared pixels before returning.
    // Queue ordering lets the same upload buffer serve the following frame.
    if (uploadBuffer) device.queue.writeBuffer(uploadBuffer, 0, uploadViews[frame.id], 0, bytes);
    else device.queue.writeTexture(uploadDestination, uploadViews[frame.id], uploadLayout, uploadSize);
    const encoder = device.createCommandEncoder();
    if (uploadBuffer) encoder.copyBufferToTexture(uploadSource, uploadDestination, uploadSize);
    attachment.view = context.getCurrentTexture().createView();
    let pass;
    try { pass = encoder.beginRenderPass(passDescriptor); } finally { attachment.view = null; }
    const across = frame.wide ? 16 : 4, down = frame.wide ? 9 : 3;
    const scale = Math.min(canvas.width / across, canvas.height / down), width = scale * across, height = scale * down;
    pass.setViewport((canvas.width - width) / 2, (canvas.height - height) / 2, width, height, 0, 1);
    pass.executeBundles(bundles); pass.end();
    commands[0] = encoder.finish();
    try { device.queue.submit(commands); } finally { commands[0] = null; }
  }
  // Read-only state is useful to the browser QA observer; normal controls use
  // only the narrow init/frame/pause/resize protocol above.
  scope.ps2PixelPresenter = {
    get canvas() { return canvas; }, get paused() { return paused; },
    get running() { return running && !stopped; }, get failed() { return failed; },
    get pendingFrames() { return frames; }, get shown() { return shown; },
    get freeSlotCount() { let count = 0; if (state) for (let id = 0; id < COUNT; ++id) if (Atomics.load(state, id * 2) === FREE) ++count; return count; },
  };
})(self);
