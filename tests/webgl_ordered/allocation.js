(async () => {
  try {
    const gl = document.querySelector("canvas").getContext("webgl2", { antialias: false });
    const kernel = await (await fetch("kernel.frag")).text();
    const results = [];
    function require(condition, message) {
      if (!condition) throw Error(message);
    }
    require(gl, "WebGL2 unavailable");
    function read(texture, rows, components) {
      const framebuffer = gl.createFramebuffer();
      try {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D, texture, 0);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        require(gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
          "Incomplete data texture");
        const data = new Uint32Array(1024 * rows * components);
        gl.readPixels(0, 0, 1024, rows, components === 4 ? gl.RGBA_INTEGER : gl.RED_INTEGER,
          gl.UNSIGNED_INT, data);
        require(gl.getError() === gl.NO_ERROR, "Read error");
        return data;
      } finally {
        gl.deleteFramebuffer(framebuffer);
      }
    }
    for (const components of [1, 4]) {
      for (const grow of [false, true]) {
        for (const fault of ["null-texture", "null-with-error", "throw-storage", "gl-error-storage", "throw-parameter"]) {
          let raster;
          const record = { components, grow, fault };
          try {
            raster = new Ps2OrderedRaster(gl, kernel);
            const small = Uint32Array.from({ length: 1024 * components },
              (_, i) => (0xf123abcd + i * 137) >>> 0);
            const large = Uint32Array.from({ length: 2048 * components },
              (_, i) => (0x12345678 ^ i * 7919) >>> 0);
            if (grow) raster.dataTexture("qaData", small, components);
            const old = raster.qaData;
            const oldRows = raster.qaDataRows;
            const owned = raster.textures.size;
            const create = gl.createTexture.bind(gl);
            const storage = gl.texStorage2D.bind(gl);
            const parameter = gl.texParameteri.bind(gl);
            let temporary;
            gl.createTexture = function () {
              if (fault === "null-texture") return null;
              if (fault === "null-with-error") {
                gl.bindTexture(0, null);
                return null;
              }
              temporary = create();
              return temporary;
            };
            gl.texStorage2D = function (...args) {
              if (fault === "throw-storage") throw Error("Injected storage exception");
              // Exercise a real driver error rather than only a JavaScript throw.
              if (fault === "gl-error-storage") args[3] = -1;
              return storage(...args);
            };
            gl.texParameteri = function (...args) {
              if (fault === "throw-parameter") throw Error("Injected parameter exception");
              return parameter(...args);
            };
            let error;
            try {
              raster.dataTexture("qaData", grow ? large : small, components);
            } catch (failure) {
              error = failure.message;
            } finally {
              gl.createTexture = create;
              gl.texStorage2D = storage;
              gl.texParameteri = parameter;
            }
            require(error, "Allocation failure was not reported");
            if (fault === "null-with-error") require(error.includes(String(gl.INVALID_ENUM)),
              "Null allocation did not report its GL error");
            if (fault === "gl-error-storage") require(error.includes(String(gl.INVALID_VALUE)),
              "Storage failure did not report its GL error");
            require(raster.qaData === old && raster.qaDataRows === oldRows,
              "Failed allocation replaced cached handle/dimensions");
            require(raster.textures.size === owned, "Failed allocation leaked owned resources");
            require(!temporary || !gl.isTexture(temporary), "Temporary allocation leaked a live texture");
            require(gl.getError() === gl.NO_ERROR, "Allocation failure left an unreported GL error");
            if (grow) {
              require(gl.isTexture(old), "Failed growth deleted prior image");
              require(read(old, 1, components).every((value, i) => value === small[i]),
                "Failed growth changed prior pixels");
            }
            const next = grow ? large : small;
            raster.dataTexture("qaData", next, components);
            const actual = read(raster.qaData, grow ? 2 : 1, components);
            require(actual.every((value, i) => value === next[i]), "Clean retry did not upload exact pixels");
            require(raster.textures.size === owned + (grow ? 0 : 1), "Retry resource ownership mismatch");
            if (grow) require(!gl.isTexture(old), "Retry retained superseded texture");
            Object.assign(record, { passed: true, errorReported: error, words: actual.length });
          } catch (failure) {
            Object.assign(record, { passed: false, error: failure.message });
          } finally {
            raster?.destroy();
            // Keep failures independent when checking the preceding implementation.
            while (gl.getError() !== gl.NO_ERROR) {}
          }
          results.push(record);
        }
      }
    }
    window.allocationResult = { passed: results.every(item => item.passed), results };
    document.querySelector("pre").textContent = JSON.stringify(allocationResult, null, 2);
  } catch (error) {
    window.allocationResult = { error: error.stack };
  }
})();
