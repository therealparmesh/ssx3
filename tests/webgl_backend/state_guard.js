// Test-only observer. Never included in the player or used for performance gates.
(() => {
  const report = (globalThis.ssx3GlStateGuard = {
    errors: [],
    lastPreparedImage: 0,
    checks: { depth: 0, texture: 0, sampler: 0 },
    installed: false,
  });
  const contexts = new WeakMap();
  function state(gl) {
    let value = contexts.get(gl);
    if (!value) {
      value = {
        active: 0, textures: new Map(), samplers: new Map(),
        draw: null, read: null, attachments: new Map(),
      };
      contexts.set(gl, value);
    }
    return value;
  }
  function note(kind, detail = {}) {
    if (report.errors.length < 32)
      report.errors.push({ kind, lastPreparedImage: report.lastPreparedImage, ...detail });
  }
  const prototype = WebGL2RenderingContext.prototype;
  function wrap(name, observe) {
    const native = prototype[name];
    if (typeof native !== "function") throw Error("Missing GL method " + name);
    const wrapper = function (...args) {
      const result = native.apply(this, args);
      observe(state(this), args);
      return result;
    };
    Object.defineProperties(wrapper, {
      name: { value: native.name }, length: { value: native.length },
    });
    Object.defineProperty(prototype, name, {
      ...(Object.getOwnPropertyDescriptor(prototype, name) || {}),
      value: wrapper, writable: true, configurable: true,
    });
  }
  wrap("activeTexture", (s, a) => { s.active = a[0] - 0x84c0; });
  wrap("bindTexture", (s, a) => {
    if (a[0] === 0x0de1) s.textures.set(s.active, a[1]);
  });
  wrap("deleteTexture", (s, a) => {
    for (const [unit, value] of s.textures)
      if (value === a[0]) s.textures.set(unit, null);
  });
  wrap("bindSampler", (s, a) => s.samplers.set(a[0], a[1]));
  wrap("deleteSampler", (s, a) => {
    for (const [unit, value] of s.samplers)
      if (value === a[0]) s.samplers.set(unit, null);
  });
  wrap("bindFramebuffer", (s, a) => {
    if (a[0] === 0x8d40 || a[0] === 0x8ca9) s.draw = a[1];
    if (a[0] === 0x8d40 || a[0] === 0x8ca8) s.read = a[1];
  });
  function attach(s, args) {
    const framebuffer = args[0] === 0x8ca8 ? s.read : s.draw;
    let attachments = s.attachments.get(framebuffer);
    if (!attachments) {
      attachments = new Map();
      s.attachments.set(framebuffer, attachments);
    }
    attachments.set(args[1], args[3]);
    if (args[1] === 0x821a) attachments.set(0x8d00, args[3]);
  }
  wrap("framebufferRenderbuffer", attach);
  wrap("framebufferTexture2D", attach);
  wrap("deleteFramebuffer", (s, a) => {
    s.attachments.delete(a[0]);
    if (s.draw === a[0]) s.draw = null;
    if (s.read === a[0]) s.read = null;
  });
  report.install = function () {
    if (report.installed) throw Error("GL state guard already installed");
    const bridge = globalThis.Ps2OrderedRaster?.prototype;
    if (!bridge) throw Error("GL state guard requires the ordered WebGL bridge");
    const { render, bindTextureUnit, bindSamplerUnit } = bridge;
    if (typeof render !== "function") throw Error("Missing ordered render entry point");
    report.capabilities = {
      depth: true,
      texture: typeof bindTextureUnit === "function",
      sampler: typeof bindSamplerUnit === "function",
    };
    bridge.render = function (packet) {
      const attachments = state(this.gl).attachments.get(packet.targetFramebuffer);
      report.checks.depth++;
      if (!attachments || attachments.get(this.gl.DEPTH_ATTACHMENT) !== packet.depthRenderbuffer)
        note("target-depth-attachment", { known: !!attachments });
      return render.call(this, packet);
    };
    if (report.capabilities.texture) bridge.bindTextureUnit = function (unit, texture, upload) {
      if (this.reservedTextureUnits && unit >= 3 && unit <= 14 &&
          this.textureBindings[unit] === texture) {
        report.checks.texture++;
        if ((state(this.gl).textures.get(unit) || null) !== (texture || null))
          note("cached-texture-binding", { unit });
      }
      return bindTextureUnit.call(this, unit, texture, upload);
    };
    if (report.capabilities.sampler) bridge.bindSamplerUnit = function (unit, sampler) {
      if (this.reservedTextureUnits && unit >= 3 && unit <= 14 &&
          this.samplerBindings[unit] === sampler) {
        report.checks.sampler++;
        if ((state(this.gl).samplers.get(unit) || null) !== (sampler || null))
          note("cached-sampler-binding", { unit });
      }
      return bindSamplerUnit.call(this, unit, sampler);
    };
    report.installed = true;
  };
  report.snapshot = () => ({
    installed: report.installed, lastPreparedImage: report.lastPreparedImage,
    capabilities: { ...report.capabilities }, checks: { ...report.checks }, errors: [...report.errors],
  });
})();
