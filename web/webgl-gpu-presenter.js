Module.webglDirectSurface =
  Module.webglDirectSurface ??
  (() => {
    const params = new URLSearchParams(location.search);
    return (
      params.has("direct") && !params.has("copy") && !params.has("nosurface")
    );
  })();
Module.webglGpuPresenter = (() => {
  let gl,
    tools,
    sourceSize = "",
    closed = false,
    raf = 0,
    listening = false,
    haltPrevious,
    haltHook;
  const jobs = new Set(),
    resources = new Map(),
    registered = new Map();
  function own(kind, object) {
    if (!object) throw new Error("Could not allocate WebGL " + kind);
    if (!resources.has(kind)) resources.set(kind, new Set());
    resources.get(kind).add(object);
    return object;
  }
  function drop(kind, object) {
    if (resources.get(kind)?.delete(object)) gl["delete" + kind](object);
  }
  // Resuming Wasm can throw. Retire the callback before invoking it.
  function finish(job, result) {
    if (job.settled) return;
    job.settled = true;
    jobs.delete(job);
    job.done(result);
  }
  function dispose() {
    if (closed) return;
    closed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (listening) {
      gl.canvas.removeEventListener("webglcontextlost", lost);
      globalThis.removeEventListener("pagehide", dispose);
      if (Module.onHalt === haltHook) Module.onHalt = haltPrevious;
      listening = false;
    }
    // Native capacity waits must also finish after their RAF is canceled.
    const externalWake = Module.surfaceYield;
    Module.surfaceYield = undefined;
    frames.length = 0;
    free.length = 0;
    Module.surfacePrimed = false;
    Module.surfaceClock?.reset();
    for (const [id, object] of registered)
      if (GL.framebuffers[id] === object) GL.framebuffers[id] = null;
    registered.clear();
    for (const [kind, objects] of resources)
      for (const object of objects) gl["delete" + kind](object);
    resources.clear();
    tools = null;
    let firstError;
    for (const job of Array.from(jobs)) {
      stats.canceled++;
      try {
        finish(job, 0);
      } catch (error) {
        firstError ||= error;
      }
    }
    if (externalWake && externalWake !== wakePending)
      queueMicrotask(externalWake);
    if (firstError) throw firstError;
  }
  function lost() {
    fail(new Error("Direct WebGL graphics connection lost"));
  }
  function wakePending() {
    if (closed) return;
    let firstError;
    for (const job of Array.from(jobs)) {
      if (
        free.length ||
        Module.paused ||
        Module.failed ||
        Module.stoppedForReload
      )
        try {
          submit(job);
        } catch (error) {
          firstError ||= error;
        }
    }
    if (jobs.size) Module.surfaceYield = wakePending;
    if (firstError) throw firstError;
  }
  const frames = [],
    free = [],
    stats = (Module.webglGpuStats = {
      produced: 0,
      presented: 0,
      canceled: 0,
      maximumQueued: 0,
      waits: 0,
    });
  const flags = () => [
    gl.BLEND,
    gl.DEPTH_TEST,
    gl.STENCIL_TEST,
    gl.CULL_FACE,
    gl.SCISSOR_TEST,
    gl.RASTERIZER_DISCARD,
    gl.DITHER,
  ];
  function run(action) {
    gl = Module.ps2WebglCanvas.getContext("webgl2");
    if (closed || gl.isContextLost())
      throw new Error("Direct WebGL graphics connection lost");
    if (!listening) {
      gl.canvas.addEventListener("webglcontextlost", lost);
      globalThis.addEventListener("pagehide", dispose);
      haltPrevious = Module.onHalt;
      haltHook = function (...args) {
        try {
          return haltPrevious?.apply(this, args);
        } finally {
          dispose();
        }
      };
      Module.onHalt = haltHook;
      listening = true;
    }
    // This context is shared with the native GS; restore its borrowed state.
    const names = flags(),
      state = {
        program: gl.getParameter(gl.CURRENT_PROGRAM),
        vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
        draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
        viewport: gl.getParameter(gl.VIEWPORT),
        active: gl.getParameter(gl.ACTIVE_TEXTURE),
        mask: gl.getParameter(gl.COLOR_WRITEMASK),
        unpack: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
        enabled: names.map((n) => gl.isEnabled(n)),
      };
    gl.activeTexture(gl.TEXTURE0);
    state.texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    state.sampler = gl.getParameter(gl.SAMPLER_BINDING);
    try {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.bindSampler(0, null);
      for (const n of names) gl.disable(n);
      gl.colorMask(true, true, true, true);
      init();
      gl.bindVertexArray(tools.vao);
      return action();
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.read);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.draw);
      if (gl.getParameter(gl.CURRENT_PROGRAM) !== state.program)
        gl.useProgram(
          state.program && gl.isProgram(state.program) ? state.program : null,
        );
      gl.bindVertexArray(state.vao);
      gl.viewport(...state.viewport);
      gl.colorMask(...state.mask);
      names.forEach((n, i) =>
        state.enabled[i] ? gl.enable(n) : gl.disable(n),
      );
      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      gl.bindSampler(0, state.sampler);
      gl.activeTexture(state.active);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, state.unpack);
    }
  }
  function init() {
    if (tools) return;
    try {
      const vertex = `#version 300 es
      void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`;
      const program = (fragment) => {
        const p = own("Program", gl.createProgram());
        for (const [kind, source] of [
          [gl.VERTEX_SHADER, vertex],
          [gl.FRAGMENT_SHADER, fragment],
        ]) {
          const s = own("Shader", gl.createShader(kind));
          gl.shaderSource(s, source);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(s));
          gl.attachShader(p, s);
          drop("Shader", s);
        }
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(p));
        return p;
      };
      const logical = program(`#version 300 es
      precision highp float;precision highp int;
      uniform sampler2D image;uniform ivec4 info;out vec4 color;
      void main(){ivec2 p=ivec2(gl_FragCoord.xy);int top=info.z-1-p.y;
        int sy=info.w==2?top:info.y-1-(info.w!=0?top/2:top);color=vec4(texelFetch(image,ivec2(p.x+(info.w==2?0:info.x),sy),0).rgb,1.0);}`);
      const present = program(`#version 300 es
      precision highp float;precision highp int;
      uniform sampler2D image;uniform ivec2 size;uniform ivec2 replication;
      uniform vec2 destination;uniform vec2 offset;out vec4 color;
      void main(){vec2 pixelMin=gl_FragCoord.xy-0.5;
        vec2 coverage=clamp(min(pixelMin+1.0,offset+destination)-max(pixelMin,offset),vec2(0),vec2(1));
        if(coverage.x==0.0||coverage.y==0.0){color=vec4(0,0,0,1);return;}
        ivec2 sharp=size*replication;vec2 p=(gl_FragCoord.xy-offset)/destination*vec2(sharp)-0.5;
        ivec2 a=ivec2(floor(p));vec2 f=fract(p);ivec2 lo=clamp(a,ivec2(0),sharp-1)/replication;
        ivec2 hi=clamp(a+1,ivec2(0),sharp-1)/replication;
        vec3 c=mix(mix(texelFetch(image,lo,0).rgb,texelFetch(image,ivec2(hi.x,lo.y),0).rgb,f.x),
          mix(texelFetch(image,ivec2(lo.x,hi.y),0).rgb,texelFetch(image,hi,0).rgb,f.x),f.y);
        color=vec4(c*coverage.x*coverage.y,1.0);}`);

      const source = own("Texture", gl.createTexture()),
        fbo = own("Framebuffer", gl.createFramebuffer());
      const id = GL.getNewId(GL.framebuffers);
      fbo.name = id;
      GL.framebuffers[id] = fbo;
      registered.set(id, fbo);
      tools = {
        source,
        fbo,
        id,
        logical,
        present,
        vao: own("VertexArray", gl.createVertexArray()),
      };
      tools.l = {
        image: gl.getUniformLocation(logical, "image"),
        info: gl.getUniformLocation(logical, "info"),
      };
      tools.p = {
        image: gl.getUniformLocation(present, "image"),
        size: gl.getUniformLocation(present, "size"),
        replication: gl.getUniformLocation(present, "replication"),
        destination: gl.getUniformLocation(present, "destination"),
        offset: gl.getUniformLocation(present, "offset"),
      };
      for (let i = 0; i < 3; i++)
        free.push({
          texture: own("Texture", gl.createTexture()),
          fbo: own("Framebuffer", gl.createFramebuffer()),
          size: "",
        });
      Module.surfaceFrames = frames;
      Module.surfaceClock = ps2webFrameClock();
      Module.surfacePrimed = false;
      raf = requestAnimationFrame(tick);
    } catch (error) {
      dispose();
      throw error;
    }
  }
  function allocate(texture, width, height) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  function source(width, height) {
    if (
      tools &&
      !closed &&
      sourceSize === `${width}:${height}` &&
      !gl.isContextLost()
    )
      return tools.id;
    try {
      return run(() => {
        if (sourceSize !== `${width}:${height}`) {
          allocate(tools.source, width, height);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, tools.fbo);
          gl.framebufferTexture2D(
            gl.DRAW_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            tools.source,
            0,
          );
          if (
            gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !==
            gl.FRAMEBUFFER_COMPLETE
          )
            throw new Error("Direct source framebuffer incomplete");
          sourceSize = `${width}:${height}`;
        }
        return tools.id;
      });
    } catch (error) {
      fail(error);
      throw error;
    }
  }
  function fail(error) {
    Module.webglGpuError ||= String(error);
    try {
      Module.onHalt?.(
        "The graphics connection was lost. Export your memory card, then reload.",
      );
    } finally {
      dispose();
    }
  }
  function enqueue(meta, done) {
    if (closed) {
      stats.canceled++;
      done(0);
      return;
    }
    if (jobs.size >= 2) throw new Error("Too many pending display submissions");
    if (!tools) {
      if (meta.pixels) source(meta.width, meta.height);
      else throw new Error("Display source was not prepared");
    }
    let input = meta;
    if (meta.pixels) {
      if (
        !(meta.pixels instanceof Uint8Array) ||
        !Number.isInteger(meta.width) ||
        !Number.isInteger(meta.height) ||
        meta.width < 1 ||
        meta.height < 1 ||
        meta.width > 2048 ||
        meta.height > 2048 ||
        meta.pixels.length !== meta.width * meta.height * 4
      )
        throw new Error("Invalid CPU display image");
      // Callers can reuse or grow Wasm storage while the queue is full.
      input = { ...meta, pixels: meta.pixels.slice() };
    }
    const job = { meta: input, done, settled: false };
    jobs.add(job);
    submit(job);
  }
  function submit(job) {
    if (job.settled) return;
    if (closed || Module.paused || Module.failed || Module.stoppedForReload) {
      stats.canceled++;
      finish(job, 0);
      return;
    }
    const frame = free.pop();
    if (!frame) {
      stats.waits++;
      Module.surfaceYield = wakePending;
      return;
    }
    const meta = job.meta;
    try {
      run(() => {
        Object.assign(frame, {
          width: meta.width,
          height: meta.height,
          wide: meta.wide,
        });
        if (meta.pixels) {
          if (sourceSize !== `${meta.width}:${meta.height}`) {
            allocate(tools.source, meta.width, meta.height);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, tools.fbo);
            gl.framebufferTexture2D(
              gl.DRAW_FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              gl.TEXTURE_2D,
              tools.source,
              0,
            );
            if (
              gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !==
              gl.FRAMEBUFFER_COMPLETE
            )
              throw new Error("CPU source framebuffer incomplete");
            sourceSize = `${meta.width}:${meta.height}`;
          }
          const names = [
              gl.UNPACK_ALIGNMENT,
              gl.UNPACK_ROW_LENGTH,
              gl.UNPACK_SKIP_PIXELS,
              gl.UNPACK_SKIP_ROWS,
              gl.UNPACK_FLIP_Y_WEBGL,
              gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
              gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
            ],
            previous = names.map((n) => gl.getParameter(n));
          try {
            const values = [4, 0, 0, 0, false, false, gl.NONE];
            names.forEach((n, i) => gl.pixelStorei(n, values[i]));
            gl.bindTexture(gl.TEXTURE_2D, tools.source);
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              meta.width,
              meta.height,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              meta.pixels,
            );
          } finally {
            names.forEach((n, i) => gl.pixelStorei(n, previous[i]));
          }
        }
        if (frame.size !== `${meta.width}:${meta.height}`) {
          allocate(frame.texture, meta.width, meta.height);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frame.fbo);
          gl.framebufferTexture2D(
            gl.DRAW_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            frame.texture,
            0,
          );
          if (
            gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !==
            gl.FRAMEBUFFER_COMPLETE
          )
            throw new Error("Direct frame framebuffer incomplete");
          frame.size = `${meta.width}:${meta.height}`;
        }
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frame.fbo);
        gl.viewport(0, 0, meta.width, meta.height);
        gl.useProgram(tools.logical);
        gl.bindTexture(gl.TEXTURE_2D, tools.source);
        gl.uniform1i(tools.l.image, 0);
        gl.uniform4i(
          tools.l.info,
          meta.x,
          meta.physical,
          meta.height,
          meta.pixels ? 2 : meta.physical < meta.height ? 1 : 0,
        );
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (gl.getError()) throw new Error("Direct logical resolve failed");
      });
    } catch (error) {
      if (!closed) free.push(frame);
      try {
        fail(error);
      } finally {
        finish(job, 0);
      }
      return;
    }
    frames.push(frame);
    stats.produced++;
    stats.maximumQueued = Math.max(stats.maximumQueued, frames.length);
    finish(job, 1);
  }
  function draw(frame) {
    run(() => {
      const width = Module.canvas.width,
        height = Module.canvas.height,
        across = frame.wide ? 16 : 4,
        down = frame.wide ? 9 : 3,
        scale = Math.min(width / across, height / down),
        w = scale * across,
        h = scale * down,
        ox = (width - w) / 2,
        oy = (height - h) / 2;
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.viewport(0, 0, width, height);
      gl.useProgram(tools.present);
      gl.bindTexture(gl.TEXTURE_2D, frame.texture);
      gl.uniform1i(tools.p.image, 0);
      gl.uniform2i(tools.p.size, frame.width, frame.height);
      gl.uniform2i(
        tools.p.replication,
        Math.max(1, Math.floor(w / frame.width)),
        Math.max(1, Math.floor(h / frame.height)),
      );
      gl.uniform2f(tools.p.destination, w, h);
      gl.uniform2f(tools.p.offset, ox, oy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (gl.getError()) throw new Error("Direct canvas presentation failed");
    });
  }
  function tick(now) {
    raf = 0;
    if (closed) return;
    if (Module.failed || Module.stoppedForReload) {
      dispose();
      return;
    }
    if (!Module.paused && !Module.failed && !Module.stoppedForReload) {
      if (frames.length >= 2) Module.surfacePrimed = true;
      const frame =
        Module.surfacePrimed && Module.surfaceClock.due(now) && frames.shift();
      if (frame) {
        try {
          draw(frame);
          Module.surfaceClock.presented(now);
          Module.surfacePresentedAt = performance.now();
          stats.presented++;
          Module.onPresent?.();
        } catch (error) {
          fail(error);
        } finally {
          if (!closed) free.push(frame);
        }
      }
    } else Module.surfaceClock.reset();
    if (!closed) raf = requestAnimationFrame(tick);
    const wake = Module.surfaceYield;
    Module.surfaceYield = undefined;
    if (wake) queueMicrotask(wake);
  }
  return {
    source,
    enqueue,
    stats,
    dispose,
    get closed() {
      return closed;
    },
  };
})();
