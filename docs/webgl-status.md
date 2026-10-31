# Experimental WebGL status

This branch is separate from the tagged WebGPU desktop release. It is not a production fallback. The retained results below fail the gameplay performance gate.

## Bounded synchronous render slices

WebGL now drains each synchronous GIF packet without forcing a browser yield
for every packet. The renderer checks the six-millisecond slice budget after
each packet, including queues shorter than eight packets. The browser host
also yields after presentation, so frames that fit within a slice still allow
input and browser presentation to run. WebGPU keeps its completion-driven
yields and presentation behavior.

The actual runtime API fixture exercises two TEXFLUSH GIF packets in the real
renderer queue. It checks coalescing before the deadline, yielding after one
packet with an expired budget, draining the remainder, and preserving the
presentation boundary. The preceding scheduler fails the coalescing oracle;
a control removing the per-packet deadline check fails the short-queue budget
oracle. Both normal runtime fixtures pass in Chromium and Firefox, retaining
the exact pixel, mip, snapshot, register-order and injected-error checks.
The final game also passes all 27 keyboard/simulated standard-controller
checks in both browsers, including analog pressure, two-controller reorder,
disconnect/reconnect, API denial/recovery, actual hidden-tab suspension and
held-input restoration before native resume. These do not measure physical
controller latency.

Two fresh normal-menu Chromium runs at 1280×800/DPR 1 with WebGPU withheld,
no GPU overrides and no in-window build or profiler delivered 1,108 images
in 20.000 seconds (55.40/s) and 1,046 in 20.024 seconds (52.24/s).
Maximum presentation intervals were 105.93 and 33.68 ms; both exhausted the
audio queue. A 16 ms browser timer kept progressing, with maximum observed
gaps of 235.96 and 107.50 ms. Slice budgeting bounds work between packets;
it does not preempt an individual packet or a synchronous GPU operation.
A fresh final-build Chromium repeat delivered 962 images in 20.025 seconds
(48.04/s), with a 110.84 ms maximum presentation interval, audio starvation
and a 273.03 ms maximum timer gap. The private and final game Wasm differ,
so the final repeat is retained separately; final-build controller checks
use this same Wasm. These partial-race windows improve on the preceding
canonical 19.25/s result but still fail release requirements. The final Firefox
race-entry window delivered 601 images in 20.035 seconds (30.00/s), with a
75.26 ms maximum presentation interval and audio starvation. Its browser
timer progressed only 106 times, with a maximum 415 ms gap; Firefox
responsiveness remains a performance issue despite passing the functional
controller checks. These are not deterministic replay, completed-race,
source-clock audio or hardware-output qualifications.

## Direct rendering-owner register submission

The WebGL adapter now applies vertex attribute latches directly and invokes
action-register handlers synchronously on its checked rendering owner. It no
longer sends the same register stream through the backend's second write buffer.
Queued initialization, transfer and restore controls still drain before later
register actions. RGBA/Q, ST, UV and fog remain latched in the native register
image; XYZ, palette, transfer and setup actions retain their real handlers.
The protected upstream entry point is included in the checksum-verified patch.

The canonical runtime API fixture passes in Chromium and Firefox, including
all existing draw/export, mip, color/fade, snapshot and injected-error checks.
A new 512-pixel CPU-raster oracle compares two overlapping draws with changing
per-vertex RGB/alpha and no intermediate flush. A private control that delays
XYZ actions while updating attributes immediately fails this oracle.

The first normal-menu Chromium race-entry comparison used 1280×800/DPR 1,
WebGPU withheld, no GPU enablement overrides and no in-window builds/profiling.
The preceding copy player presented 366 images over 20.133 seconds (18.18/s);
the private direct-submission implementation presented 486 over 20.035 seconds
(24.26/s). Maximum intervals were 109.07 and 105.41 ms; both exhausted audio.
These are partial-course, fixed-duration windows with naturally varying race
scenes, not deterministic replay, completed races or release qualification.
The canonical repeat presented 387 images over 20.100 seconds (19.25/s), with
a 107.37 ms maximum interval and audio starvation. The initial 33% throughput
gain therefore has not reproduced reliably and is not an accepted speed claim.
The private and canonical backend/kernel object files are byte-identical, but
their final Wasm bundles differ; link placement and normal-run variability
remain unresolved. The direct path is selected as a verified reduction in
register-buffer work, not as near-60 gameplay qualification. Source commit
`a2627929c8e58c082f0767500c564cb25a947112` passed source CI.
Its freshly linked canonical game also passes all 27 native keyboard/controller
checks in both Chromium and Firefox, with WebGPU withheld and no GPU enablement
overrides. This includes disconnect/reconnect, reordered two-player slots,
analog pressure, actual tab hiding and held-input restoration before native
resume. Both controller sessions closed with no application errors/warnings.

