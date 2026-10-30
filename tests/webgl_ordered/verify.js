(async () => {
  const log = document.getElementById("log");
  try {
    const reference = await createReference();
    const gl = document
      .getElementById("canvas")
      .getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) throw Error("WebGL2 unavailable");
    const compile = (kind, source) => {
      const s = gl.createShader(kind);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(
      program,
      compile(
        gl.VERTEX_SHADER,
        "#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}",
      ),
    );
    gl.attachShader(
      program,
      compile(gl.FRAGMENT_SHADER, await (await fetch("kernel.frag")).text()),
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const textures = [];
    function texture(unit, format, w, h, data, type, external) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, format, w, h, 0, external, type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      textures.push(t);
      return t;
    }
    const color = texture(
        0,
        gl.RGBA8UI,
        64,
        64,
        null,
        gl.UNSIGNED_BYTE,
        gl.RGBA_INTEGER,
      ),
      depth = texture(
        1,
        gl.R32UI,
        64,
        64,
        null,
        gl.UNSIGNED_INT,
        gl.RED_INTEGER,
      ),
      vertex = texture(
        2,
        gl.RGBA32UI,
        1024,
        1,
        null,
        gl.UNSIGNED_INT,
        gl.RGBA_INTEGER,
      ),
      bins = texture(3, gl.RG32UI, 8, 8, null, gl.UNSIGNED_INT, gl.RG_INTEGER),
      lists = texture(
        4,
        gl.R32UI,
        1024,
        1,
        null,
        gl.UNSIGNED_INT,
        gl.RED_INTEGER,
      );
    const texturePixels = new Uint32Array(4096);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++)
        texturePixels[y * 64 + x] =
          (x * 4) |
          ((y * 4) << 8) |
          (((x ^ y) * 4) << 16) |
          (x & 8 ? 0x80000000 : 0);
    texture(
      7,
      gl.RGBA8UI,
      64,
      64,
      new Uint8Array(texturePixels.buffer),
      gl.UNSIGNED_BYTE,
      gl.RGBA_INTEGER,
    );
    const normalizedTexture = texture(
      8,
      gl.RGBA8,
      64,
      64,
      new Uint8Array(texturePixels.buffer),
      gl.UNSIGNED_BYTE,
      gl.RGBA,
    );
    const palettePixels = new Uint32Array(256);
    for (let i = 0; i < 256; i++)
      palettePixels[i] =
        ((i * 17) & 255) |
        (((i * 13) & 255) << 8) |
        ((255 - i) << 16) |
        (i & 1 ? 0x80000000 : 0);
    const paletteTexture = texture(
      9,
      gl.RGBA8,
      256,
      1,
      new Uint8Array(palettePixels.buffer),
      gl.UNSIGNED_BYTE,
      gl.RGBA,
    );
    const outColor = texture(
        5,
        gl.RGBA8UI,
        64,
        64,
        null,
        gl.UNSIGNED_BYTE,
        gl.RGBA_INTEGER,
      ),
      outDepth = texture(
        6,
        gl.R32UI,
        64,
        64,
        null,
        gl.UNSIGNED_INT,
        gl.RED_INTEGER,
      );
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      outColor,
      0,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      outDepth,
      0,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error("Incomplete integer MRT framebuffer");
    for (const [name, unit] of [
      ["initialColor", 0],
      ["initialDepth", 1],
      ["vertices", 2],
      ["bins", 3],
      ["lists", 4],
      ["sourceTexture", 7],
      ["normalizedTexture", 8],
      ["paletteTexture", 9],
    ])
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
    gl.viewport(0, 0, 64, 64);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
    const initialColor = new Uint32Array(4096),
      initialDepth = new Uint32Array(4096),
      actualColor = new Uint32Array(4096 * 4),
      actualDepth = new Uint32Array(4096 * 4);
    const configPtr = reference._malloc(128),
      verticesPtr = reference._malloc(64 * 3 * 32),
      outputPtr = reference._malloc(4096 * 8);
    const pack = (r, g, b, a) => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
    const quad = (x, y, w, h, z, c) => [
      [x, y, z, c],
      [x + w, y, z, c],
      [x + w, y + h, z, c],
      [x, y, z, c],
      [x + w, y + h, z, c],
      [x, y + h, z, c],
    ];
    const baseConfig = () => {
      const c = new Uint32Array(32);
      c[0] = 3 | 64;
      c[1] = 0x50000;
      c[2] = 0x44;
      c[3] = 96;
      c[7] = 1;
      c[8] = pack(200, 20, 40, 128);
      c[9] = 100;
      c[11] = 63 << 16;
      c[12] = 63 << 16;
      c[22] = c[23] = 64;
      c[24] = 0xffffffff;
      return c;
    };
    const geometry = (alpha = 64) => [
      ...quad(8, 8, 32, 32, 200, pack(20, 200, 60, alpha)),
      ...quad(16, 16, 32, 32, 150, pack(220, 30, 80, 255 - alpha)),
      ...quad(24, 24, 16, 16, 175, pack(40, 60, 200, 128)),
    ];
    const upload = (unit, target, data, w, h, format, type) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        unit === 0
          ? gl.RGBA8UI
          : unit === 1 || unit === 4
            ? gl.R32UI
            : unit === 2
              ? gl.RGBA32UI
              : gl.RG32UI,
        w,
        h,
        0,
        format,
        type,
        data,
      );
    };
    const results = [],
      timerQueries = [];
    const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const started = performance.now();
    function run(name, config, input) {
      gl.activeTexture(gl.TEXTURE8);
      gl.bindTexture(gl.TEXTURE_2D, normalizedTexture);
      const packGl16 = (c) =>
        (((c >>> 3) & 31) << 11) |
        (((c >>> 11) & 31) << 6) |
        (((c >>> 19) & 31) << 1) |
        (c >>> 31);
      if (config[25] == 2 || config[25] == 3) {
        const indices = new Uint8Array(4096);
        for (let y = 0; y < 64; y++)
          for (let x = 0; x < 64; x++)
            indices[y * 64 + x] =
              ((x >> 2) + (y >> 2) * 13) & (config[25] == 3 ? 15 : 255);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.R8,
          64,
          64,
          0,
          gl.RED,
          gl.UNSIGNED_BYTE,
          indices,
        );
      } else if (config[25] == 4) {
        const pixels = new Uint32Array(4096);
        for (let y = 0; y < 64; y++)
          for (let x = 0; x < 64; x++)
            pixels[y * 64 + x] =
              17 | ((((x >> 2) + (y >> 2) * 13) & 255) << 24);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          64,
          64,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array(pixels.buffer),
        );
      } else if (config[29] == 1)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGB5_A1,
          64,
          64,
          0,
          gl.RGBA,
          gl.UNSIGNED_SHORT_5_5_5_1,
          Uint16Array.from(texturePixels, packGl16),
        );
      else
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          64,
          64,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array(texturePixels.buffer),
        );
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
      if (config[25] >= 2 && config[29] == 1) {
        const pixels = Uint16Array.from(palettePixels, packGl16);
        pixels[0] = 0;
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGB5_A1,
          256,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_SHORT_5_5_5_1,
          pixels,
        );
      } else
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          256,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array(palettePixels.buffer),
        );
      const vertexBytes = new ArrayBuffer(input.length * 32),
        vf = new Float32Array(vertexBytes),
        vu = new Uint32Array(vertexBytes);
      input.forEach((v, i) => {
        vf[i * 8] = v[0];
        vf[i * 8 + 1] = v[1];
        vu[i * 8 + 2] = v[2];
        vu[i * 8 + 3] = v[3];
        vf[i * 8 + 4] = v[4] ?? 0;
        vf[i * 8 + 5] = v[5] ?? 0;
        vf[i * 8 + 6] = v[6] ?? 1;
        vu[i * 8 + 7] = v[7] ?? 255;
      });
      const verticesData = new Uint32Array(
        Math.max(1, Math.ceil((input.length * 2) / 1024)) * 1024 * 4,
      );
      verticesData.set(vu);
      const tileLists = Array.from({ length: 64 }, () => []);
      for (let i = 0; i < input.length; i += 3) {
        const a = input.slice(i, i + 3),
          minX = Math.max(0, Math.ceil(Math.min(...a.map((v) => v[0])))),
          minY = Math.max(0, Math.ceil(Math.min(...a.map((v) => v[1])))),
          maxX = Math.min(63, Math.ceil(Math.max(...a.map((v) => v[0]))) - 1),
          maxY = Math.min(63, Math.ceil(Math.max(...a.map((v) => v[1]))) - 1);
        if (minX > maxX || minY > maxY) continue;
        for (let y = minY >> 3; y <= maxY >> 3; y++)
          for (let x = minX >> 3; x <= maxX >> 3; x++)
            tileLists[y * 8 + x].push(i / 3);
      }
      const headers = new Uint32Array(128),
        flat = [];
      tileLists.forEach((tile, i) => {
        headers[i * 2] = flat.length;
        headers[i * 2 + 1] = tile.length;
        flat.push(
          ...(new URLSearchParams(location.search).has("reverse")
            ? tile.slice().reverse()
            : tile),
        );
      });
      const indices = new Uint32Array(
        Math.max(1, Math.ceil(flat.length / 1024)) * 1024,
      );
      indices.set(flat);
      let initial = config[8];
      if (config[26] == 2 || config[26] == 10)
        initial = (initial & 0x00f8f8f8) | (initial & 0x80000000);
      initialColor.fill(initial);
      initialDepth.fill(config[9] & config[24]);
      upload(
        0,
        color,
        new Uint8Array(initialColor.buffer),
        64,
        64,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
      );
      upload(1, depth, initialDepth, 64, 64, gl.RED_INTEGER, gl.UNSIGNED_INT);
      upload(
        2,
        vertex,
        verticesData,
        1024,
        verticesData.length / 4096,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
      );
      upload(3, bins, headers, 8, 8, gl.RG_INTEGER, gl.UNSIGNED_INT);
      upload(
        4,
        lists,
        indices,
        1024,
        indices.length / 1024,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
      );
      const gpuConfig = config.slice();
      if (new URLSearchParams(location.search).has("negative"))
        gpuConfig[13] = 1;
      gl.uniform4uiv(gl.getUniformLocation(program, "settings[0]"), gpuConfig);
      let query;
      if (timer && name === "filtered-cutout-overlap") {
        query = gl.createQuery();
        gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (query) {
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        timerQueries.push({ name, query });
      }
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(
        0,
        0,
        64,
        64,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        actualColor,
      );
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(
        0,
        0,
        64,
        64,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        actualDepth,
      );
      const error = gl.getError();
      if (error) throw Error(name + ": GL " + error);
      reference.HEAPU32.set(config, configPtr / 4);
      reference.HEAPU8.set(new Uint8Array(vertexBytes), verticesPtr);
      if (
        reference._reference(
          configPtr,
          verticesPtr,
          input.length / 3,
          outputPtr,
        )
      )
        throw Error("CPU reference rejected input");
      const expected = reference.HEAPU32.subarray(
        outputPtr / 4,
        outputPtr / 4 + 8192,
      );
      let colorMismatches = 0,
        depthMismatches = 0,
        changedColorPixels = 0,
        changedDepthPixels = 0,
        samples = [];
      for (let i = 0; i < 4096; i++) {
        const at = i * 4,
          got =
            (actualColor[at] |
              (actualColor[at + 1] << 8) |
              (actualColor[at + 2] << 16) |
              (actualColor[at + 3] << 24)) >>>
            0;
        const ec = expected[i],
          ez = expected[4096 + i];
        changedColorPixels += ec !== initialColor[0];
        changedDepthPixels += ez !== initialDepth[0];
        colorMismatches += got !== ec;
        depthMismatches += actualDepth[at] !== ez;
        if ((got !== ec || actualDepth[at] !== ez) && samples.length < 8)
          samples.push({
            x: i % 64,
            y: i >> 6,
            actualColor: got,
            expectedColor: ec,
            actualDepth: actualDepth[at],
            expectedDepth: ez,
          });
      }
      const result = {
        name,
        colorMismatches,
        depthMismatches,
        changedColorPixels,
        changedDepthPixels,
        pixels: 4096,
        triangles: input.length / 3,
        glError: 0,
        samples,
      };
      results.push(result);
      if (colorMismatches || depthMismatches)
        throw Error(JSON.stringify(result));
    }
    for (let i = 0; i < 81; i++) {
      const c = baseConfig();
      const aa = Math.floor(i / 27),
        bb = Math.floor(i / 9) % 3,
        cc = Math.floor(i / 3) % 3,
        dd = i % 3;
      c[2] = aa | (bb << 2) | (cc << 4) | (dd << 6);
      run("blend-" + i, c, geometry());
    }
    for (let i = 0; i < 96; i++) {
      const c = baseConfig(),
        method = i % 8,
        failure = Math.floor(i / 8) % 4,
        alpha = 63 + Math.floor(i / 32);
      c[1] = 0x50000 | 1 | (method << 1) | (64 << 4) | (failure << 12);
      run("alpha-" + i, c, geometry(alpha));
    }
    for (let i = 0; i < 8; i++) {
      const c = baseConfig();
      c[1] = (1 << 16) | (i % 4 << 17);
      c[13] = i >> 2;
      run("depth-" + i, c, geometry());
    }
    for (let i = 0; i < 32; i++) {
      const c = baseConfig();
      c[5] = i & 1;
      c[6] = (i >> 1) & 1;
      c[7] = (i >> 2) & 1;
      c[8] = pack(172, 53, 195, i & 8 ? 192 : 64);
      c[4] = i & 16 ? 0x0f0ff0f0 : 0;
      c[2] = 0x80;
      c[1] = 0x50000 | (1 << 14) | (i & 8 ? 1 << 15 : 0);
      run("rules-" + i, c, geometry(192));
    }
    for (const scan of [2, 3]) {
      const c = baseConfig();
      c[10] = scan;
      run("scan-" + scan, c, geometry());
    }
    {
      const c = baseConfig();
      c[11] = 3 | (52 << 16);
      c[12] = 7 | (55 << 16);
      run("scissor", c, geometry());
    }
    {
      const c = baseConfig();
      c[9] = 0xffff0000;
      const v = geometry();
      for (let i = 0; i < v.length; i++)
        v[i][2] = i < 6 ? 0xffffff00 : i < 12 ? 0xfffffe00 : 0xffffff80;
      run("depth32-precision", c, v);
    }
    {
      const c = baseConfig();
      const v = geometry();
      for (let i = 0; i < v.length; i += 3)
        [v[i + 1], v[i + 2]] = [v[i + 2], v[i + 1]];
      run("reverse-winding", c, v);
    }
    {
      const c = baseConfig();
      c[0] |= 8;
      const v = quad(8, 8, 32, 32, 200, pack(128, 64, 32, 64));
      for (let i = 0; i < v.length; i++) {
        v[i][2] += (i % 3) * 16;
        v[i][3] = pack(32 + (i % 3) * 32, 64, 128, 64 + (i % 3) * 32);
      }
      run("interpolated", c, v);
    }
    for (let mode = 0; mode < 4; mode++)
      for (let filter = 0; filter < 2; filter++)
        for (let textureFunction = 0; textureFunction < 4; textureFunction++)
          for (let tcc = 0; tcc < 2; tcc++) {
            const c = baseConfig();
            c[0] |= 16 | 256;
            c[1] = 0x50000 | 1 | (6 << 1) | (92 << 4) | (1 << 12);
            c[14] = textureFunction | (tcc << 2);
            c[15] = filter;
            c[16] = mode | (mode << 2);
            c[17] = c[19] = mode == 3 ? 31 : 8;
            c[18] = c[20] = mode == 3 ? 16 : 47;
            const v = geometry(128);
            for (const p of v) {
              p[4] = (p[0] + 32) * 16 + 4;
              p[5] = (p[1] + 32) * 16 + 12;
              p[6] = 1;
            }
            run(
              "texture-" +
                mode +
                "-" +
                filter +
                "-" +
                textureFunction +
                "-" +
                tcc,
              c,
              v,
            );
          }
    for (let fixed = 0; fixed < 2; fixed++)
      for (let fog = 0; fog < 2; fog++) {
        const c = baseConfig();
        c[0] |= 16 | (fixed ? 256 : 0) | (fog ? 32 : 0);
        c[14] = 4;
        c[15] = 1;
        c[21] = pack(40, 80, 160, 0);
        const v = geometry(128);
        for (let i = 0; i < v.length; i++) {
          const p = v[i];
          p[4] = fixed ? p[0] * 16 + 4 : p[0] / 64;
          p[5] = fixed ? p[1] * 16 + 12 : p[1] / 64;
          p[6] = 1;
          p[7] = 64 + (i % 3) * 32;
        }
        run("perspective-fog-" + fixed + "-" + fog, c, v);
      }
    let seed = 0x26051;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let n = 0; n < 64; n++) {
      const c = baseConfig();
      c[0] = 3 | 64 | (n & 1 ? 16 : 0) | (n & 2 ? 256 : 0) | (n & 4 ? 32 : 0);
      c[1] =
        (1 << 16) |
        (random() % 4 << 17) |
        1 |
        (random() % 8 << 1) |
        (random() % 256 << 4) |
        (random() % 4 << 12);
      if (n & 8) c[1] |= (1 << 14) | (n & 16 ? 1 << 15 : 0);
      c[2] =
        random() % 3 |
        (random() % 3 << 2) |
        (random() % 3 << 4) |
        (random() % 3 << 6);
      c[3] = random() % 256;
      c[4] = [0, 0x0f0ff0f0, 0xff000000, 0xf0f00f0f][n % 4];
      c[5] = n & 1;
      c[6] = (n >> 1) & 1;
      c[7] = (n >> 2) & 1;
      c[8] = random();
      c[13] = (n >> 3) & 1;
      c[14] = n % 4 | (n & 4 ? 4 : 0);
      c[15] = n & 1;
      const mode = n % 4;
      c[16] = mode | (mode << 2);
      c[17] = c[19] = mode == 3 ? 31 : 8;
      c[18] = c[20] = mode == 3 ? 16 : 47;
      c[21] = random() & 0xffffff;
      const v = [];
      for (let q = 0; q < 12; q++) {
        const x = (random() % 8) * 8,
          y = (random() % 8) * 8,
          size = 8 << random() % 3;
        const points = quad(
          x,
          y,
          size,
          size,
          100 + (random() % 8) * 25,
          random(),
        );
        const divisor = [0, 0.5, 1, 2][q % 4];
        for (let j = 0; j < points.length; j++) {
          const p = points[j];
          p[4] = c[0] & 256 ? (p[0] + 16) * 16 + 4 : (p[0] - 16) / 64;
          p[5] = c[0] & 256 ? (p[1] + 16) * 16 + 12 : (p[1] - 16) / 64;
          p[6] = divisor;
          p[7] = 64 + (j % 3) * 32;
        }
        v.push(...points);
      }
      run("seeded-overlap-" + n, c, v);
    }
    for (let kind = 1; kind <= 3; kind++)
      for (let mode = 0; mode < (kind == 1 ? 1 : 4); mode++)
        for (let filter = 0; filter < 2; filter++)
          for (let textureFunction = 0; textureFunction < 4; textureFunction++)
            for (let tcc = 0; tcc < 2; tcc++) {
              const c = baseConfig();
              c[0] |= 16 | 256;
              c[1] = 0x50000 | 1 | (6 << 1) | (92 << 4) | (1 << 12);
              c[25] = kind;
              c[14] = textureFunction | (tcc << 2);
              c[15] = filter;
              c[16] = mode | (mode << 2);
              c[17] = c[19] = mode == 3 ? 31 : 8;
              c[18] = c[20] = mode == 3 ? 16 : 47;
              const v = geometry(128);
              for (const p of v) {
                p[4] = (p[0] + 32) * 16 + 4;
                p[5] = (p[1] + 32) * 16 + 12;
                p[6] = 1;
              }
              run(
                "indexed-" +
                  kind +
                  "-" +
                  mode +
                  "-" +
                  filter +
                  "-" +
                  textureFunction +
                  "-" +
                  tcc,
                c,
                v,
              );
            }
    for (const frameFormat of [0, 1, 2, 10])
      for (const depthFormat of [0, 1, 2, 10])
        for (let rule = 0; rule < 8; rule++) {
          const c = baseConfig();
          c[26] = frameFormat;
          c[27] = depthFormat;
          c[24] =
            depthFormat == 0
              ? 0xffffffff
              : depthFormat == 1
                ? 0xffffff
                : 0xffff;
          c[6] = rule & 1;
          c[5] = (rule >> 1) & 1;
          c[4] = rule & 4 ? 0x3fff0ff0 : 0;
          c[1] |= 1 | (6 << 1) | (92 << 4) | (rule % 4 << 12);
          c[0] |= 16 | 256;
          c[25] = 2 + (rule & 1);
          c[15] = rule & 1;
          c[14] = 4;
          const v = geometry(128);
          for (const p of v) {
            p[4] = p[0] * 16 + 4;
            p[5] = p[1] * 16 + 12;
            p[6] = 1;
            p[2] += rule & 2 ? 0x1000000 : 0;
          }
          run("formats-" + frameFormat + "-" + depthFormat + "-" + rule, c, v);
        }
    for (let sourceFormat = 0; sourceFormat < 4; sourceFormat++)
      for (let ta = 0; ta < 4; ta++)
        for (let aem = 0; aem < 2; aem++)
          for (let filter = 0; filter < 2; filter++) {
            const c = baseConfig();
            c[0] |= 16 | 256;
            c[1] |= 1 | (6 << 1) | (92 << 4) | (1 << 12);
            c[25] = sourceFormat < 2 ? 1 : sourceFormat == 2 ? 2 : 3;
            c[29] = sourceFormat == 1 ? 2 : 1;
            c[28] =
              (ta & 1 ? 64 : 0) | ((ta & 2 ? 255 : 128) << 8) | (aem << 16);
            c[15] = filter;
            c[14] = 4;
            const v = geometry(128);
            for (const p of v) {
              p[4] = (p[0] - 8) * 16 + 8;
              p[5] = (p[1] - 8) * 16 + 8;
              p[6] = 1;
            }
            run(
              "texa-" + sourceFormat + "-" + ta + "-" + aem + "-" + filter,
              c,
              v,
            );
          }
    for (let filter = 0; filter < 2; filter++)
      for (let textureFunction = 0; textureFunction < 4; textureFunction++)
        for (let tcc = 0; tcc < 2; tcc++) {
          const c = baseConfig();
          c[0] |= 16 | 256;
          c[1] |= 1 | (6 << 1) | (92 << 4) | (1 << 12);
          c[25] = 4;
          c[15] = filter;
          c[14] = textureFunction | (tcc << 2);
          const v = geometry(128);
          for (const p of v) {
            p[4] = p[0] * 16 + 4;
            p[5] = p[1] * 16 + 12;
            p[6] = 1;
          }
          run(
            "alpha-index-" + filter + "-" + textureFunction + "-" + tcc,
            c,
            v,
          );
        }
    {
      const c = baseConfig();
      c[0] |= 16 | 256;
      c[1] = 0x515cd;
      c[24] = 0xffffff;
      c[27] = 1;
      c[25] = 3;
      c[15] = 1;
      c[14] = 4;
      const v = [];
      for (const [n, z] of [120, 130, 125, 150, 140, 175].entries()) {
        const points = quad(
          8 + (n % 3) * 8,
          8 + Math.floor(n / 3) * 8,
          32,
          32,
          z,
          pack(128, 128, 128, 128),
        );
        for (const p of points) {
          p[4] = (p[0] - 8) * 16 + 4;
          p[5] = (p[1] - 8) * 16 + 12;
          p[6] = 1;
        }
        v.push(...points);
      }
      run("filtered-cutout-overlap", c, v);
    }
    const gpuTimings = [];
    if (timerQueries.length) {
      const deadline = performance.now() + 2000;
      while (
        timerQueries.some(
          ({ query }) =>
            !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE),
        ) &&
        performance.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 16));
      const disjoint = !!gl.getParameter(timer.GPU_DISJOINT_EXT);
      for (const { name, query } of timerQueries) {
        const available = gl.getQueryParameter(
          query,
          gl.QUERY_RESULT_AVAILABLE,
        );
        gpuTimings.push({
          name,
          available,
          disjoint,
          nanoseconds:
            available && !disjoint
              ? gl.getQueryParameter(query, gl.QUERY_RESULT)
              : null,
          scope:
            "Single64x64 GPU batch,12 overlapping indexed/bilinear triangles. Excludes binning, uploads and guest CPU; not a frame-rate qualification.",
        });
        gl.deleteQuery(query);
      }
    }
    reference._free(configPtr);
    reference._free(verticesPtr);
    reference._free(outputPtr);
    const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    window.kernelResult = {
      passed: results.length,
      cases: results,
      gpuTimings,
      renderer: rendererInfo
        ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      milliseconds: performance.now() - started,
      errors: [],
      scope:
        "Ordered WebGL2 triangles versus unchanged CPU GS reference:32/24/16-bit color/depth, PSMT4/8/8H and32/24/16-bit textures, alpha/blend/masks/fog/clamp/filtering.64x64 controlled cases only; no full-game or performance qualification.",
    };
    log.textContent = JSON.stringify(
      {
        passed: results.length,
        milliseconds: window.kernelResult.milliseconds,
      },
      null,
      2,
    );
  } catch (e) {
    window.kernelResult = { error: e.message, stack: e.stack };
    log.textContent = e.stack;
    console.error(e);
  }
})();
