// Asset-free transfer lifetime probe. See README.md for scope and limits.
(async () => {
  try {
    if (!crossOriginIsolated) throw Error("Shared-memory isolation required");
    const gl = document
      .querySelector("canvas")
      .getContext("webgl2", { antialias: false });
    if (!gl) throw Error("WebGL2 unavailable");
    const compile = (type, text) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    for (const [type, text] of [
      [
        gl.VERTEX_SHADER,
        "#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}",
      ],
      [
        gl.FRAGMENT_SHADER,
        "#version 300 es\nprecision highp float;precision highp int;uniform highp sampler2D source;layout(location=0)out uvec4 color;void main(){color=uvec4(floor(texelFetch(source,ivec2(gl_FragCoord.xy),0)*255.0+0.5));}",
      ],
    ]) {
      const shader = compile(type, text);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "source"), 0);
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    const input = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 1024, 1024);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const outputs = [];
    for (let i = 0; i < 16; i++) {
      const texture = gl.createTexture(),
        fbo = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, 1024, 1024);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw Error("Incomplete output");
      outputs.push({ texture, fbo });
    }
    const shapes = [
        [16, 16],
        [32, 32],
        [64, 64],
        [128, 128],
        [256, 256],
        [512, 256],
        [256, 128],
        [128, 64],
        [64, 32],
        [32, 16],
        [1024, 256],
        [1024, 1024],
      ],
      results = [];
    const value = (seed, index) =>
      (seed ^
        Math.imul(index + 1, 0x9e3779b1) ^
        (index >>> 8) ^
        Math.imul(index >>> 16, 97)) &
      255;
    let totalBytes = 0;
    for (const mode of ["unshared", "shared", "shared-large"])
      for (const overload of ["subview", "offset"]) {
        const initial = mode === "shared-large" ? 5120 : 256,
          memory = new WebAssembly.Memory({
            initial,
            maximum: initial + 544,
            shared: mode !== "unshared",
          });
        for (let group = 0; group < 5; group++) {
          const queued = [];
          for (let i = 0; i < 16; i++) {
            const serial = group * 16 + i,
              [width, height] = shapes[serial % shapes.length],
              count = width * height,
              offset =
                (mode === "shared-large"
                  ? [
                      65536,
                      64 * 1024 * 1024,
                      128 * 1024 * 1024,
                      240 * 1024 * 1024,
                      288 * 1024 * 1024,
                    ][serial % 5]
                  : 65536) +
                (serial % 31) * 64,
              heap = new Uint8Array(memory.buffer),
              bytes = heap.subarray(offset, offset + count),
              seed = (serial * 7919 + 0xabc00000) >>> 0;
            for (let at = 0; at < count; at++) bytes[at] = value(seed, at);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, input);
            if (overload === "offset")
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                0,
                width,
                height,
                gl.RED,
                gl.UNSIGNED_BYTE,
                heap,
                offset,
              );
            else
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                0,
                width,
                height,
                gl.RED,
                gl.UNSIGNED_BYTE,
                bytes,
              );
            bytes.fill(0xa7);
            gl.bindFramebuffer(gl.FRAMEBUFFER, outputs[i].fbo);
            gl.viewport(0, 0, width, height);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            queued.push({ width, height, count, seed, index: i, serial });
          }
          memory.grow(mode === "shared-large" && group === 2 ? 512 : 1);
          await new Promise(requestAnimationFrame);
          for (const item of queued) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, outputs[item.index].fbo);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            const pixels = new Uint8Array(item.count * 4);
            gl.readPixels(
              0,
              0,
              item.width,
              item.height,
              gl.RGBA_INTEGER,
              gl.UNSIGNED_BYTE,
              pixels,
            );
            let mismatches = 0,
              first = null;
            for (let at = 0; at < item.count; at++)
              if (
                pixels[at * 4] !== value(item.seed, at) ||
                pixels[at * 4 + 1] ||
                pixels[at * 4 + 2] ||
                pixels[at * 4 + 3] !== 255
              ) {
                mismatches++;
                first ??= {
                  pixel: at,
                  actual: Array.from(pixels.subarray(at * 4, at * 4 + 4)),
                  expected: value(item.seed, at),
                };
              }
            const error = gl.getError();
            if (error) throw Error("GL error " + error);
            results.push({
              mode,
              overload,
              serial: item.serial,
              bytes: item.count,
              mismatches,
              first,
            });
            totalBytes += item.count;
          }
        }
      }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    const wrong = new Uint8Array(256).fill(0x6d);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      16,
      16,
      gl.RED,
      gl.UNSIGNED_BYTE,
      wrong,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputs[0].fbo);
    gl.viewport(0, 0, 16, 16);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const fault = new Uint8Array(1024);
    gl.readPixels(0, 0, 16, 16, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, fault);
    const negativeDetected =
      fault[0] === 0x6d && fault[0] !== value(0xabc00000, 0);
    window.uploadResult = {
      passed: results.every((r) => r.mismatches === 0) && negativeDetected,
      cases: results.length,
      totalBytes,
      negativeDetected,
      glError: gl.getError(),
      failures: results.filter((r) => r.mismatches),
      scope:
        "Actual native R8/UNSIGNED_BYTE transfer shapes and the full-heap/srcOffset overload versus subviews; immediate reuse,16queued GPU results, large shared-memory offsets and32MiB growth. No full-game fidelity/performance qualification.",
    };
    document.querySelector("pre").textContent = JSON.stringify(
      uploadResult,
      null,
      2,
    );
  } catch (error) {
    window.uploadResult = { passed: false, error: error.stack };
  }
})();
