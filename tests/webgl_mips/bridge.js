(async () => {
  const log = document.getElementById("log");
  try {
    const gl = document
      .getElementById("canvas")
      .getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) throw Error("No WebGL2");
    const kernel = await (await fetch("../kernel.frag")).text(),
      bridge = new Ps2OrderedRaster(gl, kernel),
      { makeLevels, expected, colors, coords } = MipOracle;
    const texture = (w, h, internal, format, type, data) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    const target = texture(
        8,
        8,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(256),
      ),
      depth = gl.createRenderbuffer(),
      fbo = gl.createFramebuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, 8, 8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      target,
      0,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      depth,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error("Incomplete target");
    const palette = texture(
      256,
      1,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(colors.flat()),
    );
    const settings = new Uint32Array(32);
    settings[7] = 1;
    settings[11] = settings[12] = 7 << 16;
    settings[13] = 1;
    settings[14] = 5;
    settings[22] = 64;
    settings[23] = 32;
    settings[24] = 0xffffff;
    settings[26] = 0;
    settings[27] = 1;
    settings[28] = 37 | (211 << 8) | (1 << 16);
    const vertexWords = new Uint32Array(24),
      floats = new Float32Array(vertexWords.buffer),
      positions = [
        [0, 0],
        [8, 0],
        [0, 8],
      ];
    for (let i = 0; i < 3; i++) {
      floats[i * 8] = positions[i][0];
      floats[i * 8 + 1] = positions[i][1];
      vertexWords[i * 8 + 3] = 0x80808080;
    }
    let cases = 0,
      hash = 2166136261;
    const bytes = new Uint8Array(4);
    for (const format of ["rgba32", "rgb24", "rgb16", "idx4", "idx8"]) {
      const levels = makeLevels(format),
        textures = levels.map((l) =>
          texture(
            l.w,
            l.h,
            format === "rgb16" ? gl.RGB5_A1 : gl.RGBA8,
            gl.RGBA,
            format === "rgb16" ? gl.UNSIGNED_SHORT_5_5_5_1 : gl.UNSIGNED_BYTE,
            format === "rgb16" ? l.words : l.bytes,
          ),
        );
      settings[25] = format === "idx4" ? 3 : format === "idx8" ? 2 : 1;
      settings[29] = format === "rgb16" ? 1 : format === "rgb24" ? 2 : 0;
      for (const opaque of [false, true])
        for (const fixed of [false, true])
          for (const maximum of [0, 1, 3, 6])
            for (let min = 0; min < 6; min++)
              for (let wrap = 0; wrap < 4; wrap++) {
                const o = {
                    fixed,
                    maximum,
                    min,
                    mag: 1,
                    bias: 24,
                    wrap,
                    q: 0.5,
                    scale: 1,
                  },
                  uv = coords[(cases + 3) % coords.length];
                settings[0] = 3 | 16 | (opaque ? 0 : 64) | (fixed ? 256 : 0);
                settings[2] = 0x64;
                settings[3] = 128;
                settings[16] = wrap | (wrap << 2);
                settings[17] = wrap === 3 ? 31 : 7;
                settings[18] = wrap === 3 ? 16 : 47;
                settings[19] = wrap === 3 ? 15 : 3;
                settings[20] = wrap === 3 ? 8 : 22;
                settings[30] =
                  (0x80000000 |
                    (fixed ? 1 : 0) |
                    (maximum << 2) |
                    32 |
                    (min << 6) |
                    (1 << 19)) >>>
                  0;
                settings[31] = 24;
                for (let i = 0; i < 3; i++) {
                  floats[i * 8 + 4] = fixed ? uv[0] * 16 : (uv[0] / 64) * o.q;
                  floats[i * 8 + 5] = fixed ? uv[1] * 16 : (uv[1] / 32) * o.q;
                  floats[i * 8 + 6] = o.q;
                }
                const before = bridge.stats.opaqueBatches;
                bridge.render({
                  targetFramebuffer: fbo,
                  colorTexture: target,
                  depthRenderbuffer: depth,
                  width: 8,
                  height: 8,
                  settings,
                  vertexWords,
                  texture: textures[0],
                  palette,
                  mipTextures: textures.slice(1),
                });
                if (bridge.stats.opaqueBatches - before !== (opaque ? 1 : 0))
                  throw Error("Wrong path");
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
                const color = expected(levels, uv.map(Math.fround), o);
                for (let c = 0; c < 4; c++) {
                  if (bytes[c] !== color[c])
                    throw Error(
                      "Bridge mismatch " +
                        JSON.stringify({
                          format,
                          opaque,
                          ...o,
                          uv,
                          c,
                          got: bytes[c],
                          expected: color[c],
                        }),
                    );
                  hash = Math.imul(hash ^ bytes[c], 16777619) >>> 0;
                }
                cases++;
              }
    }
    // Rejection must happen before any draw can modify the target.
    settings[0] = 3 | 16;
    settings[30] = (0x80000000 | 1 | (1 << 2) | (2 << 6)) >>> 0;
    let missing = false;
    try {
      bridge.render({
        targetFramebuffer: fbo,
        colorTexture: target,
        depthRenderbuffer: depth,
        width: 8,
        height: 8,
        settings,
        vertexWords,
        texture: target,
        palette,
        mipTextures: [],
      });
    } catch (e) {
      missing = /Missing mip level/.test(e.message);
    }
    if (!missing) throw Error("Missing mip level accepted");
    const glError = gl.getError();
    if (glError) throw Error("GL error " + glError);
    window.mipBridgeResult = {
      passed: true,
      cases,
      pixels: cases,
      hash,
      stats: { ...bridge.stats },
      missingRejected: true,
      glError,
    };
    bridge.destroy();
    log.textContent += "\n" + JSON.stringify(mipBridgeResult);
  } catch (error) {
    window.mipBridgeResult = { passed: false, error: error.message };
    log.textContent += "\nFAIL " + error.message;
  }
})();
