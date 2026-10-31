#version 300 es
// Experimental ordered triangle/line/sprite rasterizer. The host must preserve
// resource lifetimes and split batches at feedback/VRAM hazards. See the
// asset-free protocol and qualification limits in
// tests/webgl_ordered/README.md. GS shading follows raster.cpp and gpu/gs.wgsl;
// distributed under LICENSE.
precision highp float;
precision highp int;
uniform highp usampler2D initialColor;
uniform highp usampler2D initialDepth;
uniform highp usampler2D vertices;
uniform highp usampler2D bins;
uniform highp usampler2D lists;
uniform highp usampler2D sourceTexture;
uniform sampler2D normalizedTexture;
uniform sampler2D paletteTexture;
#ifdef ORDERED_MIP_SAMPLING
uniform sampler2D mipTexture1;
uniform sampler2D mipTexture2;
uniform sampler2D mipTexture3;
uniform sampler2D mipTexture4;
uniform sampler2D mipTexture5;
uniform sampler2D mipTexture6;
#endif

uniform uvec4 settings[8];
#ifdef ORDERED_OPAQUE_HARDWARE
flat in uint primitiveIndex;
layout(location = 0) out vec4 outputColor;
#else
layout(location = 0) out uvec4 outputColor;
layout(location = 1) out uint outputDepth;
#endif
uint cfg(int i) { return settings[i >> 2][i & 3]; }
uvec4 loadVertex(uint i) {
  return texelFetch(vertices, ivec2(int(i % 1024u), int(i / 1024u)), 0);
}
uint loadIndex(uint i) {
  return texelFetch(lists, ivec2(int(i % 1024u), int(i / 1024u)), 0).r;
}
vec2 position(uvec4 v) { return uintBitsToFloat(v.xy); }
vec4 rgba(uint c) {
  return vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u),
              float(c >> 24));
}
bool edgeIn(float e, float gx, float gy) {
  return e > 0.0 || (e == 0.0 && (gx > 0.0 || (gx == 0.0 && gy > 0.0)));
}
uint packed(uvec4 v) { return v.r | (v.g << 8) | (v.b << 16) | (v.a << 24); }
uvec4 unpacked(uint c) { return uvec4(c, c >> 8, c >> 16, c >> 24) & 255u; }
uint pack16(uint c) {
  return ((c >> 3) & 31u) | (((c >> 11) & 31u) << 5) |
         (((c >> 19) & 31u) << 10) | ((c & 0x80000000u) != 0u ? 0x8000u : 0u);
}
uint expand16(uint c) {
  return ((c & 31u) << 3) | (((c >> 5) & 31u) << 11) |
         (((c >> 10) & 31u) << 19) | ((c & 0x8000u) != 0u ? 0x80000000u : 0u);
}
bool alphaPass(int alpha, uint test) {
  int ref = int((test >> 4) & 255u);
  switch ((test >> 1) & 7u) {
  case 0u:
    return false;
  case 1u:
    return true;
  case 2u:
    return alpha < ref;
  case 3u:
    return alpha <= ref;
  case 4u:
    return alpha == ref;
  case 5u:
    return alpha >= ref;
  case 6u:
    return alpha > ref;
  default:
    return alpha != ref;
  }
}
int wrapCoord(int v, int axis, int level) {
  uint mode = (cfg(16) >> uint(axis * 2)) & 3u;
  int lo = int(cfg(axis == 0 ? 17 : 19)), hi = int(cfg(axis == 0 ? 18 : 20));
  lo >>= level; hi >>= level;
  int size = max(1, int(cfg(axis == 0 ? 22 : 23)) >> level);
  if (mode == 0u)
    return v & (size - 1);
  if (mode == 1u)
    return clamp(v, 0, size - 1);
  if (mode == 2u)
    return clamp(v, lo, hi);
  return (v & lo) | hi;
}
vec4 normalizedMipTexel(ivec2 at, int level) {
  switch(level) {
#ifdef ORDERED_MIP_SAMPLING
  case 1: return texelFetch(mipTexture1,at,0);
  case 2: return texelFetch(mipTexture2,at,0);
  case 3: return texelFetch(mipTexture3,at,0);
  case 4: return texelFetch(mipTexture4,at,0);
  case 5: return texelFetch(mipTexture5,at,0);
  case 6: return texelFetch(mipTexture6,at,0);
#endif
  default: return texelFetch(normalizedTexture,at,0);
  }
}
vec4 sampleTexel(ivec2 at, int level) {
  at = ivec2(wrapCoord(at.x, 0, level), wrapCoord(at.y, 1, level));
  if (cfg(25) == 0u)
    return vec4(texelFetch(sourceTexture, at, 0));
  vec4 value = normalizedMipTexel(at, level);
  if (cfg(25) >= 2u)
    value = texelFetch(
        paletteTexture,
        ivec2(int(floor((cfg(25) == 4u ? value.a : value.r) * 255.0 + 0.5)), 0),
        0);
  vec4 decoded = floor(value * 255.0 + vec4(0.5));
  uint format = cfg(29) & 3u;
  if (format == 1u)
    decoded.rgb = floor(value.rgb * 31.0 + vec3(0.5)) * 8.0;
  if (format != 0u) {
    uint ta0 = cfg(28) & 255u, ta1 = (cfg(28) >> 8) & 255u;
    bool transparent =
        (cfg(28) & 65536u) != 0u && all(equal(decoded.rgb, vec3(0)));
    decoded.a = ((format == 1u && value.a >= 0.5) ||
                 (format == 3u && (uint(decoded.a) & 128u) != 0u))
                    ? float(ta1)
                : transparent ? 0.0
                              : float(ta0);
  }
  return decoded;
}
vec4 sampleTexel(ivec2 at) { return sampleTexel(at,0); }
ivec4 sampleBaseTexture(vec2 uv) {
  if ((cfg(15) & 1u) == 0u)
    return ivec4(sampleTexel(ivec2(floor(uv))));
  uv -= vec2(0.5);
  ivec2 at = ivec2(floor(uv));
  vec2 f = uv - vec2(at);
  vec4 a = sampleTexel(at), b = sampleTexel(at + ivec2(1, 0)),
       c = sampleTexel(at + ivec2(0, 1)), d = sampleTexel(at + ivec2(1));
  vec4 top = a + (b - a) * f.x, bottom = c + (d - c) * f.x;
  return ivec4(
      clamp(top + (bottom - top) * f.y + vec4(0.5), vec4(0), vec4(255)));
}
// TEX1 is opt-in in this packet revision; legacy packets retain their
// preceding level-zero filtering. Mip textures contain decoded index maps
// for paletted formats, so filtering always follows the palette lookup.
ivec4 sampleMipLevel(vec2 uv, int level, bool linearFilter) {
  uv /= exp2(float(level));
  if(!linearFilter) return ivec4(sampleTexel(ivec2(floor(uv)),level));
  uv -= vec2(0.5);
  ivec2 at=ivec2(floor(uv));
  ivec2 fraction=ivec2(floor(fract(uv)*16.0));
  ivec4 a=ivec4(sampleTexel(at,level));
  ivec4 b=ivec4(sampleTexel(at+ivec2(1,0),level));
  ivec4 c=ivec4(sampleTexel(at+ivec2(0,1),level));
  ivec4 d=ivec4(sampleTexel(at+ivec2(1),level));
  return (a*(16-fraction.x)*(16-fraction.y)+
          b*fraction.x*(16-fraction.y)+
          c*(16-fraction.x)*fraction.y+d*fraction.x*fraction.y)/256;
}
ivec4 sampleTexture(vec2 uv, float q) {
#ifndef ORDERED_MIP_SAMPLING
  return sampleBaseTexture(uv);
#else
  uint tex1=cfg(30);
  if((tex1&0x80000000u)==0u) return sampleBaseTexture(uv);
  float bias=float(int((cfg(31)&4095u)<<20u)>>20)/16.0;
  float lod=bias;
  if((tex1&1u)==0u) {
    // Zero Q selects the most reduced level; avoid infinity-to-int casts.
    lod= q==0.0 ? 128.0 : bias-log2(abs(q))*float(1u<<((tex1>>19u)&3u));
  }
  uint minFilter=(tex1>>6u)&7u;
  if(lod<=0.0) return sampleMipLevel(uv,0,(tex1&32u)!=0u);
  if(minFilter<2u) return sampleMipLevel(uv,0,minFilter==1u);
  int maximum=int(min((tex1>>2u)&7u,6u));
  lod=clamp(lod,0.0,float(maximum));
  bool linearFilter=minFilter>=4u;
  if((minFilter&1u)==0u) {
    int level=min(maximum,int(floor(lod+0.5)));
    return sampleMipLevel(uv,level,linearFilter);
  }
  int first=int(floor(lod)),second=min(maximum,first+1);
  int fraction=int(floor(fract(lod)*65536.0));
  return (sampleMipLevel(uv,first,linearFilter)*(65536-fraction)+
          sampleMipLevel(uv,second,linearFilter)*fraction)/65536;
#endif
}
ivec4 shade(uint i, uvec4 v0, uvec4 v1, uvec4 v2, vec2 p, vec2 a, vec2 b,
            uint kind, vec3 weights) {
  float w0 = weights.x, w1 = weights.y, w2 = weights.z;
  vec4 src = rgba(v2.a);
  if ((cfg(0) & 8u) != 0u)
    src = rgba(v0.a) * w0 + rgba(v1.a) * w1 + rgba(v2.a) * w2;
  ivec4 source = ivec4(src);
  uvec4 t0 = loadVertex(i + 1u), t1 = loadVertex(i + 3u),
        t2 = loadVertex(i + 5u);
  vec3 tex = uintBitsToFloat(t0.xyz) * w0 + uintBitsToFloat(t1.xyz) * w1 +
             uintBitsToFloat(t2.xyz) * w2;
  if (kind == 6u) {
    vec3 first = uintBitsToFloat(t0.xyz), last = uintBitsToFloat(t1.xyz);
    vec2 fraction = (p - a) / (b - a);
    tex = vec3(first.xy + (last.xy - first.xy) * fraction, last.z);
  }
  if ((cfg(0) & 16u) != 0u) {
    vec2 uv;
    if ((cfg(0) & 256u) != 0u)
      uv = tex.xy / 16.0;
    else
      uv = tex.xy / (tex.z == 0.0 ? 1.0 : tex.z) *
           vec2(float(cfg(22)), float(cfg(23)));
    ivec4 t = sampleTexture(uv,tex.z);
    int originalAlpha = source.a;
    uint textureFunction = cfg(14) & 3u;
    bool tcc = (cfg(14) & 4u) != 0u;
    if (textureFunction == 0u) {
      source.rgb = clamp((t.rgb * source.rgb) >> 7, ivec3(0), ivec3(255));
      if (tcc)
        source.a = clamp((t.a * source.a) >> 7, 0, 255);
    } else if (textureFunction == 1u) {
      source.rgb = t.rgb;
      if (tcc)
        source.a = t.a;
    } else {
      source.rgb = clamp(((t.rgb * source.rgb) >> 7) + ivec3(originalAlpha),
                         ivec3(0), ivec3(255));
      if (tcc)
        source.a =
            textureFunction == 2u ? clamp(t.a + originalAlpha, 0, 255) : t.a;
    }
  }
  if ((cfg(0) & 32u) != 0u) {
    int f = int(float(t0.a) * w0 + float(t1.a) * w1 + float(t2.a) * w2);
    ivec3 fog = ivec3(unpacked(cfg(21)).rgb);
    source.rgb = (f * source.rgb + (255 - f) * fog) >> 8;
  }
  return source;
}
bool triangleWeights(vec2 p, vec2 a, vec2 b, vec2 c, bool interpolate,
                     out vec3 weights) {
  if (any(lessThan(p, ceil(min(a, min(b, c))))) ||
      any(greaterThanEqual(p, ceil(max(a, max(b, c))))))
    return false;
  float area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (area == 0.0)
    return false;
  float sg = area > 0.0 ? 1.0 : -1.0;
  float e0 = (b.x - p.x) * (c.y - p.y) - (c.x - p.x) * (b.y - p.y),
        e1 = (c.x - p.x) * (a.y - p.y) - (a.x - p.x) * (c.y - p.y),
        e2 = (a.x - p.x) * (b.y - p.y) - (b.x - p.x) * (a.y - p.y);
  if (!edgeIn(e0 * sg, (b.y - c.y) * sg, (c.x - b.x) * sg) ||
      !edgeIn(e1 * sg, (c.y - a.y) * sg, (a.x - c.x) * sg) ||
      !edgeIn(e2 * sg, (a.y - b.y) * sg, (b.x - a.x) * sg))
    return false;
  weights = vec3(0, 0, 1);
  if (interpolate) {
    float inverseArea = 1.0 / area;
    weights.x = e0 * inverseArea;
    weights.y = e1 * inverseArea;
    weights.z = 1.0 - weights.x - weights.y;
  }

  return true;
}
uint triangleDepth(uint z0, uint z1, uint z2, vec3 weights) {
  float dz1 = z1 >= z0 ? float(z1 - z0) : -float(z0 - z1),
        dz2 = z2 >= z0 ? float(z2 - z0) : -float(z0 - z2);
  float step = floor(dz1 * weights.y + dz2 * weights.z);
  // A full-range u32 delta rounds to 2^32 in float. Converting that to
  // uint is undefined; clamp the magnitude and unsigned room explicitly.
  float magnitude = abs(step);
  uint delta = magnitude >= 4294967296.0 ? 0xffffffffu : uint(magnitude);
  uint z =
      step >= 0.0 ? z0 + min(delta, 0xffffffffu - z0) : z0 - min(delta, z0);
  z = min(z, cfg(24));

  return z;
}
#ifdef ORDERED_OPAQUE_HARDWARE
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec2 p = vec2(pixel);
  uint sx = cfg(11), sy = cfg(12), scan = cfg(10) & 3u;
  if (pixel.x < int(sx & 65535u) || pixel.x > int(sx >> 16) ||
      pixel.y < int(sy & 65535u) || pixel.y > int(sy >> 16))
    discard;
  if ((scan == 2u && (pixel.y & 1) == 0) || (scan == 3u && (pixel.y & 1) != 0))
    discard;
  uint i = primitiveIndex * 6u;
  uvec4 v0 = loadVertex(i), v1 = loadVertex(i + 2u), v2 = loadVertex(i + 4u);
  vec2 a = position(v0), b = position(v1), c = position(v2);
  vec3 weights;
