# Experimental ordered-renderer mip sampling

These asset-free fixtures verify the candidate sampler and its JavaScript
bridge. They do not qualify full-game fidelity, performance or phone support.
Build and serve the ordered-raster fixtures as described in
[`../webgl_ordered/README.md`](../webgl_ordered/README.md), then run:

```sh
NODE_PATH=/tmp/ssx3-browser-tools/node_modules node scripts/test_webgl_mips.cjs chromium
NODE_PATH=/tmp/ssx3-browser-tools/node_modules node scripts/test_webgl_mips.cjs firefox
```

The driver uses the same `SSX3_WEBGL_ORIGIN`, `SSX3_WEBGL_ARTIFACT_DIR`,
`SSX3_CHROMIUM_BIN`, `SSX3_FIREFOX_BIN` and `SSX3_WEBGL_HEADLESS` overrides as
the ordered-raster driver. Both default browser runs are headed and use no GPU
override flags. Screenshots and JSON go outside the checkout by default.

The sampler checks 13,680 cases / 109,440 exact pixels against an independent
CPU model: RGBA32, RGB24/TEXA, RGB5551/TEXA and 4/8-bit palette indices;
all six minification modes; both magnification modes; maximum levels 0/1/3/6;
signed 12.4 bias; fixed and Q-based selection; and all four wrap modes at each
level. Palette entries are decoded before spatial and inter-level filtering.
The negative control retains all filtering rules but forces the maximum level
to zero; it must fail on a nonzero-level pixel. The expected positive hash is
2510624830.

The bridge checks 1,920 cases / 1,920 exact pixels through both ordered tiles
and hardware opaque triangles, using UV and STQ coordinates. It also rejects
an incomplete chain before drawing. The expected hash is 2611237925. All input
textures and palettes are generated locally. No game assets are used.

`ORDERED_MIP_SAMPLING` compiles separate mip-enabled programs, leaving existing
non-mip shader programs intact. Configuration word 30 carries the low TEX1
bits plus the internal enable bit 31; word 31 carries the signed K field.
The host supplies base and L1-L6 as separate normalized textures. Sampler units
9-14 hold the six mip views, within WebGL 2's minimum sixteen fragment units.

The runtime probe adds 124 cases / 7,936 pixels (hash 2473005509), using actual
GS memory addressing and register replay. It covers both contexts, fixed and
Q-based selection, automatic addresses with nonsquare dimensions and padded
base pitch, MIPTBP2-only changes between pending draws, CPU uploads and snapshot
restore. It asserts actual mip batches and zero level-zero approximation
batches. Run it with `scripts/test_webgl_runtime.cjs` after building the live
runtime probe.

The runtime captures all mip views before queuing vertices. Eligibility is
restricted to CPU-owned, non-aliasing views; the complete writable scissor is
included in that ownership check so eligibility cannot change as a batch grows.
Unsupported formats, unresolved framebuffer aliases, variable LOD with UV mode,
and unknown automatic-address layouts retain the existing native fallback.
That fallback does not establish correct mip behavior. Continuous-Q hardware
approximation and hardware filter rounding still require independent fidelity
qualification; the discrete oracle cases verify the implemented model.
