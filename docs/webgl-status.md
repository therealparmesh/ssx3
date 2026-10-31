# Experimental WebGL status

This branch is separate from the tagged WebGPU desktop release. It is not a production fallback. The retained results below fail the gameplay performance gate.

## Resumed from the WebGPU release

The branch now incorporates `webgpu-v70`, including source-audio clock checks,
native pause/pacing fixes, full-depth presentation priming, keyboard/gamepad
coverage and the GS color/fade regression. Conflicts preserve both backend
fixture paths; color/fade checks run after the WebGL snapshot/mip checks so they
cannot overwrite the input pixels expected by those tests. WebGL's actual GPU
API fixture passes in headed Chromium and Firefox with WebGPU withheld,
including all four modulation cases, three fades and the combined tint pass,
124 mip cases, 64 asynchronous frames and injected-error negative controls.
These are integration/correctness results, not a new game-speed qualification.
The production WebGPU branch and private hosted release are unchanged.

The candidate now captures and samples CPU-owned mip chains before queuing
vertices, including fixed/Q-based level selection, mip filtering, per-level
wraps and palette decoding before filtering. Automatic TEX0 mip-address actions
now update runtime state; register replay restores the final mip addresses after
backend side effects. MIPTBP changes, CPU uploads and snapshots invalidate the
affected views. Native mip layout/action checks and the old register replay
negative control pass. Asset-free Chrome/Firefox checks agree on 109,440 sampler
pixels, 1,920 ordered/opaque bridge pixels and 7,936 runtime pixels. Forced
level-zero sampling must fail the oracle. These are discrete model checks;
continuous-Q approximation and exact hardware rounding remain unqualified.
GPU-owned/aliasing mip views and unsupported layouts retain the native fallback.
See [mip fixture details](../tests/webgl_mips/README.md).

A subsequent ordinary Firefox run entered Snow Jam and visibly reached 4%
course progress with 199,751 mip batches and zero level-zero approximation
batches. Its 20.46-second racing window delivered 400 fresh images (19.55/s),
with a 103.04 ms maximum interval and audio reaching zero. No application errors
were reported. An earlier script stopped at the briefing; its 18.10/s window
is not a race measurement. These checks do not qualify a completed race,
hardware fidelity or release performance.


Destination samplers are now assigned once per linked shader program. Alpha-test
failure passes update a scalar uniform while retaining the shading block's
std140 offsets, instead of uploading the full block for every phase change.
Independent sampler-lifetime and alpha-phase fixtures pass in both desktop
browsers, including partial masks, destination-alpha tests, all eight alpha
comparisons, all four failure actions and missing-uniform controls. The phase
fixture checks 26,624 color/depth pairs, including 32 deferred sequences that
retain intermediate results without exporting RAM between passes. Uniform
buffer uploads fall from 1,297 to 898. These counts describe the fixture's work.

Two matched Firefox briefing windows delivered 14.80 and 15.07 fresh images/s
with the preceding implementation, versus 15.75 and 15.92/s with these changes.
Weighted throughput rises from 14.94 to 15.84/s, approximately 6%. Candidate
maximum intervals are 100.36 and 100.56 ms, and audio still reaches zero. This
bounded comparison fails the release performance requirement; it does not
qualify a complete race, physical output or phone compatibility.

Framebuffer-to-host transfers now check GL errors before copying temporary readback
pixels into GS RAM. The preceding implementation silently changed RAM after an
injected fault. Both desktop browsers pass 32 fault/retry cases across four pixel
layouts and four rectangle shapes, with complete RAM comparisons and exact packed
output after retry. The preceding implementation and a control that suppresses
error reporting fail the new assertion. The full backend fixture matrix passes
in both browsers. This is a correctness fix; it does not establish a speed gain.

Private profiling found thousands of native fallback draws per frame in a slow
briefing. Almost all sampled fallback passes requested mip filtering, which the
ordered path previously rejected; the native fallback samples level zero.
The new CPU-owned mip path covers a guarded subset of those requests.
An explicitly approximate level-zero batching trial still submitted only about
18 fresh images/s, so enabling that approximation would not meet the performance
target. Sampled palettes usually contain varying alpha, ruling out a blanket
opaque-material shortcut. Remaining mip aliases/layouts, destination-dependent
batching and frame delivery remain engineering work before performance
qualification.

The draft WebGL branch now implements the runtime GPU API and can build a private game player, rather than only replaying captured commands. The normal backend and hosted release are unchanged. This candidate requires Asyncify, native internal resolution and the window-owned runtime; the split game/presentation worker is not integrated.

Asset-free checks pass in headed Chromium 156 and Firefox 158 with WebGPU withheld and no GPU feature flags or Firefox preferences. Each browser verifies 64 distinct asynchronous frames (188,416 exact pixels), synchronous display, offset download, actual drawing/export, uncached local copy, snapshot restoration including a partial RGB24 transfer, rejection of invalid snapshot metadata without VRAM mutation, and host-yield requests for synchronous rendering work. A fresh native build passes 18 CTest cases, and all 23 JavaScript regression suites pass. CI now compiles the live WebGL probe in addition to the standalone backend fixtures; hardware browser runs remain separate.