#ifdef ORDERED_HARDWARE_NO_DEPTH
  bool interpolate = (cfg(0) & 56u) != 0u;
#else
  const bool interpolate = true;
#endif
  if (!triangleWeights(p, a, b, c, interpolate, weights))
    discard;
  ivec4 source = shade(i, v0, v1, v2, p, a, b, 3u, weights);
  ivec3 color = cfg(7) != 0u ? clamp(source.rgb, ivec3(0), ivec3(255))
                             : (source.rgb & ivec3(255));
  uint alpha = uint(source.a) & 255u;
  if (cfg(6) != 0u)
    alpha |= 128u;
  uvec4 result = uvec4(color, int(alpha));
  if (cfg(26) == 2u || cfg(26) == 10u)
    result = unpacked(expand16(pack16(packed(result))));
  outputColor = vec4(result) / 255.0;
#ifndef ORDERED_HARDWARE_NO_DEPTH
  gl_FragDepth = float(triangleDepth(v0.z, v1.z, v2.z, weights)) / 4294967296.0;
#endif
}
#else
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec2 p = vec2(pixel);
  uvec4 dst = texelFetch(initialColor, pixel, 0);
  uint depth = texelFetch(initialDepth, pixel, 0).r & cfg(24);
  uint sx = cfg(11), sy = cfg(12);
  bool pixelEnabled = pixel.x >= int(sx & 65535u) && pixel.x <= int(sx >> 16) &&
                      pixel.y >= int(sy & 65535u) && pixel.y <= int(sy >> 16);
  uint scan = cfg(10) & 3u;
  if ((scan == 2u && (pixel.y & 1) == 0) || (scan == 3u && (pixel.y & 1) != 0))
    pixelEnabled = false;
  uvec2 range = texelFetch(bins, pixel / 8, 0).rg;
  if (pixelEnabled)
    for (uint entry = range.x; entry < range.x + range.y; entry++) {
      uint i = loadIndex(entry) * 6u;
      uvec4 v0 = loadVertex(i), v1 = loadVertex(i + 2u),
            v2 = loadVertex(i + 4u);
      vec2 a = position(v0), b = position(v1), c = position(v2);
      float w0 = 1.0, w1 = 0.0, w2 = 0.0;
      uint kind = cfg(0) & 7u;
      if (kind == 1u || kind == 2u) {
        // GS reference DDA: exclude the final endpoint and round ties away
        // from zero. The dominant-axis increment is at least one pixel, so
        // only nearby step indices can hit this pixel.
        vec2 delta = b - a;
        int steps = int(max(abs(delta.x), abs(delta.y)));
        bool horizontal = abs(delta.x) >= abs(delta.y);
        float dominant = horizontal ? delta.x : delta.y;
        float along = horizontal ? p.x - a.x : p.y - a.y;
        int guess = steps > 0 ? int(floor(along / dominant * float(steps))) : 0;
        bool hit = false;
        for (int candidate = guess - 2; candidate <= guess + 2; candidate++) {
          if (candidate < 0 || candidate >= max(steps, 1))
            continue;
          float t = steps > 0 ? float(candidate) / float(steps) : 0.0;
          // GS positions are 12.4 fixed point. Integer rational coverage
          // avoids a reciprocal approximation moving an exact half-pixel
          // tie to its neighboring pixel on a particular GPU driver.
          int denominator = 16 * max(steps, 1);
          ivec2 numerator =
              ivec2(a * 16.0) * max(steps, 1) + ivec2(delta * 16.0) * candidate;
          ivec2 rounded = ((abs(numerator) + denominator / 2) / denominator) *
                          sign(numerator);
          if (all(equal(rounded, pixel))) {
            w1 = t;
            hit = true;
            break;
          }
        }
        if (!hit)
          continue;
        w0 = 1.0 - w1;
      } else if (kind == 6u) {
        if (any(lessThan(p, ceil(min(a, b)))) ||
            any(greaterThanEqual(p, ceil(max(a, b)))))
          continue;
        // Rectangles use the final endpoint's color, depth, Q and fog.
        w0 = 0.0;
        w1 = 1.0;
      } else {
        vec3 weights;
        if (!triangleWeights(p, a, b, c, true, weights))
          continue;
        w0 = weights.x;
        w1 = weights.y;
        w2 = weights.z;
      }
      uint test = cfg(1);
      if ((test & 16384u) != 0u && (((((cfg(26) == 1u ? 128u : dst.a) & 128u) !=
                                      0u)) != ((test & 32768u) != 0u)))
        continue;
      uint z = triangleDepth(v0.z, v1.z, v2.z, vec3(w0, w1, w2));
      bool zte = (test & 65536u) != 0u;
      uint ztst = (test >> 17) & 3u;
      if (zte && (ztst == 0u || (ztst == 2u && z < depth) ||
                  (ztst == 3u && z <= depth)))
        continue;
      ivec4 source = shade(i, v0, v1, v2, p, a, b, kind, vec3(w0, w1, w2));
      bool writeColor = true, writeAlpha = true, writeDepth = cfg(13) == 0u;
      if ((test & 1u) != 0u && !alphaPass(source.a, test)) {
        switch ((test >> 12) & 3u) {
        case 0u:
          continue;
        case 1u:
          writeDepth = false;
          break;
        case 2u:
          writeColor = false;
          break;
        default:
          writeDepth = false;
          writeAlpha = false;
          break;
        }
      }
      if (writeColor) {
        ivec3 color = source.rgb;
        if ((cfg(0) & 64u) != 0u && (cfg(5) == 0u || (source.a & 128) != 0)) {
          uint blend = cfg(2);
          uint aa = blend & 3u, bb = (blend >> 2) & 3u, cc = (blend >> 4) & 3u,
               dd = (blend >> 6) & 3u;
          ivec3 av = aa == 0u   ? source.rgb
                     : aa == 1u ? ivec3(dst.rgb)
                                : ivec3(0),
                bv = bb == 0u   ? source.rgb
                     : bb == 1u ? ivec3(dst.rgb)
                                : ivec3(0),
                dv = dd == 0u   ? source.rgb
                     : dd == 1u ? ivec3(dst.rgb)
                                : ivec3(0);
          int factor = cc == 0u   ? source.a
                       : cc == 1u ? int(cfg(26) == 1u ? 128u : dst.a)
                                  : int(cfg(3) & 255u);
          color = (((av - bv) * factor) >> 7) + dv;
        }
        color = cfg(7) != 0u ? clamp(color, ivec3(0), ivec3(255))
                             : (color & ivec3(255));
        uint alpha = uint(source.a) & 255u;
        if (cfg(6) != 0u)
          alpha |= 128u;
        uint mask = cfg(4);
        if (!writeAlpha)
          mask |= 0xff000000u;
        uint outputValue = uint(color.r) | (uint(color.g) << 8) |
                           (uint(color.b) << 16) | (alpha << 24);
        if (cfg(26) == 2u || cfg(26) == 10u) {
          uint m = pack16(mask);
          dst = unpacked(
              expand16((pack16(outputValue) & ~m) | (pack16(packed(dst)) & m)));
        } else {
          if (cfg(26) == 1u)
            mask |= 0xff000000u;
          dst = unpacked((outputValue & ~mask) | (packed(dst) & mask));
        }
      }
      if (writeDepth && zte)
        depth = z;
    }
  outputColor = dst;
  outputDepth = depth;
}

#endif
