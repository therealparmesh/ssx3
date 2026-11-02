(async () => {
  const results = [];
  try {
    const gl = document.querySelector("canvas").getContext("webgl2", { antialias: false });
    if (!gl) throw Error("WebGL2 unavailable");
    const kernel = await (await fetch("kernel.frag")).text();
    const fields = [
      "inputColor", "inputDepth", "outputColor", "outputDepth", "depthCopy",
      "headersTexture", "inputFramebuffer", "outputFramebuffer",
      "depthReadFramebuffer", "depthCopyFramebuffer", "width", "height",
      "tilesX", "tilesY", "headerScratch", "tileCounts", "sourceDepthRenderbuffer",
    ];
    function check(condition, message) {
      if (!condition) throw Error(message);
    }
    function pixels(set) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, set.inputFramebuffer);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const output = new Uint8Array(set.width * set.height * 4);
      gl.readPixels(0, 0, set.width, set.height, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, output);
      check(gl.getError() === gl.NO_ERROR, "Read existing target failed");
      return Array.from(output);
    }
    const faults = [
      ...Array.from({ length: 6 }, (_, i) => ["texture", i + 1]),
      ...Array.from({ length: 4 }, (_, i) => ["framebuffer", i + 1]),
      ["attachment", 1], ["attachment", 4], ["incomplete", 2],
    ];
    for (const scenario of ["first", "resize", "full-cache"]) {
      for (const [fault, at] of faults) {
        let raster;
        const item = { scenario, fault, at };
        const originals = {};
        try {
          raster = new Ps2OrderedRaster(gl, kernel);
          const sizes = scenario === "first" ? [] : scenario === "resize" ? [16] : [16, 24, 32, 40];
          const saved = [];
          for (const size of sizes) {
            raster.targets(size, size);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, raster.inputFramebuffer);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
            gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([size, 27, 119, 255]));
            saved.push({ set: raster.activeTargetSet, pixels: pixels(raster.activeTargetSet) });
          }
          const before = {
            fields: fields.map(name => raster[name]), active: raster.activeTargetSet,
            keys: [...raster.targetSets.keys()], textures: raster.textures.size,
            framebuffers: raster.framebuffers.size,
          };
          const method = {
            texture: "createTexture", framebuffer: "createFramebuffer",
            attachment: "framebufferTexture2D", incomplete: "checkFramebufferStatus",
          }[fault];
          originals[method] = gl[method];
          let count = 0;
          gl[method] = function (...args) {
            if (++count === at) {
              if (fault === "texture" || fault === "framebuffer") return null;
              if (fault === "attachment") throw Error("Injected attachment failure");
              return gl.FRAMEBUFFER_UNSUPPORTED;
            }
            return originals[method].apply(this, args);
          };
          let reported;
          try {
            raster.targets(48, 48);
          } catch (error) {
            reported = error.message;
          } finally {
            gl[method] = originals[method];
            delete originals[method];
          }
          check(reported, "Failed target allocation was not reported");
          check(raster.activeTargetSet === before.active, "Failed resize replaced active set");
          check(fields.every((name, i) => raster[name] === before.fields[i]),
            "Failed resize published partial target fields");
          check(JSON.stringify([...raster.targetSets.keys()]) === JSON.stringify(before.keys),
            "Failed resize changed LRU/evicted a retained target");
          check(raster.textures.size === before.textures && raster.framebuffers.size === before.framebuffers,
            "Failed resize leaked resources");
          check(gl.getError() === gl.NO_ERROR, "Failed resize left unreported GL error");
          for (const old of saved) {
            check(gl.isTexture(old.set.inputColor) && gl.isFramebuffer(old.set.inputFramebuffer),
              "Failed resize deleted old resources");
            check(JSON.stringify(pixels(old.set)) === JSON.stringify(old.pixels),
              "Failed resize changed old pixels");
          }
          if (sizes.length) {
            raster.targets(sizes.at(-1), sizes.at(-1));
            check(raster.inputColor === before.active.inputColor,
              "Old-size retry selected partial resources");
          }
          raster.targets(48, 48);
          check(raster.width === 48 && raster.height === 48 &&
            raster.activeTargetSet === raster.targetSets.get("48x48"), "Clean retry failed");
          check(raster.targetSets.size === Math.min(4, sizes.length + 1), "Cache limit or retry count wrong");
          check(raster.textures.size === 2 + raster.targetSets.size * 6, "Retry texture ownership mismatch");
          check(raster.framebuffers.size === raster.targetSets.size * 4, "Retry framebuffer ownership mismatch");
          if (sizes.length === 4) {
            check(!raster.targetSets.has("16x16"), "Successful growth did not evict oldest target");
            check(!gl.isTexture(saved[0].set.inputColor) && !gl.isFramebuffer(saved[0].set.inputFramebuffer),
              "Successful eviction leaked resources");
            for (const old of saved.slice(1))
              check(gl.isTexture(old.set.inputColor), "Successful eviction deleted a newer target");
          }
          check(gl.getError() === gl.NO_ERROR, "Retry GL error");
          Object.assign(item, { passed: true, reported });
        } catch (error) {
          Object.assign(item, { passed: false, error: error.message });
        } finally {
          for (const [name, method] of Object.entries(originals)) gl[name] = method;
          raster?.destroy();
          while (gl.getError() !== gl.NO_ERROR) {}
        }
        results.push(item);
      }
    }
    window.targetAllocationResult = { passed: results.every(item => item.passed), results };
    document.querySelector("pre").textContent = JSON.stringify(targetAllocationResult, null, 2);
  } catch (error) {
    window.targetAllocationResult = { passed: false, error: error.stack, results };
  }
})();