The WebGL shell now enables the copy presenter's capacity waits. Previously its synchronous readbacks used the compatibility setting intended for WebGPU's asynchronous completion, allowing rendering to continue with a full copy queue while browser automation timed out. A paired Chromium check used identical completed JS/Wasm/data binaries: the old HTML setting timed out; changing only copy pacing reached the main menu, paused, resumed and paused again. The source policy regression rejects the preceding shell; all 23 JavaScript suites pass.

A fresh immutable build then passed Firefox keyboard and simulated standard-controller navigation through character, peak, mode and event selection, with repeated native pause acknowledgements and no application errors. The first Snow Jam briefing renders, but a short 12.195-second instrumented window delivered only 165 fresh images (13.53/s), with a 133.66 ms maximum interval and an audio queue reaching zero. This fails performance requirements and is not a completed-race qualification. Earlier temporary driver argument errors and one diagnostic attempt that read assets during linking are excluded; subsequent tests use copied immutable bundles with recorded hashes.

The depth-alias path now retains validated private framebuffer attachments until their resource owner or dimensions change, copies the mapped source bounds and scissors destination writes. Six asset-free ownership/mapping cases compare full target images against forced attachment validation and full-surface copies, including replacement, reset, resize, nonzero coordinates and disjoint rectangles. Native and hybrid runs pass in both browsers, comparing 458,752 pixels per mode. In the native thin-region fixture, validation calls fell from 136 to 8 and copied depth pixels from 4,456,448 to 536; these are fixture work counts, not game-speed measurements. The runtime's 64-frame drawing/export/snapshot probe also passes in both browsers.

A separate immutable Firefox game build with this change delivered 141 fresh images over 10.454 seconds (13.49/s), with a 164.22 ms maximum interval and audio reaching zero. This does not demonstrate an improvement over the preceding 13.53/s briefing window. A private pipelined-readback trial was slower at 10.70/s and was rejected. Neither trial changes the hosted release or establishes playable performance.

The WebGL build now excludes the synchronous `CGSH_OpenGL` and `CGSHandler` methods from Asyncify suspension instrumentation, retaining the existing synchronous EE/VU worker exclusions. Rendering drains before the host yields; those excluded methods must not suspend. WebGPU keeps its preceding exclusion list and instrumented rendering path. The runtime probe uses the same selected list and passes in both browsers. Canonical CMake probe output is byte-identical to the tested private probe; the actual game reproduces its Wasm, HTML, data and symbol map exactly, with JavaScript differing only in three absolute data-package identifiers for the output directory.

Separate normal-menu Firefox runs reached visually verified Snow Jam briefings. Two baseline windows delivered 13.50 and 13.53 fresh images/s; two exclusion-candidate windows delivered 14.66 and 14.62/s, approximately an 8% improvement. Candidate maximum intervals were 100.74 and 126.60 ms, and both audio queues reached zero. These short instrumented software-submission windows establish a bounded comparison, not playable performance or physical output qualification. The canonical build independently delivered 14.51/s over 16.198 seconds, with a 138.02 ms maximum interval and audio reaching zero. A later private GL-prototype counter diagnostic timed out and is excluded; it supplied no race-performance result. All 23 JavaScript suites pass.

A clean canonical Firefox rerun without prototype hooks entered the normal Snow Jam race, visually showed the start and subsequent 5% course progress, and responded to keyboard input. Its 21.366-second race-start window submitted 329 fresh images (15.40/s), with 333 native frames, a 170.42 ms maximum interval, 295 intervals over 25 ms, audio reaching zero and no application errors. Native pause acknowledgements succeeded and the browser closed. This is a short race-entry functional check and a failed performance window, not a completed-race or fidelity qualification.

Runtime VRAM exports now validate pending GL errors before returning success, including exports satisfied by clean cached RAM. Previously the runtime relied on the shared cache helper, whose clean-cache early return skipped that check; the old implementation fails the new clean-export assertion in both browsers. The check lives at the runtime export boundary, preserving the helper’s internal cache fast path. The runtime probe passes six injected native GL-error cases per browser: dirty export, clean export, snapshot, synchronous display, asynchronous display and CPU-display fallback. Failed exports/snapshots preserve caller buffers and a clean retry returns exact pixels. A control that hides driver errors fails the dirty-export assertion in both browsers.

A private trial removing per-alias error queries did not improve the matched Firefox briefing: 14.63 fresh images/s versus the baseline's 14.87/s across two windows each. It was rejected, and the preceding per-alias checks are retained. Its later short race-entry measurement is excluded from release qualification. A subsequent helper-level check also produced failed performance windows and was narrowed to the runtime export boundary; that intermediate build is not the final source. The final runtime-boundary build passed ordinary-menu Firefox navigation into Snow Jam with native pause acknowledgements and no application errors. Its 15.494-second briefing window delivered 220 fresh images (14.20/s); its 15.553-second race-start window delivered 244 (15.69/s), with a 133.70 ms maximum interval and audio reaching zero. These are failed performance windows, not a completed-race or fidelity qualification.

The experimental candidate is not production ready and has no qualified gameplay performance window. Full-game rendering and performance, broader lifecycle checks, worker integration, context recovery, snapshot interchange and physical phone/controller/audio qualification remain open. Reproducible build and browser-test commands are in [building](building.md#experimental-live-webgl-runtime). Game files, generated game binaries, captures and private credentials are excluded from the public source.