Other trials remain unselected. An alpha-test KEEP hardware route passed
1,286 color/depth cases in both browsers but was unused in the sampled race
and did not improve its roughly 18/s delivery. A material diagnostic found
reverse-subtract blending in about 31% of sampled packets. A private hardware
blend probe checked all 8,454,144 source/destination/alpha combinations: even
the biased variant differed in 65,634 cases on each tested browser. Approximate
fixed-function blending is not selected. An integer snapshot prototype passed
both browsers' 1,062-case matrix and actual runtime API fixtures, and reduced
shader draw calls from three to one for ordered batches. Its 20.060-second
race-entry check still presented only 367 images (18.29/s), with a 111.90 ms
maximum interval and audio starvation. It also remains outside source.

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

The freshly linked WebGL game also passes all 27 native keyboard/controller
checkpoints in headed Chromium and Firefox with WebGPU withheld and no GPU
enablement overrides. This includes all sixteen standard buttons, independent
keyboard stick/D-pad channels, both sticks, trigger pressure, two slots,
disconnect/reconnect/reordering, temporary API denial/recovery, actual tab hiding,
native frame freeze and held-input restoration before unpause. The observer
forwards each real window-owned native call before recording it. Controllers
are simulated browser snapshots; this is not physical-controller latency or
gameplay performance qualification. Use `SSX3_TEST_BACKEND=webgl` with the
[controller driver](../tests/browser_gamepad/README.md).
An explicit native Gamepad API denial fails before Play with
`Native browser Gamepad API access failed`, confirming that synthetic pads
cannot hide a browser permissions failure.

## Profiled register work

A fresh Chromium Snow Jam race-entry profile now uses the function-index map
generated by that exact Wasm link, with both files hashed before analysis.
The 20.078-second instrumented window submitted 357 images (17.78/s), reached
3% course progress, had a 108.26 ms maximum interval and exhausted its audio
queue. Of the sampled 2,741 ms in `readPixels`, about 2,699 ms came through
display output, 39 ms through VRAM synchronization and 2 ms through depth
readback. These are sampled CPU stacks, including driver waits, not GPU timing.
GS register processing was another substantial cost. The old unrelated symbol
map is not used to label this profile.

The register adapter now omits ST/UV when texturing is off, selects ST or UV
according to the resolved FST mode, and omits fog values when fog is off.
RGBA/Q and every XYZ action remain intact. Inactive values do not update the
cache; re-enabling an attribute restores its current value before drawing.
A sixteen-mode sequence checks 48 vertex actions across PRIM/PRMODE selection,
changing unused values and re-enabling each consumer. The preceding adapter
fails the new check; native and Wasm checks pass. Actual GPU runtime fixtures
pass in Chromium and Firefox, including 124 mip cases, color/fade pixels,
snapshot/transfer recovery and injected driver faults. This reduces register
work; a game-frame-rate improvement for this change remains unmeasured.

A separate private synchronous-GS exclusion trial passed both browsers' GPU
fixtures and entered a normal race, but its instrumented 19.55 images/s window
still reached 109.62 ms and exhausted audio. A small native compilation also
overlapped that diagnostic, so it is not an accepted speed comparison. The
exclusion list is not selected in source. A broad namespace trial was never
run because it could exclude asynchronous queue waits; a malformed narrow
signature failed at link time and is also excluded. The next investigation is
display presentation without synchronous CPU pixel readback.

A subsequent private ImageBitmap presentation prototype displayed normal menus
and entered Snow Jam without application errors. Its unprofiled 20.185-second
race-entry window still presented only 363 images (17.98/s), reached a 107.48 ms
maximum interval, exhausted audio and replaced queued images. A separate
5.157-second instrumented follow-up counted only 18 native `readPixels` calls
(9.51 ms of wrapped call time), but also 96,809 bridge draw calls and 103,844
bridge texture uploads. The follow-up presented 97 images (18.81/s). This
demonstrates that removing explicit display readback alone does not satisfy the
target; earlier sampled readback waits must not be treated as independent GPU
execution cost. There is no accepted causal speed comparison. Image scaling,
pause/capacity behavior and Firefox were not qualified for the prototype. It
remains outside source; the normal copy player and WebGPU release are unchanged.

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
