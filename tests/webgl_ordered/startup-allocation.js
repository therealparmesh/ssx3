// Verify constructor failure cleanup, host ownership and exact retry output.
(async () => {
  try {
    const gl = document
        .querySelector("canvas")
        .getContext("webgl2", { antialias: false }),
      fragment = await (await fetch("kernel.frag")).text();
    if (!gl) throw Error("NoWebGL2");
    const check = (ok, message) => {
        if (!ok) throw Error(message);
      },
      live = new Map();
    let programAllocations = 0;
    for (const type of [
      "Program",
      "Shader",
      "VertexArray",
      "Sampler",
      "Texture",
      "Framebuffer",
      "Renderbuffer",
    ]) {
      const set = new Set();
      live.set(type, set);
      const create = gl["create" + type].bind(gl),
        drop = gl["delete" + type].bind(gl);
      gl["create" + type] = (...a) => {
        const object = create(...a);
        if (type === "Program") programAllocations++;
        if (object) set.add(object);
        return object;
      };
      gl["delete" + type] = (object) => {
        drop(object);
        set.delete(object);
      };
    }
    const programs = live.get("Program"),
      shaders = live.get("Shader"),
      counts = () =>
        JSON.stringify([...live].map(([type, set]) => [type, set.size]));
    const color = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 16, 16);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, 16, 16);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      color,
      0,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      depth,
    );
    check(
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
      "Bad target",
    );
    const initial = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < initial.length; i += 4)
      initial.set([128, 96, 64, 128], i);
    const config = new Uint32Array(32);
    config[0] = 6 | 16 | 256;
    config[7] = 1;
    config[11] = config[12] = 15 << 16;
    config[13] = 1;
    config[14] = 4;
    config[22] = config[23] = 16;
    config[24] = 0xffffff;
    config[25] = 1;
    config[27] = 1;
    config[29] = 4;
    const words = new Uint32Array(24),
      floats = new Float32Array(words.buffer);
    for (const [i, x, y] of [
      [0, 0, 0],
      [8, 16, 16],
      [16, 16, 16],
    ]) {
      floats[i] = x;
      floats[i + 1] = y;
      words[i + 2] = 1;
      words[i + 3] = 0x80406020;
      floats[i + 4] = (x + 0.5) * 16;
      floats[i + 5] = (y + 0.5) * 16;
      floats[i + 6] = 1;
      words[i + 7] = 255;
    }
    const packet = {
      targetFramebuffer: fbo,
      colorTexture: color,
      depthRenderbuffer: depth,
      width: 16,
      height: 16,
      settings: config,
      vertexWords: words,
      texture: color,
    };
    function read() {
      const old = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
      const out = new Uint8Array(initial.length);
      gl.readPixels(0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, out);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, old);
      return out;
    }
    function state() {
      return [
        gl.getParameter(gl.CURRENT_PROGRAM),
        gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
        gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
        gl.getParameter(gl.ACTIVE_TEXTURE),
      ];
    }
    const results = [];
    const faults = [
      "program-allocation",
      "shader-allocation",
      "fragment-shader-allocation",
      "vertex-compile",
      "fragment-compile",
      "link",
      "vao-allocation",
      "sampler-allocation",
    ];
    const only = new URLSearchParams(location.search).get("faultOnly");
    check(!only || faults.includes(only), "Unknown allocation fault");
    for (const fault of faults.filter((value) => !only || value === only)) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, color);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        16,
        16,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        initial,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.disable(gl.SCISSOR_TEST);
      gl.depthMask(true);
      gl.clearDepth(0);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const beforeCounts = counts(),
        beforeState = state(),
        saved = new Map();
      let stage = 0,
        calls = 0;
      const replace = (name, fn) => {
        saved.set(name, gl[name]);
        gl[name] = fn;
      };
      const alloc = gl.createProgram.bind(gl);
      replace("createProgram", () => {
        stage++;
        return stage === 8 && fault === "program-allocation" ? null : alloc();
      });
      if (
        fault === "shader-allocation" ||
        fault === "fragment-shader-allocation"
      ) {
        const create = gl.createShader.bind(gl);
        replace("createShader", (type) =>
          stage === 8 && ++calls === (fault === "shader-allocation" ? 1 : 2)
            ? null
            : create(type),
        );
      }
      if (fault === "vertex-compile" || fault === "fragment-compile") {
        const original = gl.getShaderParameter.bind(gl);
        replace("getShaderParameter", (shader, what) => {
          if (
            stage === 8 &&
            what === gl.COMPILE_STATUS &&
            ++calls === (fault === "vertex-compile" ? 1 : 2)
          )
            return false;
          return original(shader, what);
        });
        replace("getShaderInfoLog", () => "Injected " + fault);
      }
      if (fault === "link") {
        const original = gl.getProgramParameter.bind(gl);
        replace("getProgramParameter", (program, what) =>
          stage === 8 && what === gl.LINK_STATUS
            ? false
            : original(program, what),
        );
        replace("getProgramInfoLog", () => "Injected link");
      }
      if (fault === "vao-allocation") replace("createVertexArray", () => null);
      if (fault === "sampler-allocation") replace("createSampler", () => null);
      let renderer = null,
        reported = false,
        message = "";
      try {
        renderer = new Ps2OrderedRaster(gl, fragment);
      } catch (error) {
        reported = true;
        message = error.message;
      } finally {
        for (const [name, fn] of saved) gl[name] = fn;
      }
      check(
        reported && renderer === null,
        "Failed renderer published " + fault,
      );
      check(
        stage ===
          (fault === "vao-allocation" || fault === "sampler-allocation"
            ? 0
            : 8),
        "Wrong allocation fault stage " + fault,
      );
      check(
        counts() === beforeCounts,
        "Failed constructor leaked GL resources " + fault,
      );
      const afterState = state();
      check(
        afterState.every((v, i) => v === beforeState[i]),
        "Failed startup compile mutated hostGLstate " + fault,
      );
      check(
        read().every((v, i) => v === initial[i]),
        "Failed startup compile changed target " + fault,
      );
      check(gl.getError() === 0, "Unexpected GL error after fault " + fault);
      renderer = new Ps2OrderedRaster(gl, fragment);
      check(
        programs.size === 8 &&
          shaders.size === 0 &&
          renderer.programs.size === 8,
        "Startup allocation count wrong " + fault,
      );
      const beforeDrawPrograms = programAllocations;
      renderer.render(packet);
      check(
        programAllocations === beforeDrawPrograms,
        "Drawing compiled a shader " + fault,
      );
      const output = read();
      for (let i = 0; i < output.length; i += 4)
        check(
          output[i] === 32 &&
            output[i + 1] === 72 &&
            output[i + 2] === 32 &&
            output[i + 3] === 128,
          "Clean retry wrong pixels " +
            fault +
            " " +
            i +
            " " +
            Array.from(output.subarray(i, i + 4)),
        );
      const feedback = renderer.kernel;
      renderer.destroy();
      gl.useProgram(null);
      check(
        !gl.isProgram(feedback) && counts() === beforeCounts,
        "Destroy leaked startup program/resources " + fault,
      );
      check(
        gl.isTexture(color) &&
          gl.isRenderbuffer(depth) &&
          gl.isFramebuffer(fbo),
        "Destroy deleted host resources",
      );
      check(gl.getError() === 0, "Cleanup GL error");
      results.push({
        fault,
        reported,
        message,
        retried: true,
        pixels: 256,
        hostUnchanged: true,
        cleanup: true,
        noDrawTimeCompile: true,
      });
    }
    globalThis.retryResult = {
      passed: true,
      cases: results.length,
      pixels: results.length * 256,
      glError: gl.getError(),
      results,
    };
    document.querySelector("pre").textContent = JSON.stringify(
      retryResult,
      null,
      2,
    );
  } catch (error) {
    globalThis.retryResult = {
      passed: false,
      error: error.message + "\n" + error.stack,
    };
    document.querySelector("pre").textContent = JSON.stringify(
      retryResult,
      null,
      2,
    );
  }
})();
