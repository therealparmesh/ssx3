(() => {
  const colors = Array.from({ length: 256 }, (_, i) => [
    (i * i * 3 + 17) & 255,
    (i * 29 + 31) & 255,
    (i * i * 11 + 7) & 255,
    (i * 37 + 13) & 255,
  ]);
  const coords = [
    [0, 0],
    [0.5, 0.5],
    [6.25, 3.75],
    [-0.25, 35.9],
    [63.875, 31.9375],
    [128.5, -64.5],
    [17.03125, 9.0625],
    [9.5, 19.5],
  ];
  const wrap = (n, axis, level, mode) => {
    const size = Math.max(1, (axis ? 32 : 64) >> level),
      lo = (axis ? 3 : 7) >> level,
      hi = (axis ? 22 : 47) >> level,
      mask = (axis ? 15 : 31) >> level,
      fix = (axis ? 8 : 16) >> level;
    if (mode === 0) return ((n % size) + size) % size;
    if (mode === 1) return Math.max(0, Math.min(size - 1, n));
    if (mode === 2) return Math.max(lo, Math.min(hi, n));
    return (n & mask) | fix;
  };
  const makeLevels = (format) =>
    Array.from({ length: 7 }, (_, level) => {
      const w = Math.max(1, 64 >> level),
        h = Math.max(1, 32 >> level),
        bytes = new Uint8Array(w * h * 4),
        words = new Uint16Array(w * h),
        decoded = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x,
            r = (x * 13 + y * 17 + level * 41) & 255,
            g = (x * 7 + y * 23 + level * 37) & 255,
            b = (x * 31 + y * 3 + level * 29) & 255,
            a = (x * 19 + y * 11 + level * 47) & 255;
          let c = [r, g, b, a];
          if (format === "idx4" || format === "idx8") {
            const index =
              (x * 3 + y * 5 + level * 7) % (format === "idx4" ? 16 : 256);
            c = [index, 0, 0, 0];
            decoded.push(colors[index]);
          } else if (format === "rgb16") {
            const rr = r & 31,
              gg = g & 31,
              bb = b & 31,
              aa = (x + y + level) & 1;
            words[i] = (rr << 11) | (gg << 6) | (bb << 1) | aa;
            const black = rr + gg + bb === 0;
            decoded.push([rr * 8, gg * 8, bb * 8, aa ? 211 : black ? 0 : 37]);
          } else if (format === "rgb24") {
            decoded.push([r, g, b, r + g + b === 0 ? 0 : 37]);
          } else decoded.push(c);
          bytes.set(c, i * 4);
        }
      return { w, h, bytes, words, decoded };
    });
  function expected(levels, uv, o) {
    const lod = o.fixed
      ? o.bias / 16
      : o.q === 0
        ? Infinity
        : o.bias / 16 - Math.log2(Math.abs(o.q)) * 2 ** o.scale;
    const levelColor = (level, linear) => {
      const scale = 2 ** level,
        u = uv[0] / scale,
        v = uv[1] / scale,
        l = levels[level],
        texel = (x, y) =>
          l.decoded[
            wrap(y, 1, level, o.wrap) * l.w + wrap(x, 0, level, o.wrap)
          ];
      if (!linear) return texel(Math.floor(u), Math.floor(v));
      const x = Math.floor(u - 0.5),
        y = Math.floor(v - 0.5),
        fx = Math.floor((u - 0.5 - x) * 16),
        fy = Math.floor((v - 0.5 - y) * 16);
      const taps = [
          texel(x, y),
          texel(x + 1, y),
          texel(x, y + 1),
          texel(x + 1, y + 1),
        ],
        weights = [
          (16 - fx) * (16 - fy),
          fx * (16 - fy),
          (16 - fx) * fy,
          fx * fy,
        ];
      return [0, 1, 2, 3].map((c) =>
        Math.floor(
          taps.reduce((sum, t, i) => sum + t[c] * weights[i], 0) / 256,
        ),
      );
    };
    if (lod <= 0) return levelColor(0, !!o.mag);
    if (o.min < 2) return levelColor(0, o.min === 1);
    const selected = Math.min(o.maximum, Math.max(0, lod));
    if (o.min % 2 === 0)
      return levelColor(
        Math.min(o.maximum, Math.floor(selected + 0.5)),
        o.min >= 4,
      );
    const lo = Math.floor(selected),
      hi = Math.min(o.maximum, lo + 1),
      fraction = Math.floor((selected - lo) * 65536),
      a = levelColor(lo, o.min >= 4),
      b = levelColor(hi, o.min >= 4);
    return a.map((n, i) =>
      Math.floor((n * (65536 - fraction) + b[i] * fraction) / 65536),
    );
  }

  window.MipOracle = { colors, coords, makeLevels, expected };
})();
