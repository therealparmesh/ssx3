// Asset-free runtime wiring checks. Solid, distinct mip images make address,
// descriptor and lifetime errors observable independently of spatial filtering.
namespace {
void verify_runtime_mips() {
  using namespace ps2::gs;
  struct Layout {
    unsigned width, height, pitch;
    std::array<unsigned, 7> address;
    bool automatic;
  };
  const Layout explicitLayout{
      64,
      32,
      1,
      {0x300000, 0x340000, 0x360000, 0x380000, 0x390000, 0x3a0000, 0x3b0000},
      false};
  const Layout automaticLayout{
      128, 64, 4, {0x300000, 0x310000, 0x314000, 0x315000, 0, 0, 0}, true};
  const std::array<std::uint32_t, 7> colors = {
      0x80302010, 0x80403030, 0x80504050, 0x80605070,
      0x80706090, 0x808070b0, 0x809080d0};
  std::vector<std::uint8_t> actual(kMemorySize);
  std::vector<std::uint32_t> ram(kMemorySize / 4), clut(512);
  unsigned cases = 0, pixels = 0;
  std::uint32_t hash = 2166136261u;
  auto fill = [&](std::vector<std::uint32_t> &memory, unsigned base,
                  unsigned pitch, unsigned width, unsigned height,
                  std::uint32_t color) {
    for (unsigned y = 0; y < height; y++)
      for (unsigned x = 0; x < width; x++)
        memory[address32(base / 256, pitch, x, y) / 4] = color;
  };
  auto initial = [&](const Layout &layout, unsigned maximum) {
    std::fill(ram.begin(), ram.end(), 0);
    for (unsigned level = 0; level <= maximum; level++)
      fill(ram, layout.address[level], level ? 1 : layout.pitch,
           std::max(1u, layout.width >> level),
           std::max(1u, layout.height >> level), colors[level]);
    gpu::write_state(ram, 1, clut);
  };
  auto state = [&](const Layout &layout, unsigned context, unsigned maximum,
                   unsigned min, int bias, bool fixed, unsigned scale) {
    State s{};
    s.prim = 6 | 16 | (fixed ? 256 : 0) | (context << 9);
    s.prmodecont = 1;
    s.colclamp = 1;
    auto &c = s.ctx[context];
    c.frame = 1ull << 16;
    c.zbuf = ((2 << 20) / 8192) | (1ull << 24) | (1ull << 32);
    c.test = 0x30000;
    c.scissor = (15ull << 16) | (7ull << 48);
    c.tex0 = (layout.address[0] / 256) | (std::uint64_t(layout.pitch) << 14) |
             (std::uint64_t(layout.width == 128 ? 7 : 6) << 26) |
             (std::uint64_t(layout.height == 64 ? 6 : 5) << 30) | (3ull << 34);
    c.tex1 = (fixed ? 1ull : 0) | (maximum << 2) | (min << 6) |
             (layout.automatic ? 512 : 0) | (std::uint64_t(scale) << 19) |
             (std::uint64_t(bias & 4095) << 32);
    for (unsigned level = 1; level <= maximum; level++) {
      auto descriptor =
          std::uint64_t(layout.address[level] / 256) | (1ull << 14);
      auto &reg = level <= 3 ? c.miptbp1 : c.miptbp2;
      reg |= descriptor << (20 * ((level - 1) % 3));
    }
    return s;
  };
  auto draw = [&](const State &s, unsigned left, float q) {
    Vertex v[2]{};
    for (auto &value : v) {
      value.r = value.g = value.b = value.a = 128;
      value.q = q;
      value.s =
          32.5f /
          float((s.ctx[(s.prim >> 9) & 1].tex0 >> 26 & 15) == 7 ? 128 : 64) * q;
      value.t =
          16.5f /
          float((s.ctx[(s.prim >> 9) & 1].tex0 >> 30 & 15) == 6 ? 64 : 32) * q;
      value.u = 32 * 16 + 8;
      value.v = 16 * 16 + 8;
    }
    v[0].x = left * 16;
    v[1].x = (left + 8) * 16;
    v[1].y = 8 * 16;
    gpu::draw(s, v, 2);
  };
  auto verify = [&](unsigned left, std::uint32_t expected, const char *label) {
    gpu::download(actual.data());
    for (unsigned y = 0; y < 8; y++)
      for (unsigned x = left; x < left + 8; x++) {
        std::uint32_t got = 0;
        std::memcpy(&got, actual.data() + address32(0, 1, x, y), 4);
        if (got != expected) {
          std::fprintf(stderr,
                       "MIP_DIFF %s case=%u xy=%u,%u got=%08x expected=%08x\n",
                       label, cases, x, y, got, expected);
          check(false, "Runtime mip pixels");
        }
        hash = (hash ^ got) * 16777619u;
        ++pixels;
      }
    ++cases;
  };
  auto half = [](std::uint32_t a, std::uint32_t b) {
    std::uint32_t result = 0;
    for (unsigned c = 0; c < 4; c++)
      result |= ((((a >> (c * 8)) & 255) + ((b >> (c * 8)) & 255)) / 2)
                << (c * 8);
    return result;
  };
  struct Fixed {
    int bias;
    unsigned nearest, first;
    bool interpolate;
  };
  const Fixed fixedCases[] = {
      {-16, 0, 0, false}, {0, 0, 0, false},  {8, 1, 0, true},
      {16, 1, 1, false},  {24, 2, 1, true},  {32, 2, 2, false},
      {40, 3, 2, true},   {48, 3, 3, false}, {64, 4, 4, false},
      {80, 5, 5, false},  {96, 6, 6, false}, {112, 6, 6, false}};
  for (unsigned context : {0u, 1u})
    for (unsigned min : {2u, 3u, 4u, 5u})
      for (const auto &test : fixedCases) {
        initial(explicitLayout, 6);
        auto s = state(explicitLayout, context, 6, min, test.bias, true, 0);
        draw(s, 0, 1);
        auto expected =
            (min & 1) ? (test.interpolate
                             ? half(colors[test.first], colors[test.first + 1])
                             : colors[test.first])
                      : colors[test.nearest];
        verify(0, expected, "fixed");
      }
  struct Dynamic {
    float q;
    unsigned scale;
    int bias;
    unsigned first;
    bool interpolate;
  };
  const Dynamic dynamicCases[] = {
      {1, 0, 0, 0, false},    {.5f, 0, 0, 1, false}, {.25f, 0, 0, 2, false},
      {.25f, 1, 0, 4, false}, {.5f, 1, 8, 2, true},  {-.5f, 0, 0, 1, false},
      {0, 0, 0, 6, false}};
  for (unsigned context : {0u, 1u})
    for (const auto &test : dynamicCases) {
      initial(explicitLayout, 6);
      auto s =
          state(explicitLayout, context, 6, 3, test.bias, false, test.scale);
      draw(s, 0, test.q);
      verify(0,
             test.interpolate ? half(colors[test.first], colors[test.first + 1])
                              : colors[test.first],
             "Q-based");
    }
  // MTBA's hidden backend action must not replace this final register image.
  // The rectangle and padded L0 pitch intentionally disagree with square TW.
  for (unsigned context : {0u, 1u}) {
    initial(automaticLayout, 3);
    auto s = state(automaticLayout, context, 3, 2, 32, true, 0);
    draw(s, 0, 1);
    verify(0, colors[2], "automatic-address replay");
  }
  // Only MIPTBP2 changes between queued draws; no upload/export invalidates the
  // texture state or hides a missing register comparison in the GS context.
  for (unsigned context : {0u, 1u}) {
    initial(explicitLayout, 6);
    fill(ram, 0x3c0000, 1, 2, 1, 0x80abcdef);
    gpu::write_state(ram, 1, clut);
    auto s = state(explicitLayout, context, 6, 2, 80, true, 0);
    draw(s, 0, 1);
    s.ctx[context].miptbp2 =
        (s.ctx[context].miptbp2 & ~(0xfffffull << 20)) |
        ((std::uint64_t(0x3c0000 / 256) | (1ull << 14)) << 20);
    draw(s, 8, 1);
    verify(0, colors[5], "queued old descriptor");
    verify(8, 0x80abcdef, "changed MIPTBP2");
  }
  // A CPU upload must flush the old pending batch, then refresh the affected
  // level. Subsequent snapshot restore must discard that refreshed GPU view.
  for (unsigned context : {0u, 1u}) {
    initial(explicitLayout, 6);
    auto s = state(explicitLayout, context, 6, 2, 32, true, 0);
    draw(s, 0, 1);
    State image{};
    image.bitbltbuf =
        (std::uint64_t(explicitLayout.address[2] / 256) << 32) | (1ull << 48);
    image.trxreg = 16ull | (8ull << 32);
    std::vector<std::uint32_t> upload(16 * 8, 0x80e0c0a0);
    gpu::image_begin(image);
    gpu::image_data(reinterpret_cast<const std::uint8_t *>(upload.data()),
                    upload.size() * 4);
    draw(s, 8, 1);
    verify(0, colors[2], "batch before upload");
    verify(8, 0x80e0c0a0, "refreshed mip view");
    std::vector<std::uint32_t> saved, palette;
    std::uint32_t scale;
    gpu::read_state(saved, scale, palette);
    std::fill(upload.begin(), upload.end(), 0x80112233);
    gpu::image_begin(image);
    gpu::image_data(reinterpret_cast<const std::uint8_t *>(upload.data()),
                    upload.size() * 4);
    draw(s, 8, 1);
    verify(8, 0x80112233, "second refreshed view");
    gpu::write_state(saved, scale, palette);
    draw(s, 8, 1);
    verify(8, 0x80e0c0a0, "restored mip view");
  }
  // clang-format off
 auto batches=EM_ASM_INT({return Module.ps2OrderedRaster.stats.mipBatches||0;});auto approximations=EM_ASM_INT({return Module.ps2OrderedRaster.stats.levelZeroLodBatches||0;});check(batches>0,"Actual mip path executed");check(approximations==0,"No level-zero profiling approximation");
 EM_ASM({window.qaProbe.mips=({cases:$0,pixels:$1,hash:$2>>>0,mipBatches:$3,approximateBatches:$4});},cases,pixels,hash,batches,approximations);
  // clang-format on
  std::printf("PASS runtime mips cases=%u pixels=%u hash=%u\n", cases, pixels,
              hash);
}
} // namespace
