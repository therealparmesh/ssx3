// Asset-free transfer lifetime probe. See README.md for scope and limits.
(async () => {
  try {
    if (!crossOriginIsolated) throw Error("Shared-memory isolation required");
    const gl = document
      .querySelector("canvas")
      .getContext("webgl2", { antialias: false });
    if (!gl) throw Error("WebGL2 unavailable");
    const program = gl.createProgram();
    for (const [type, source] of [
      [
        gl.VERTEX_SHADER,
        `#version 300 es
 precision highp float;precision highp int;layout(location=0)in uvec4 words;flat out uvec4 payload;
 void main(){ivec2 p=ivec2(gl_VertexID%1024,gl_VertexID/1024);gl_Position=vec4((vec2(p)+0.5)/vec2(1024,64)*2.0-1.0,0,1);gl_PointSize=1.0;payload=words;}`,
      ],
      [
        gl.FRAGMENT_SHADER,
        `#version 300 es
 precision highp float;precision highp int;flat in uvec4 payload;layout(location=0)out uvec4 color;void main(){color=payload;}`,
      ],
    ]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const vao = gl.createVertexArray(),
      buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_INT, 16, 0);
    gl.enableVertexAttribArray(0);
    const outputs = [];
    for (let i = 0; i < 16; i++) {
      const texture = gl.createTexture(),
        fbo = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, 1024, 64);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw Error("Incomplete output");
      outputs.push(fbo);
    }
    gl.viewport(0, 0, 1024, 64);
    const lengths = [
        32, 64, 128, 256, 1024, 3264, 16384, 65536, 262144, 1048576,
      ],
      value = (seed, i) =>
        (seed ^
          Math.imul(i + 1, 0x9e3779b1) ^
          Math.imul(i >>> 16, 0x10204081)) >>>
        0,
      results = [];
    let totalBytes = 0;
    for (const mode of ["unshared", "shared", "shared-large"])
      for (const method of ["bufferData", "bufferSubData"])
        for (const overload of ["subview", "offset"]) {
          const initial = mode === "shared-large" ? 5120 : 256,
            memory = new WebAssembly.Memory({
              initial,
              maximum: initial + 544,
              shared: mode !== "unshared",
            });
          for (let group = 0; group < 3; group++) {
            const queued = [];
            for (let i = 0; i < 16; i++) {
              const serial = group * 16 + i,
                count = lengths[serial % lengths.length],
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
                words = new Uint32Array(memory.buffer, offset, count / 4),
                seed = (serial * 7919 + 0xabc00000) >>> 0;
              for (let at = 0; at < words.length; at++)
                words[at] = value(seed, at);
              gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
              if (method === "bufferSubData")
                gl.bufferData(gl.ARRAY_BUFFER, count, gl.STREAM_DRAW);
              if (method === "bufferData") {
                if (overload === "offset")
                  gl.bufferData(
                    gl.ARRAY_BUFFER,
                    heap,
                    gl.STREAM_DRAW,
                    offset,
                    count,
                  );
                else gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STREAM_DRAW);
              } else {
                if (overload === "offset")
                  gl.bufferSubData(gl.ARRAY_BUFFER, 0, heap, offset, count);
                else gl.bufferSubData(gl.ARRAY_BUFFER, 0, bytes);
              }
              bytes.fill(0xa7);
              gl.bindFramebuffer(gl.FRAMEBUFFER, outputs[i]);
              gl.drawArrays(gl.POINTS, 0, count / 16);
              queued.push({ count, seed, index: i, serial });
            }
            memory.grow(mode === "shared-large" && group === 1 ? 512 : 1);
            await new Promise(requestAnimationFrame);
            for (const item of queued) {
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, outputs[item.index]);
              const pixels = new Uint32Array(
                1024 * Math.ceil(item.count / 16 / 1024) * 4,
              );
              gl.readPixels(
                0,
                0,
                1024,
                Math.ceil(item.count / 16 / 1024),
                gl.RGBA_INTEGER,
                gl.UNSIGNED_INT,
                pixels,
              );
              let mismatches = 0,
                first = null;
              for (let at = 0; at < item.count / 4; at++)
                if (pixels[at] !== value(item.seed, at)) {
                  mismatches++;
                  first ??= {
                    word: at,
                    actual: pixels[at],
                    expected: value(item.seed, at),
                  };
                }
              const error = gl.getError();
              if (error) throw Error("GL error " + error);
              results.push({
                mode,
                method,
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
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Uint32Array(8).fill(0x6d6d6d6d),
      gl.STREAM_DRAW,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputs[0]);
    gl.drawArrays(gl.POINTS, 0, 2);
    const fault = new Uint32Array(8);
    gl.readPixels(0, 0, 2, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, fault);
    const negativeDetected =
      fault.every((n) => n === 0x6d6d6d6d) && fault[0] !== value(0xabc00000, 0);
    window.uploadResult = {
      passed: results.every((r) => r.mismatches === 0) && negativeDetected,
      cases: results.length,
      totalBytes,
      negativeDetected,
      glError: gl.getError(),
      failures: results.filter((r) => r.mismatches),
      scope:
        "Native full-heap Uint8Array offset/length bufferData and bufferSubData versus subviews; every word read through GPU vertex attributes after immediate memory reuse,16queued draws and32MiB growth. Transport only, excludes native fallback shader math and full-game qualification.",
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
