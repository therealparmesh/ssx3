(async () => {
  const log = document.getElementById("log");
  try {
    const gl = document
      .getElementById("canvas")
      .getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) throw Error("WebGL2 unavailable");
    const compile = (kind, source) => {
      const s = gl.createShader(kind);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(s));
      return s;
    };
    let source = await (await fetch("../kernel.frag")).text();
    source = source.replace(
      "#version 300 es",
      "#version 300 es\n#define ORDERED_MIP_SAMPLING 1",
    );
    source =
      source.replaceAll("void main()", "void unusedRasterMain()") +
      "\nuniform vec3 probeInputs[8];void main(){vec3 p=probeInputs[int(gl_FragCoord.x)];outputColor=uvec4(sampleTexture(p.xy,p.z));outputDepth=0u;}";
    const program = gl.createProgram();
    gl.attachShader(
      program,
      compile(
        gl.VERTEX_SHADER,
        "#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}",
      ),
    );
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, source));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const texture = (unit, w, h, internal, format, type, data) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    texture(
      0,
      1,
      1,
      gl.RGBA8UI,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    gl.uniform1i(gl.getUniformLocation(program, "sourceTexture"), 0);
    const { colors, coords, makeLevels, expected } = MipOracle;
    texture(
      2,
      256,
      1,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(colors.flat()),
    );
    gl.uniform1i(gl.getUniformLocation(program, "paletteTexture"), 2);
    const output = texture(
        15,
        8,
        1,
        gl.RGBA8UI,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        null,
      ),
      fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      output,
      0,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error("Incomplete output");
    gl.viewport(0, 0, 8, 1);
    gl.disable(gl.DITHER);
    gl.bindVertexArray(gl.createVertexArray());
    const settings = new Uint32Array(32);
    settings[22] = 64;
    settings[23] = 32;
    settings[28] = 37 | (211 << 8) | (1 << 16);
    let cases = 0,
      pixels = 0,
      hash = 2166136261;
    const data = new Uint8Array(32),
      settingsLoc = gl.getUniformLocation(program, "settings[0]"),
      inputsLoc = gl.getUniformLocation(program, "probeInputs[0]");
    const test = (format, levels, o) => {
      settings[25] = format === "idx4" ? 3 : format === "idx8" ? 2 : 1;
      settings[29] = format === "rgb16" ? 1 : format === "rgb24" ? 2 : 0;
      settings[16] = o.wrap | (o.wrap << 2);
      settings[17] = o.wrap === 3 ? 31 : 7;
      settings[18] = o.wrap === 3 ? 16 : 47;
      settings[19] = o.wrap === 3 ? 15 : 3;
      settings[20] = o.wrap === 3 ? 8 : 22;
      settings[30] =
        (0x80000000 |
          (o.fixed ? 1 : 0) |
          (o.maximum << 2) |
          (o.mag << 5) |
          (o.min << 6) |
          (o.scale << 19)) >>>
        0;
      settings[31] = o.bias & 4095;
      if (new URLSearchParams(location.search).has("levelZero"))
        settings[30] = (settings[30] & ~28) >>> 0;
      gl.uniform4uiv(settingsLoc, settings);
      gl.uniform3fv(
        inputsLoc,
        new Float32Array(coords.flatMap((uv) => [...uv, o.q])),
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 8, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, data);
      for (let p = 0; p < 8; p++) {
        const color = expected(levels, coords[p].map(Math.fround), o);
        for (let c = 0; c < 4; c++) {
          const value = data[p * 4 + c];
          if (value !== color[c])
            throw Error(
              "Mip mismatch " +
                JSON.stringify({
                  format,
                  ...o,
                  p,
                  c,
                  got: value,
                  expected: color[c],
                }),
            );
          hash = Math.imul(hash ^ value, 16777619) >>> 0;
        }
      }
      cases++;
      pixels += 8;
    };
    for (const format of ["rgba32", "rgb24", "rgb16", "idx4", "idx8"]) {
      const levels = makeLevels(format);
      for (let i = 0; i < 7; i++) {
        const l = levels[i],
          unit = i === 0 ? 1 : i + 2;
        texture(
          unit,
          l.w,
          l.h,
          format === "rgb16" ? gl.RGB5_A1 : gl.RGBA8,
          gl.RGBA,
          format === "rgb16" ? gl.UNSIGNED_SHORT_5_5_5_1 : gl.UNSIGNED_BYTE,
          format === "rgb16" ? l.words : l.bytes,
        );
        gl.uniform1i(
          gl.getUniformLocation(
            program,
            i === 0 ? "normalizedTexture" : "mipTexture" + i,
          ),
          unit,
        );
      }
      for (const maximum of [0, 1, 3, 6])
        for (let min = 0; min < 6; min++)
          for (let mag = 0; mag < 2; mag++)
            for (const bias of [
              -2048, -16, 0, 4, 8, 12, 16, 24, 40, 80, 112, 2047,
            ])
              for (let wrap = 0; wrap < 4; wrap++)
                test(format, levels, {
                  fixed: true,
                  maximum,
                  min,
                  mag,
                  bias,
                  wrap,
                  q: 1,
                  scale: 0,
                });
      for (let min = 0; min < 6; min++)
        for (const scale of [0, 1, 3])
          for (const q of [2, -2, 1, 0.5, 0.25, 0])
            for (let wrap = 0; wrap < 4; wrap++)
              test(format, levels, {
                fixed: false,
                maximum: 6,
                min,
                mag: 1,
                bias: 6,
                wrap,
                q,
                scale,
              });
      log.textContent += "\nPASS " + format + " " + cases + " cases";
      await new Promise((r) => setTimeout(r, 0));
    }
    const glError = gl.getError();
    if (glError) throw Error("GL error " + glError);
    window.mipResult = { passed: true, cases, pixels, hash, glError };
    log.textContent += "\n" + JSON.stringify(mipResult);
  } catch (error) {
    window.mipResult = { passed: false, error: error.message };
    log.textContent += "\nFAIL " + error.message;
  }
})();
