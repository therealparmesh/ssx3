# Experimental WebGL backend fixtures

This builds the actual upstream-backed GS candidate without game assets. It
makes the command-drain, framebuffer upload/readback and restored-memory fixes
reproducible from this repository. It does **not** connect this backend to the
shipping game or qualify full-game fidelity, saves, performance or phones.

## Build

Use Emscripten **6.0.11**, Python **3.12+**, Git, CMake and Ninja:

```sh
source tools/emsdk/emsdk_env.sh
sh scripts/build_webgl_backend.sh
python3 -m http.server 8264 --bind 127.0.0.1 --directory build/webgl-backend
```

The preparation script downloads seven exact upstream commits, verifies their
archive SHA-256 values, preserves licenses and applies `upstream.patch`. The
revisions and checksums are in `sources.lock.json`; no moving branches are used.
It verifies the prepared source tree on subsequent builds. If pinned inputs or
prepared files change, use a fresh output directory, passed as the first build
script argument. `EMCMAKE`, `CMAKE` and `WEBGL_BUILD_JOBS` override build tools and
parallelism. Build products and downloads stay under the ignored `build/` tree.

Open `http://127.0.0.1:8264/?fixture=restore`, or select `population` or `readback`
through the `fixture` query parameter. Each page reports its own result.

For automated checks, use the same external `puppeteer-core@25.16.0` installation
as the ordered-raster tests:

```sh
NODE_PATH=/tmp/ssx3-browser-tools/node_modules node scripts/test_webgl_backend.cjs chromium
NODE_PATH=/tmp/ssx3-browser-tools/node_modules node scripts/test_webgl_backend.cjs firefox
```

The driver defaults to the local URL above and `/usr/bin/chromium` or
`/usr/bin/firefox`. `SSX3_WEBGL_BACKEND_ORIGIN`, `SSX3_CHROMIUM_BIN`,
`SSX3_FIREFOX_BIN` and `SSX3_WEBGL_ARTIFACT_DIR` override these. Screenshots and
JSON evidence go to a fresh temporary directory by default. Headed browsers are
the default, without GPU override flags. `SSX3_WEBGL_HEADLESS=1` allows functional
testing; these fixtures do not measure performance.

## Coverage

- **Population:** 393,216 pixels per browser. Every 16-bit word in PSMCT16 and
  PSMCT16S is checked after initial and dirty-page upload; pseudorandom PSMCT32
  values provide controls. Host RGBA8 views must use GS RGB/alpha expansion.
- **Readback:** 16 cases, 266,488 pixels per browser across PSMCT32/24/16/16S.
  GPU storage remains authoritative while CPU RAM is poisoned. Full, offset,
  edge and page-crossing rectangles check packed output, a buffer guard and
  the complete 4 MB RAM image. PSMCT24 preserves the unused high byte.
- **Restore:** 24 cases, 1,572,864 pixels per browser. Replacing RAM must discard
  stale framebuffers and pending draws. Repeated invalidation preserves loaded
  RAM, registers and CLUT contents, and the next surface observes restored data.

The restore hook is `WriteBackMemoryCache` (CPU RAM to GPU caches). It discards
cached GPU resources without rendering old pending work into restored memory.
The save hook, `SyncMemoryCache` (GPU to CPU RAM), still needs dirty color/depth
ownership and physical alias coherence. The restore fixture is not an end-to-end
save/load test. The runtime adapter must also invalidate its register cache and
restore the CLUT when importing a snapshot.

The patch includes the hybrid ordered/hardware raster integration and native
GS fixes tested in the private candidate, with asset-free probes. The three
fixtures here check uploads, readback and restore. They do not exercise the
ordered/hardware rendering matrix; use `tests/webgl_ordered/README.md` for that
separate coverage. Captured-game fidelity differences, mip LOD, dithering,
feedback/alias coherence, context recovery, live worker/presentation integration,
full-game performance and physical device/controller qualification remain open.

See `UPSTREAM-NOTICES.md`. Include the generated `licenses/` directory when
redistributing compiled fixtures. No ROM, BIOS, game capture, save or generated
guest executable is downloaded or published by this workflow.
