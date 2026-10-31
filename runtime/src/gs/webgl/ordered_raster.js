/* Experimental GPU-only bridge for ordered_raster.frag. See the fixture README.
 * External textures/framebuffers remain owned by the host. The host must restore
 * its GL state after render() and split batches at resource/feedback hazards.
 */
class Ps2OrderedRaster {
  constructor(gl, fragmentSource) {
    this.gl = gl;
    this.textures = new Set();
    this.framebuffers = new Set();
    this.programs = new Set();
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.uniforms = new Map();
    this.targetSets = new Map();
    this.width = 0;
    this.height = 0;
    this.stats = {
      batches: 0,
      primitives: 0,
      triangles: 0,
      lines: 0,
      sprites: 0,
      rasterDraws: 0,
      readbacks: 0,
      depthBlits: 0,
      depthBypasses: 0,
      opaqueBatches: 0,
      opaqueTriangles: 0,
      depthFreeOpaqueBatches: 0,
    };
    try {
      this.vao = gl.createVertexArray();
      this.sampler = gl.createSampler();
      gl.samplerParameteri(this.sampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.samplerParameteri(this.sampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.samplerParameteri(this.sampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(this.sampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const vertexSource = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`;
      this.kernel = this.program(vertexSource, fragmentSource);
      const opaqueVertexSource = `#version 300 es
precision highp float;precision highp int;
uniform highp usampler2D vertices;uniform vec2 targetSize;
flat out uint primitiveIndex;
void main(){uint at=uint(gl_VertexID)*2u;uvec4 v=texelFetch(vertices,ivec2(int(at%1024u),int(at/1024u)),0);vec2 p=uintBitsToFloat(v.xy);primitiveIndex=uint(gl_VertexID)/3u;gl_Position=vec4((p+vec2(0.5))/targetSize*2.0-1.0,0,1);}`;
      this.opaque = this.program(
        opaqueVertexSource,
        fragmentSource.replace(
          "#version 300 es",
          "#version 300 es\n#define ORDERED_OPAQUE_HARDWARE 1",
        ),
      );
      this.opaqueNoDepth = this.program(
        opaqueVertexSource,
        fragmentSource.replace(
          "#version 300 es",
          "#version 300 es\n#define ORDERED_OPAQUE_HARDWARE 1\n#define ORDERED_HARDWARE_NO_DEPTH 1",
        ),
      );
      const mipSource = fragmentSource.replace(
        "#version 300 es",
        "#version 300 es\n#define ORDERED_MIP_SAMPLING 1",
      );
      this.mipKernel = this.program(vertexSource, mipSource);
      this.mipOpaque = this.program(
        opaqueVertexSource,
        mipSource.replace(
          "#version 300 es",
          "#version 300 es\n#define ORDERED_OPAQUE_HARDWARE 1",
        ),
      );
      this.mipOpaqueNoDepth = this.program(
        opaqueVertexSource,
        mipSource.replace(
          "#version 300 es",
          "#version 300 es\n#define ORDERED_OPAQUE_HARDWARE 1\n#define ORDERED_HARDWARE_NO_DEPTH 1",
        ),
      );
      // Z24 values are exact dyadic D32F values. Adding 0.5 after scaling
      // would round odd values near 0xffffff up to the next integer.
      this.initialize = this.program(
        vertexSource,
        `#version 300 es
precision highp float;precision highp int;
uniform sampler2D colorSource;uniform highp sampler2D depthSource;uniform uint frameFormat;uniform bool depthRequired;
layout(location=0) out uvec4 colorOutput;layout(location=1) out uint depthOutput;
void main(){ivec2 p=ivec2(gl_FragCoord.xy);colorOutput=uvec4(floor(texelFetch(colorSource,p,0)*255.0+vec4(0.5)));if(frameFormat==2u||frameFormat==10u){colorOutput.rgb=(colorOutput.rgb>>3u)<<3u;colorOutput.a=(colorOutput.a&128u)!=0u?128u:0u;}if(!depthRequired){depthOutput=0u;return;}float d=texelFetch(depthSource,p,0).r;depthOutput=d>=1.0?0xffffffffu:uint(d*4294967296.0);}`,
      );
      this.resolve = this.program(
        vertexSource,
        `#version 300 es
precision highp float;precision highp int;
uniform highp usampler2D colorSource;uniform highp usampler2D depthSource;
out vec4 colorOutput;
void main(){ivec2 p=ivec2(gl_FragCoord.xy);colorOutput=vec4(texelFetch(colorSource,p,0))/255.0;gl_FragDepth=float(texelFetch(depthSource,p,0).r)/4294967296.0;}`,
      );
      this.dummyInteger = this.texture(gl.RGBA8UI, 1, 1);
      this.dummyNormalized = this.texture(gl.RGBA8, 1, 1);
      this.vertexData = null;
      this.indexData = null;
      this.boundsScratch = new Uint32Array(0);
      this.indicesScratch = new Uint32Array(0);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  program(vertexSource, fragmentSource) {
    const gl = this.gl;
    const program = gl.createProgram();
    const shaders = [];
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertexSource],
        [gl.FRAGMENT_SHADER, fragmentSource],
      ]) {
        const shader = gl.createShader(type);
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw Error(gl.getProgramInfoLog(program));
      this.programs.add(program);
      return program;
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  texture(format, width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + 12);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.textures.add(texture);
    return texture;
  }

  framebuffer() {
    const framebuffer = this.gl.createFramebuffer();
    this.framebuffers.add(framebuffer);
    return framebuffer;
  }

  deleteTexture(texture) {
    if (texture) {
      this.gl.deleteTexture(texture);
      this.textures.delete(texture);
    }
  }

  targets(width, height) {
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    if (
      width <= 0 ||
      height <= 0 ||
      width > this.maxTextureSize ||
      height > this.maxTextureSize
    )
      throw Error("Unsupported ordered raster target size");
    const fields = [
      "inputColor",
      "inputDepth",
      "outputColor",
      "outputDepth",
      "depthCopy",
      "headersTexture",
      "inputFramebuffer",
      "outputFramebuffer",
      "depthReadFramebuffer",
      "depthCopyFramebuffer",
      "width",
      "height",
      "tilesX",
      "tilesY",
      "headerScratch",
      "tileCounts",
      "sourceDepthRenderbuffer",
    ];
    if (this.activeTargetSet)
      for (const field of fields) this.activeTargetSet[field] = this[field];
    const key = width + "x" + height,
      cached = this.targetSets.get(key);
    if (cached) {
      Object.assign(this, cached);
      this.activeTargetSet = cached;
      this.targetSets.delete(key);
      this.targetSets.set(key, cached);
      return;
    }
    if (this.targetSets.size >= 4) {
      const oldKey = this.targetSets.keys().next().value,
        old = this.targetSets.get(oldKey);
      for (const field of [
        "inputColor",
        "inputDepth",
        "outputColor",
        "outputDepth",
        "depthCopy",
        "headersTexture",
      ])
        this.deleteTexture(old[field]);
      for (const field of [
        "inputFramebuffer",
        "outputFramebuffer",
        "depthReadFramebuffer",
        "depthCopyFramebuffer",
      ]) {
        gl.deleteFramebuffer(old[field]);
        this.framebuffers.delete(old[field]);
      }
      this.targetSets.delete(oldKey);
    }
    this.inputColor = this.texture(gl.RGBA8UI, width, height);
    this.inputDepth = this.texture(gl.R32UI, width, height);
    this.outputColor = this.texture(gl.RGBA8UI, width, height);
    this.outputDepth = this.texture(gl.R32UI, width, height);
    this.depthCopy = this.texture(gl.DEPTH_COMPONENT32F, width, height);
    this.tilesX = Math.ceil(width / 8);
    this.tilesY = Math.ceil(height / 8);
    this.headerScratch = new Uint32Array(0);
    this.tileCounts = new Uint32Array(this.tilesX * this.tilesY);
    this.sourceDepthRenderbuffer = null;
    this.headersTexture = this.texture(gl.RG32UI, this.tilesX, this.tilesY);
    this.inputFramebuffer = this.framebuffer();
    this.outputFramebuffer = this.framebuffer();
    this.depthReadFramebuffer = this.framebuffer();
    this.depthCopyFramebuffer = this.framebuffer();
    for (const [framebuffer, color, depth] of [
      [this.inputFramebuffer, this.inputColor, this.inputDepth],
      [this.outputFramebuffer, this.outputColor, this.outputDepth],
    ]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        color,
        0,
      );
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT1,
        gl.TEXTURE_2D,
        depth,
        0,
      );
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      this.complete();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthCopyFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      this.depthCopy,
      0,
    );
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    this.complete();
    this.width = width;
    this.height = height;
    this.activeTargetSet = Object.fromEntries(
      fields.map((field) => [field, this[field]]),
    );
    this.targetSets.set(key, this.activeTargetSet);
  }

  complete() {
    if (
      this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) !==
      this.gl.FRAMEBUFFER_COMPLETE
    )
      throw Error("Incomplete ordered raster framebuffer");
  }

  dataTexture(name, words, components) {
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil(words.length / (1024 * components)));
    if (rows > this.maxTextureSize)
      throw Error("Ordered raster batch exceeds texture capacity");
    if (!this[name] || this[name + "Rows"] < rows) {
      this.deleteTexture(this[name]);
      this[name + "Rows"] = Math.min(
        this.maxTextureSize,
        2 ** Math.ceil(Math.log2(rows)),
      );
      this[name] = this.texture(
        components === 4 ? gl.RGBA32UI : gl.R32UI,
        1024,
        this[name + "Rows"],
      );
    }
    gl.activeTexture(gl.TEXTURE0 + 12);
    gl.bindTexture(gl.TEXTURE_2D, this[name]);
    const rowWords = 1024 * components,
      fullRows = Math.floor(words.length / rowWords),
      tail = words.length - fullRows * rowWords;
    const format = components === 4 ? gl.RGBA_INTEGER : gl.RED_INTEGER;
    if (fullRows)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        1024,
        fullRows,
        format,
        gl.UNSIGNED_INT,
        words.subarray(0, fullRows * rowWords),
      );
    if (tail)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        fullRows,
        tail / components,
        1,
        format,
        gl.UNSIGNED_INT,
        words.subarray(fullRows * rowWords),
      );
  }

  uniform(program, name) {
    let entries = this.uniforms.get(program);
    if (!entries) this.uniforms.set(program, (entries = new Map()));
    let entry = entries.get(name);
    if (!entry) {
      entry = { location: this.gl.getUniformLocation(program, name) };
      entries.set(name, entry);
    }
    return entry;
  }

  bind(program, name, unit, texture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const uniform = this.uniform(program, name);
    if (uniform.unit !== unit) {
      gl.uniform1i(uniform.location, unit);
      uniform.unit = unit;
    }
  }

  bindMipTextures(program, levels, settings) {
    const maximum =
      ((settings[30] >>> 6) & 7) >= 2 ? (settings[30] >>> 2) & 7 : 0;
    for (let i = 1; i <= 6; i++) {
      this.bind(
        program,
        "mipTexture" + i,
        8 + i,
        (i <= maximum && levels[i - 1]) || this.dummyNormalized,
      );
      this.gl.bindSampler(8 + i, this.sampler);
    }
  }

  releaseMipSamplers() {
    for (let unit = 9; unit <= 14; unit++) this.gl.bindSampler(unit, null);
  }

  render({
    targetFramebuffer,
    colorTexture,
    depthRenderbuffer,
    width,
    height,
    settings,
    vertexWords,
    texture,
    palette,
    integerTexture,
    mipTextures = [],
  }) {
    const gl = this.gl;
    if (this.destroyed) throw Error("Ordered raster bridge was destroyed");
    if (gl.isContextLost()) throw Error("Ordered raster context is lost");
    if (
      !(settings instanceof Uint32Array) ||
      !(vertexWords instanceof Uint32Array) ||
      settings.length !== 32 ||
      vertexWords.length % 24 !== 0
    )
      throw Error("Invalid ordered raster packet");
    if (!targetFramebuffer || !colorTexture || !depthRenderbuffer)
      throw Error("Missing ordered raster target");
    if (settings[0] & 16) {
      if (settings[25] === 0 && !integerTexture)
        throw Error("Missing integer source texture");
      if (settings[25] !== 0 && !texture)
        throw Error("Missing normalized source texture");
      if (settings[25] >= 2 && !palette) throw Error("Missing source palette");
    }
    if (!Array.isArray(mipTextures)) throw Error("Invalid mip texture list");
    const mipSampling = (settings[30] & 0x80000000) !== 0;
    if (mipSampling && settings[0] & 16) {
      const maximum = (settings[30] >>> 2) & 7;
      const minification = (settings[30] >>> 6) & 7;
      if (maximum > 6 || minification > 5)
        throw Error("Reserved mip sampling mode");
      if (settings[25] === 0)
        throw Error("Mip sampling requires normalized index/color views");
      for (const size of [settings[22], settings[23]])
        if (!size || size > 1024 || size & (size - 1))
          throw Error("Invalid mip source dimensions");
      for (let i = 0; i < (minification >= 2 ? maximum : 0); i++) {
        if (!mipTextures[i]) throw Error("Missing mip level " + (i + 1));
        if (mipTextures[i] === colorTexture || mipTextures[i] === palette)
          throw Error("Mip feedback requires host hazard resolution");
      }
    }
    if (!settings[22] || !settings[23])
      throw Error("Invalid source dimensions");
    // D32F cannot recover all integer Z32 values. The transitional bridge only
    // accepts a 24-bit or smaller depth domain and supported normalized GS color views.
    if (![0, 1, 2, 10].includes(settings[26]) || settings[24] > 0xffffff)
      throw Error("Unsupported transitional color/depth view");
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > this.maxTextureSize ||
      height > this.maxTextureSize
    )
      throw Error("Unsupported ordered raster target size");
    if (!vertexWords.length) return;
    // Depth can affect neither comparison nor writes when ZTE is off, or
    // when ZTST is ALWAYS and ZMSK prevents writes. Preserve the host buffer.
    const depthRequired =
      (settings[1] & 65536) !== 0 &&
      (((settings[1] >>> 17) & 3) >= 2 || settings[13] === 0);
    const primitiveKind = settings[0] & 7,
      blend = settings[2];
    const identityBlend =
      (blend & 3) === ((blend >>> 2) & 3) && ((blend >>> 6) & 3) === 0;
    // FBONLY pass/fail results coincide when depth cannot be written.
    // Depth comparison remains active; only the alpha decision is redundant.
    const depthWrites = (settings[1] & 65536) !== 0 && settings[13] === 0;
    const alphaNoEffect =
      (settings[1] & 1) === 0 ||
      ((settings[1] >>> 1) & 7) === 1 ||
      (((settings[1] >>> 12) & 3) === 1 && !depthWrites);
    if (
      [3, 4, 5].includes(primitiveKind) &&
      [0, 2, 10].includes(settings[26]) &&
      settings[27] === 1 &&
      settings[24] === 0xffffff &&
      settings[4] === 0 &&
      (settings[1] & 16384) === 0 &&
      alphaNoEffect &&
      ((settings[0] & 64) === 0 || identityBlend) &&
      texture !== colorTexture &&
      palette !== colorTexture &&
      integerTexture !== colorTexture
    ) {
      this.renderOpaque({
        targetFramebuffer,
        width,
        height,
        settings,
        vertexWords,
        texture,
        palette,
        integerTexture,
        mipTextures,
      });
      return;
    }
    this.targets(width, height);
    const kind = settings[0] & 7;
    if (![1, 2, 3, 4, 5, 6].includes(kind))
      throw Error("Unsupported ordered raster primitive");
    const line = kind === 1 || kind === 2;
    const positions = new Float32Array(
      vertexWords.buffer,
      vertexWords.byteOffset,
      vertexWords.length,
    );
    if (line) {
      for (let at = 0; at < positions.length; at += 8)
        for (const coordinate of [positions[at], positions[at + 1]])
          if (
            !Number.isFinite(coordinate) ||
            Math.abs(coordinate) > 4096 ||
            !Number.isInteger(coordinate * 16)
          )
            throw Error("Line coordinates must use the GS 12.4 domain");
    }
    const primitiveCount = vertexWords.length / 24;
    if (this.boundsScratch.length < primitiveCount * 5)
      this.boundsScratch = new Uint32Array(
        2 ** Math.ceil(Math.log2(Math.max(1, primitiveCount * 5))),
      );
    const bounds = this.boundsScratch,
      counts = this.tileCounts;
    counts.fill(0);
    let usedBounds = 0,
      count = 0;
    let left = width,
      bottom = height,
      right = 0,
      top = 0;
    const scissorX = settings[11],
      scissorY = settings[12];
    for (let i = 0; i < vertexWords.length; i += 24) {
      const x0 = Math.max(
        0,
        scissorX & 65535,
        Math.ceil(Math.min(positions[i], positions[i + 8], positions[i + 16])) -
          (line ? 1 : 0),
      );
      const y0 = Math.max(
        0,
        scissorY & 65535,
        Math.ceil(
          Math.min(positions[i + 1], positions[i + 9], positions[i + 17]),
        ) - (line ? 1 : 0),
      );
      const x1 = Math.min(
        width - 1,
        scissorX >>> 16,
        Math.ceil(Math.max(positions[i], positions[i + 8], positions[i + 16])) +
          (line ? 1 : -1),
      );
      const y1 = Math.min(
        height - 1,
        scissorY >>> 16,
        Math.ceil(
          Math.max(positions[i + 1], positions[i + 9], positions[i + 17]),
        ) + (line ? 1 : -1),
      );
      if (
        !Number.isFinite(x0) ||
        !Number.isFinite(y0) ||
        !Number.isFinite(x1) ||
        !Number.isFinite(y1)
      )
        throw Error("Invalid ordered raster coordinates");
      if (x0 > x1 || y0 > y1) continue;
      left = Math.min(left, x0);
      bottom = Math.min(bottom, y0);
      right = Math.max(right, x1 + 1);
      top = Math.max(top, y1 + 1);
      const bx0 = x0 >> 3,
        by0 = y0 >> 3,
        bx1 = x1 >> 3,
        by1 = y1 >> 3;
      bounds[usedBounds++] = bx0;
      bounds[usedBounds++] = by0;
      bounds[usedBounds++] = bx1;
      bounds[usedBounds++] = by1;
      bounds[usedBounds++] = i / 24;
      count += (bx1 - bx0 + 1) * (by1 - by0 + 1);
      for (let y = by0; y <= by1; y++)
        for (let x = bx0; x <= bx1; x++) counts[y * this.tilesX + x]++;
    }
    if (left >= right || bottom >= top) return;
    if (count > this.maxTextureSize * 1024)
      throw Error("Ordered raster batch exceeds texture capacity");
    if (this.indicesScratch.length < count)
      this.indicesScratch = new Uint32Array(
        2 ** Math.ceil(Math.log2(Math.max(1, count))),
      );
    const indices = this.indicesScratch.subarray(0, count);
    const tileLeft = left >> 3,
      tileBottom = bottom >> 3,
      tileWidth = ((right - 1) >> 3) - tileLeft + 1,
      tileHeight = ((top - 1) >> 3) - tileBottom + 1;
    const headerLength = tileWidth * tileHeight * 2;
    if (this.headerScratch.length < headerLength)
      this.headerScratch = new Uint32Array(headerLength);
    const headers = this.headerScratch.subarray(0, headerLength);
    let offset = 0,
      header = 0;
    for (let y = tileBottom; y < tileBottom + tileHeight; y++)
      for (let x = tileLeft; x < tileLeft + tileWidth; x++) {
        const key = y * this.tilesX + x,
          size = counts[key];
        headers[header++] = offset;
        headers[header++] = size;
        counts[key] = offset;
        offset += size;
      }
    // Scatter primitives in submission order into the prefix-summed ranges.
    // Reuse typed storage instead of allocating a Map and one Array per tile.
    for (let at = 0; at < usedBounds; at += 5)
      for (let y = bounds[at + 1]; y <= bounds[at + 3]; y++)
        for (let x = bounds[at]; x <= bounds[at + 2]; x++)
          indices[counts[y * this.tilesX + x]++] = bounds[at + 4];
    this.dataTexture("vertexData", vertexWords, 4);
    this.dataTexture("indexData", indices, 1);
    gl.activeTexture(gl.TEXTURE0 + 12);
    gl.bindTexture(gl.TEXTURE_2D, this.headersTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      tileLeft,
      tileBottom,
      tileWidth,
      tileHeight,
      gl.RG_INTEGER,
      gl.UNSIGNED_INT,
      headers,
    );
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.depthMask(false);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.vao);
    if (depthRequired) {
      if (this.sourceDepthRenderbuffer !== depthRenderbuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthReadFramebuffer);
        gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.RENDERBUFFER,
          depthRenderbuffer,
        );
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
        this.complete();
        this.sourceDepthRenderbuffer = depthRenderbuffer;
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.depthReadFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthCopyFramebuffer);
      gl.blitFramebuffer(
        left,
        bottom,
        right,
        top,
        left,
        bottom,
        right,
        top,
        gl.DEPTH_BUFFER_BIT,
        gl.NEAREST,
      );
      this.stats.depthBlits++;
    } else this.stats.depthBypasses++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.inputFramebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(left, bottom, right - left, top - bottom);
    gl.useProgram(this.initialize);
    gl.uniform1i(
      this.uniform(this.initialize, "depthRequired").location,
      depthRequired ? 1 : 0,
    );
    this.bind(this.initialize, "colorSource", 0, colorTexture);
    this.bind(this.initialize, "depthSource", 1, this.depthCopy);
    gl.uniform1ui(
      this.uniform(this.initialize, "frameFormat").location,
      settings[26],
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputFramebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const kernel = mipSampling ? this.mipKernel : this.kernel;
    gl.useProgram(kernel);
    for (const [name, unit, input] of [
      ["initialColor", 0, this.inputColor],
      ["initialDepth", 1, this.inputDepth],
      ["vertices", 2, this.vertexData],
      ["bins", 3, this.headersTexture],
      ["lists", 4, this.indexData],
      ["sourceTexture", 5, integerTexture || this.dummyInteger],
      ["normalizedTexture", 7, texture || this.dummyNormalized],
      ["paletteTexture", 8, palette || this.dummyNormalized],
    ])
      this.bind(kernel, name, unit, input);
    gl.bindSampler(7, this.sampler);
    gl.bindSampler(8, this.sampler);
    if (mipSampling) this.bindMipTextures(kernel, mipTextures, settings);
    gl.uniform4uiv(this.uniform(kernel, "settings[0]").location, settings);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (mipSampling) this.releaseMipSamplers();
    gl.bindSampler(7, null);
    gl.bindSampler(8, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.useProgram(this.resolve);
    this.bind(this.resolve, "colorSource", 0, this.outputColor);
    this.bind(this.resolve, "depthSource", 1, this.outputDepth);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.depthMask(depthRequired);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The host checks errors at its frame boundary; querying after every batch
    // would force repeated GL command round trips. The fixture checks each case.
    this.stats.batches++;
    this.stats.primitives += vertexWords.length / 24;
    this.stats[line ? "lines" : kind === 6 ? "sprites" : "triangles"] +=
      vertexWords.length / 24;
    this.stats.rasterDraws += 3;
  }

  renderOpaque({
    targetFramebuffer,
    width,
    height,
    settings,
    vertexWords,
    texture,
    palette,
    integerTexture,
    mipTextures = [],
  }) {
    const gl = this.gl;
    const positions = new Float32Array(
      vertexWords.buffer,
      vertexWords.byteOffset,
      vertexWords.length,
    );
    for (let at = 0; at < positions.length; at += 8)
      if (
        !Number.isFinite(positions[at]) ||
        !Number.isFinite(positions[at + 1])
      )
        throw Error("Invalid ordered raster coordinates");
    this.dataTexture("vertexData", vertexWords, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.vao);
    const zte = (settings[1] & 65536) !== 0;
    const depthFree =
      !zte || (((settings[1] >>> 17) & 3) === 1 && settings[13] !== 0);
    const mipSampling = (settings[30] & 0x80000000) !== 0;
    const program = mipSampling
      ? depthFree
        ? this.mipOpaqueNoDepth
        : this.mipOpaque
      : depthFree
        ? this.opaqueNoDepth
        : this.opaque;
    if (zte && !depthFree) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(
        [gl.NEVER, gl.ALWAYS, gl.GEQUAL, gl.GREATER][(settings[1] >>> 17) & 3],
      );
    } else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(zte && settings[13] === 0);
    gl.useProgram(program);
    for (const [name, unit, input] of [
      ["vertices", 2, this.vertexData],
      ["sourceTexture", 5, integerTexture || this.dummyInteger],
      ["normalizedTexture", 7, texture || this.dummyNormalized],
      ["paletteTexture", 8, palette || this.dummyNormalized],
    ])
      this.bind(program, name, unit, input);
    gl.bindSampler(7, this.sampler);
    gl.bindSampler(8, this.sampler);
    if (mipSampling) this.bindMipTextures(program, mipTextures, settings);
    gl.uniform2f(this.uniform(program, "targetSize").location, width, height);
    gl.uniform4uiv(this.uniform(program, "settings[0]").location, settings);
    gl.drawArrays(gl.TRIANGLES, 0, vertexWords.length / 8);
    if (mipSampling) this.releaseMipSamplers();
    gl.bindSampler(7, null);
    gl.bindSampler(8, null);
    const count = vertexWords.length / 24;
    this.stats.batches++;
    this.stats.primitives += count;
    this.stats.triangles += count;
    this.stats.rasterDraws++;
    this.stats.opaqueBatches++;
    if (depthFree) this.stats.depthFreeOpaqueBatches++;
    this.stats.opaqueTriangles += count;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    for (const texture of this.textures) gl.deleteTexture(texture);
    for (const framebuffer of this.framebuffers)
      gl.deleteFramebuffer(framebuffer);
    for (const program of this.programs) gl.deleteProgram(program);
    gl.deleteVertexArray(this.vao);
    gl.deleteSampler(this.sampler);
    this.textures.clear();
    this.framebuffers.clear();
    this.programs.clear();
    this.uniforms.clear();
    this.targetSets.clear();
    this.boundsScratch =
      this.indicesScratch =
      this.headerScratch =
      this.tileCounts =
        null;
    this.activeTargetSet = null;
  }
}

globalThis.Ps2OrderedRaster = Ps2OrderedRaster;
