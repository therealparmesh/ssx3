# Experimental WebGL status

This branch is separate from the tagged WebGPU desktop release. It is not a production fallback. The retained results below fail the gameplay performance gate.

## Constant texture and fog correction (2026-11-02)

Equal texture coordinates, Q and fog values now survive triangle interpolation
exactly in the ordered shader and software reference. Previously, floating-point
weights could move a constant ST across a nearest-texel boundary, move Q=1 across
the minification/magnification boundary, or truncate fog=255 to 254. Independent
controlled images reproduce 60, 69 and 210 wrong GPU pixels, respectively, in
both desktop browsers before the correction. The CPU also misrenders 92 pixels
in the nearest-texel case and 164 in the fog case. These are discrete independent
invariants, rather than agreement between two implementations with a shared bug.

Chromium 156 and Firefox 158 each pass 1,107 bridge cases, 1,139 raw-shader cases,
five shader-fault controls, 20 allocation/retry cases, 3,360 mip bridge cases and
13,680 sampler cases. The standalone software test passes 88 cases; restoring
only the preceding texture or fog interpolation independently fails it. Fresh
native runtime probes pass in copied and direct modes in both browsers.
Both browsers also pass all 28 keyboard/simulated-standard-gamepad checkpoints
on this fresh build, including API recovery, reconnect, two controllers, focus
loss and cached-page event resume.

A fresh private JSPI game build uses Wasm SHA-256
`9870e25b882cbe5839ea2d4af75cff0f0f4b2d115c289c0b82c575ab026cd6b1`.
A corrected Chromium image reference is compared with Firefox and repeat runs
of both browsers over fields 6000–6600. All three comparisons match all 600
shared images, and all four source-clock checks pass. Hashing every image
perturbs timing; these checks do not establish gameplay performance, zero
missing PCM, hardware fidelity or the cause of earlier intermittent mismatches.

A separate independent GS12.4 coverage probe still reproduces missed/extra pixels
for large offscreen triangles in both hardware and ordered routes. A private
floating-point separation trial also fails and is not selected. Basic upload
snapshot probes pass 480 cases per browser, including immediate source overwrite,
queued frames, shared memory and memory growth, but do not exclude every possible
lifetime defect in the game. Full WebGL rendering/media qualification remains open.
Private evidence is retained under `qa/webgl-fidelity-2026-11-02`.

## Render-target allocation recovery (2026-11-02)

Failed target creation/resizing previously published partial texture fields,
leaked resources and, at capacity, evicted an existing target before the
replacement existed. A framebuffer allocation returning null was also silently
registered. The renderer now completes a replacement before publishing it or
evicting the oldest cached set, releases partial allocations on failure, and
reports null framebuffer handles. The four-set steady-state limit is unchanged.

Thirty-nine real-WebGL fault cases pass per desktop browser, covering initial
allocation, resize and a full cache; each texture/framebuffer allocation point;
attachment exceptions; and incomplete framebuffers. They check complete retained
images, handle ownership, unchanged cache order, old-size reuse, exact clean
retries and successful eviction. The preceding implementation fails 37 of the
39 cases in each browser. Both browsers also pass 1,095 exact color/depth cases,
all three shader-fault controls, 20 data-texture allocation/retry cases, 3,360 mip
bridge cases and 13,680 independent sampler cases. The unchanged native runtime
probe with the corrected renderer helper passes in copied and direct modes,
including snapshots, partial transfers, register ordering, mip replay and six
injected GL faults. These are helper/runtime recovery checks; they do not certify
whole-game context-loss recovery or gameplay performance.

The corrected helper also passes all 28 native keyboard/simulated-gamepad
checkpoints per browser, including API recovery, reconnect, multiple controllers,
focus loss and cached-page event resume. Firefox matches all 600 shared game-image
hashes against a fresh unchanged-build reference. Chromium matches 599 of 600;
sequence 1320 differs and its raw pixels remain retained. An unchanged-build
capture matches the original reference at that sequence and localizes the
candidate difference to nine world pixels at x=76–79, y=77–79. RGB differences
reach 82 levels; alpha is unchanged. This localizes the discrepancy without
establishing its cause. Another instrumented Chromium image run fails the
source-clock check. These remain failed observations
and prevent a full WebGL fidelity/media qualification.

The fixed-state driver now writes its complete result and differing images before
enforcing the source-clock assertion, preserving evidence from media failures.
The frame boundaries, image comparisons and 50 ms source-clock gate are unchanged.

The separate WebGPU version 71 release and main branch are unchanged.

## Fresh performance comparisons (2026-11-02)

A fresh, unmodified JSPI baseline from `61cb976` uses Wasm SHA-256
`ad0cff7fa4e5b094ccc786fbd75ab41fe317543193152868e310091ee88846b4`.
New comparisons use the retained private state beginning at field 4700 and
measure fields 6000–6600, rather than the earlier state's 3600–4200 range. Each
trial uses fresh headed desktop browsers, 1280×800/DPR 1, direct presentation,
WebGPU withheld, and no GPU feature flags/preferences or concurrent GPU tests.
Native renderer work counts match across all eight windows of each comparison.
Each mean below includes two windows in baseline/candidate/candidate/baseline
order. Candidates retain byte-identical native Wasm, data and HTML.

| Trial | Chrome baseline / candidate images/s | Firefox baseline / candidate images/s |
| --- | ---: | ---: |
| Cache identical per-program settings uniforms | 59.703 / 59.359 | 48.148 / 47.609 |
| Plain vertex uniforms for batches of at most 32 primitives | 59.713 / 59.852 | 48.369 / 47.727 |

Both trials pass the existing 1,095 pixel/depth cases, shader negative controls
and allocation checks per browser. Neither establishes a cross-browser speed
improvement, and both remain private and unselected. Every performance window
retains intervals above 25 ms. All but one have missing PCM; the one clean-audio
Chrome vertex-uniform window still has a 28.20 ms maximum image interval. No
performance check was relaxed, and the allocation correction is not presented
as a speed improvement.

A separate instrumented diagnostic observes 187,323 settings calls, with 113,703
repeating the program's preceding values. The inputs were already ordinary
memory, so this is redundant-call evidence, not shared-memory transport evidence.
Another diagnostic attributes about 519 ms of a 12.46-second Firefox window to
JavaScript binning and 65 ms to opaque position validation. Diagnostic
instrumentation changes timing and is excluded from the performance means.
Private evidence remains under `qa/webgl-production-2026-11-02`.

## Constant color correction (2026-11-01)

The ordered WebGL shader and software reference now preserve equal vertex color
components exactly. An independent alpha-128 identity-blend test caught the
previous shared error: both implementations dimmed 69 pixels. Comparing them
to each other had hidden that defect. The independent oracle now checks the CPU
result as well as GPU output, and deliberately restoring the old shader fails.
Chromium 156 and Firefox 158 each pass 1,095 bridge cases, 1,127 raw-shader cases,
all three pixel-fault controls and 20 allocation/retry cases. Rebuilt runtime
probes also pass their constant-alpha check, 124 mip cases, six GL fault checks
and readback lifecycle checks in both browsers. This is a correctness fix;
WebGL gameplay timing and audio remain separate failed release gates.

## Follow-up diagnostics

Link-time optimization was tested privately on the JSPI build. Two direct
600-field windows per variant/browser averaged 58.83 versus 58.84 images/s in
Chromium and 44.88 versus 44.72 in Firefox, without versus with ThinLTO. The Wasm
file grew from 28,306,065 to 28,956,343 bytes. Runtime probes passed, but the first
Chromium oracle differed on image sequence 402, so timing remained diagnostic.
The compiler option was rejected; it is not selected in this branch.

Subsequent mismatch capture also found an outlier in the retained, unoptimized
JSPI build at image sequence 635. A matching-hash reference captured on a later
run localized it to ten pixels at x=476–479, y=209–211 on the right-hand HUD
meter. Alpha was unchanged. The cause remains unproved; this does not establish
that compiler optimization introduced or resolved the intermittent discrepancy.
Raw captures remain private and failed image observations are retained.

A separate native queue-wake trial did not improve the Firefox diagnostic:
45.64 versus 45.27 images/s with its policy disabled/enabled. Emulation and VU
threads spent approximately 50% and 79% waiting; the renderer's queue/capacity
wait counter was approximately 4%. That counter excludes browser-yield
suspensions. A separate instrumented run measured those at approximately 4% of
wall time and direct-presenter suspensions at approximately 1.5%. These are
bounded diagnostics, not a complete CPU utilization profile or qualification.
The wake trial was rejected.

An exhaustive hardware reverse-subtract prototype tested 8,912,896 pixels per
browser, including preserved alpha and over-range source controls. Its proposed
rounding correction still differed in 196,902 color components in each browser;
an uncorrected negative control also failed. It was rejected without changing
the integer renderer. A later GL-call diagnostic observed 483,179 texture uploads
in the fixed window. That instrumentation substantially reduced frame rate and
is excluded from performance qualification; it directs the next investigation
toward upload and submission costs.

A focused upload probe observed 68,181 full indexed-image uploads in the same
600-field window; 68,177 repeated bytes seen earlier. Its byte comparisons
substantially reduced frame rate, so it supplies reuse evidence only. A private
opaque vertex-buffer prototype passed the runtime, ordered/mip and shared-image
checks, but gave no material performance improvement and was rejected.

A bounded immutable indexed-texture cache was then tested privately. Its exact
byte comparison prevents hash collisions from substituting image data, and
shared handles preserve old images across updates and eviction. Both browsers
passed 20 asset-free cases covering deswizzling, address and stride changes,
copy-on-write, a constructed collision, small/zero-stride images, eviction and
reset cleanup. The full-hash version matched all 599 shared game images per
browser, but repeated windows averaged only 58.21 versus 58.82 images/s in
Chromium and 45.19 versus 45.69 in Firefox, baseline versus candidate.

A sparse-hash revision retained full byte comparisons and reached 59.21 in
Chromium and 47.99 in Firefox in separate single diagnostic windows. Maximum
intervals were 34.13 and 57.84 ms, and audio underruns remained. Both native
runtime probes passed. Chromium matched all shared images, but the first Firefox
oracle differed at image sequence 471. A subsequent candidate capture and a
baseline control matched every shared reference image. The failure is retained;
its cause is unresolved, and the timing is not qualification. The cache remains
private and unselected. Both browsers also passed 28 native input/resume checkpoints on this final
private candidate, using simulated standard pads, including disconnect, reconnect,
multiple controllers, API recovery and cached-page resume. These observations do
not resolve the failed image check.

The fixed-state oracle now optionally compares a supplied reference, enforces a
caller-selected minimum overlap, and preserves raw differing pixels plus the
result before rejecting a mismatch. It does not filter isolated failures. This
allows the next intermittent discrepancy to be inspected on its first occurrence
instead of depending on a later reproduction. Game data and captures remain
outside the repository.

Further retained-build captures found isolated world-image differences: four
pixels at sequence 519 and six at sequence 403. At the latter frame, both runs
had identical SHA-256 fingerprints over all 331 ordered packets, including
settings, vertices, target dimensions and resource IDs. Another failure at
sequence 559 had matching fingerprints for its 233 ordered packets and all 605
captured texture update/creation calls, including palette uploads and their
client-memory bytes. No uploads were skipped. Some startup fingerprints differ,
so these observations do not prove identical complete GPU histories. Native
fallback draws, graphics state and shader precision remain to be investigated;
they do not establish a cause or excuse the failed images.

The private cache's allocation/upload-failure test exposed silent reuse of old
content. Its corrected path preserves the prior immutable image and dirty flags,
reports the error, and allows a subsequent retry. Both browsers pass 22 synthetic
cases, their rebuilt runtime probes and 599 shared game-image comparisons. Debug
exports were removed. The cache remains unselected.

A separate private specialization precompiled one-, two- and three-level mip
programs and avoided unused sampler bindings. Both browsers passed 1,094 ordered
cases, the expanded 3,360 mip bridge cases, all native probes and 599 shared game
images. Nine linked-program checks confirmed unused mip samplers were absent.
Repeated Firefox windows averaged 46.19 versus 47.77 images/s, baseline versus
candidate. Chromium baseline windows were 38.02 and 57.91; candidate windows were
57.66 and 59.19. The slow baseline is unexplained and remains in the record, so
these results do not establish a consistent Chromium speedup. Audio and interval
gates failed. The specialization remains private and unselected. The retained
bridge suite now exercises every maximum mip level from 0 through 6; both browsers
pass its 3,360 exact comparisons with the preceding renderer.

A further private binding-cache trial reserves texture units 3–14 for the
ordered renderer. A negative control exposed an unsafe host handoff: native GS
helpers can bind on the currently active unit. Leaving active unit zero at each
handoff corrects the generated-mesh control in both browsers; explicit cache
invalidation also survives deliberately poisoned bindings. The fixture reduces
texture binds from 281 to 171 and sampler binds from 120 to 4 with identical
pixels. Both browsers pass all ordered/mip cases, native probes and 599 shared
game-image comparisons. Repeated Firefox windows average 45.85 versus 47.97
images/s, previous specialization versus binding-cache candidate; Chromium
averages 54.12 versus 55.75, with inconsistent individual windows. All performance
windows retain frame-gap/audio failures. This trial remains private and unselected.

Fresh native input checks on that prototype pass all 28 checkpoints in each
browser, including all 16 mapped buttons, both sticks, trigger pressure, two
controllers, disconnect/reconnect, API recovery, focus changes and cached-page
event resume. There are no application errors or warnings. Standard gamepads are
simulated through production polling and real native exports; physical hardware
remains unqualified. The asset-free input/resume suite also passes 32 scenarios.

The intermittent image investigation remains open. Two immediate synchronous
reads of a failing image returned identical bytes; this does not certify the
readback path. Four immutable-upload-copy runs matched, but a baseline failed,
so those observations do not establish a fix. Native buffer-input fingerprints
were added to a diagnostic run, but no failing image was captured with them.
Separately, generated jittered meshes matched the opaque and general raster
paths at three target sizes in both browsers, including Gouraud, linear texture
and Q-based mip cases. None of these passing controls excludes other GPU state,
command-order or native fallback causes.

A separate Chromium CPU profile identified native VRAM transfers, register
forwarding, browser GL calls and ordered rendering as material costs. A
symbol-map link changes Wasm function indices, so names were resolved only
against a separately profiled matching mapped binary. Profiled timing is excluded
from qualification. A private vertex-reuse trial then passed 20,000 independent primitive-assembly
comparisons, both native runtime probes and all 599 shared game images in each
browser. Repeated gameplay windows averaged 58.51 versus 59.21 images/s in
Chromium, baseline versus candidate, but 47.99 versus 47.68 in Firefox. All
windows still failed frame-gap/audio gates. The trial was rejected and its
runtime changes were removed; synthetic vertex reduction is not a demonstrated
cross-browser gameplay improvement.

A private native-presentation handoff then avoided graphics-state queries only
outside protected native GS calls or at an explicit frame-capacity wait. Native
upload observations stayed inside the protected scopes, and both browsers passed
35 generic and 35 handoff lifecycle cases, borrowed/denied-handoff state checks,
CPU uploads, viewport checks, native probes and 599 shared images. Repeated windows
averaged 59.09 versus 58.96 images/s in Chromium and 47.31 versus 47.14 in Firefox,
baseline versus handoff. It was rejected and removed; the generic presenter remains.

A separate private SIMD PSMCT32 upload prototype converts complete 8×2 columns
while preserving the scalar fallback for partial rows, wrapping and aliased
source memory. Its full-memory differential checks pass 1,469 cases, including
dirty flags and transfer cursors. A wrong-shuffle control fails, as does a control
without the restored-cursor overflow guard. In separate repeated Node/Wasm micro
benchmarks, 1,000 uploads of 256×256 pixels took about 11 ms unchanged or 25 ms
changed, versus 122 or 151 ms for the scalar implementation. These are isolated
conversion measurements, not browser frame-rate results.

Both compiled browser probes and all 599 shared game images pass on that SIMD
build. Its repeated gameplay windows averaged 56.26 versus 54.71 images/s in
Chromium and 46.93 versus 46.95 in Firefox, preceding private cache prototype
versus SIMD candidate. Large slow windows remain in these averages; no overall
gameplay gain is established. Frame-gap and audio gates still fail. The SIMD
prototype stays private and unselected. Fresh native controller checks pass all
28 checkpoints in each browser, with no application errors or warnings, using
simulated standard gamepads.

A separately instrumented build counted uploads over native fields 3600–4200.
Both browsers reported identical counts: 74,020 PSMCT32 calls and 271,161,216
offered pixels, all handled by the SIMD path. Missed narrow/partial upload coverage
does not explain this window's remaining performance. These counters do not prove
broader gameplay coverage or turn diagnostic timing into qualification.

A matching symbol-map build was then sampled with Firefox's
[built-in profiler extension](https://firefox-source-docs.mozilla.org/remote/webdriver-bidi/Extensions.html#profiler-module).
Profiler requests are asynchronous: start was requested at native field 3600 and
acknowledged at 3639; stop was requested at 4200 and acknowledged at 4207. An
interior 10.81-second sample region contains 9.23 seconds of main content-thread
CPU time. WebGL texture uploads account for 2.43 seconds inclusively; 1.80 seconds
are attributed to the nearest identifiable `dataTexture` caller. Those values
overlap and must not be added. PSMCT32 conversion accounts for about 0.10 seconds.
Native frames are partly unsymbolicated, so caller attribution is approximate.
This profile directs investigation toward upload/submission costs; it is not a
qualified frame-rate run or proof of a specific browser/driver defect.

A subsequent private copy staged shared vertex-data inputs in ordinary immutable
buffers. Its Wasm binaries are byte-identical to the SIMD baseline. Forced-shared
fixtures pass all 1,094 ordered and 3,360 mip comparisons per browser, and both
native probes and 599 shared game images pass. Repeated windows nevertheless
regress: Chromium averages 59.82 versus 56.59 images/s and Firefox 49.64 versus
47.63, baseline versus copy. All gap/audio gates fail. The copy was rejected and
removed. These later baseline windows do not establish a controlled SIMD speedup
over the earlier cache prototype. The hosted WebGPU release remains unchanged.

Further exact-content diagnostics found limited reuse between whole vertex
uploads: a 256-entry, 8 MiB cache matched under 1% of their bytes. An exact shadow
of existing index texture contents matched 10.1% of calls; unchanged tile-header
rectangles matched 9.7%. Those caches were not implemented. Their diagnostic
copies/comparisons perturb timing and can alter batching, so counts from separate
instrumented runs are not a canonical command-history fingerprint.

A private wider data-texture layout then tried to reduce full-row/tail upload
splits without copying active bytes. Both browsers passed the default and forced
wide ordered/mip suites. Sixteen large-mesh comparisons per browser also matched
across 1,024-, 2,048- and 16,384-wide layouts, including multirow vertex/index data;
wrong shader-width controls produced over 15,000 differing pixels. Both native
probes passed. The first Chromium game oracle nevertheless failed at image 417:
two world pixels at x=104, y=247–248 differed by one red and two blue levels. Raw
captures are retained. An unchanged-build capture, wider-build Chromium retry
and wider-build Firefox run each matched all 599 shared images; the original
failure remains unresolved.

Repeated wider-layout windows averaged 59.64 versus 59.67 images/s in Chromium,
baseline versus candidate. Firefox baseline windows were 36.51 and 49.93, versus
49.33 and 49.31 for the candidate (means 43.22 and 49.32). The unexplained slow
baseline remains in the record; these windows do not establish a reliable
speedup. All frame-gap/audio gates fail. The wider layout is unselected and its
source changes were removed.

The next lossless-upload investigation compares complete 32-byte vertex records
within neighboring triangles. In a full 600-field diagnostic, the existing
1,634,781,984 vertex bytes could be represented by 829,765,808 bytes, including
reference tables, headers, padding and fallback for packets that do not benefit.
That is a 49.2% payload reduction, not a measured frame-rate gain. A standalone
native encoder passes 210 aligned/unaligned synthetic layouts, preserving every
attribute bit and rejecting wrong/out-of-range references in verification.
The native encoder was subsequently integrated into a private build. Original
CPU vertices remain available for binning and validation; only the GPU upload
uses complete-record references. Each packet selects the smaller representation,
and reference decoding preserves primitive order and every attribute bit.
Both browsers pass all 1,094 ordered and 3,360 mip cases with references forced
on, including the existing depth/order and level-zero negative controls. A
separate integer-GPU test reconstructs all raw words in 20 layouts per browser,
including NaN payloads, signed zero and reference tables spanning texture rows.
Wrong-reference and missing-flag controls fail, and seven malformed packet forms
are rejected before target use. Eight large rendered comparisons per browser
also match for opaque/general, flat/Gouraud, linear and mip paths.

Both rebuilt native probes pass, and the candidate matches all 599 shared game
images in each browser. Its repeated unprofiled fields 3600–4200 nevertheless
fail performance: Chromium baseline windows measure 59.50/59.67 images/s versus
59.28/59.26 with references; Firefox baseline windows measure 37.10/47.91 versus
38.75/36.93. The slow baseline is retained. Candidate maximum intervals reach
32.90 ms in Chromium and 87.52 ms in Firefox, and every window has audio
underruns. There is no demonstrated gameplay gain, so the broad reference
integration is unselected. Its `logicalVertexBytes`/`referencedBatches` counters
include packets culled before uploading, whereas `vertexUploadBytes` counts
actual offered upload bytes; their ratio is not an exact upload-saving measure.

Fresh keyboard and simulated standard-controller checks on this private build
pass all 28 native checkpoints in each browser, with no application errors or
warnings. Native Gamepad API access is checked before replacing it with the
synthetic pads. Coverage includes all mapped buttons, both sticks, trigger
pressure, two controllers, disconnect/reconnect, API denial/recovery, hidden-tab
neutralization and cached-page event resume. These are software input checks;
physical hardware remains untested. The hosted WebGPU release is unchanged.


A final private JavaScript diagnostic retained references only for batches
meeting the existing opaque-route conditions. No new shader or native binary
was built for this diagnostic. Chromium baseline windows were 59.51/59.65
images/s versus 59.29/58.90; Firefox baselines were 48.71/38.61 versus
44.84/37.62. One candidate window delivered 598 images across 600 fields.
Every window retained audio underruns and intervals above 25 ms. The variable
baselines are retained; this diagnostic supplies no reliable gain or new fidelity
qualification. Both reference variants were rejected, and the private working
source/vendor were restored to the preceding SIMD/cache prototype. Immutable
candidate binaries and their patch/hash records remain private. Reducing the
number of upload submissions is a remaining investigation, not an implemented
or measured improvement.


A private combined-upload trial then staged raw vertices, packed indices and
compact tile headers into one RGBA32UI texture for ordered batches. Opaque
batches kept their preceding path. Both browsers pass 1,094 ordered and 3,360
mip cases with the option forced on, plus sixteen exact large-mesh comparisons
and six deliberately wrong layout controls. Nonzero tile origins and multirow
vertex/index data are covered. The large ordered cases reduce actual data-upload
calls from five to two. Both native probes and 599 shared gameplay images pass.
Repeated gameplay windows nevertheless average 59.68 versus 59.86 images/s in
Chromium and 49.68 versus 49.41 in Firefox, baseline versus candidate. All windows
retain frame-gap/audio failures; no dependable cross-browser gain is established.

A second private variant combines only indices and tile headers, preserving
shared-memory vertex uploads. It passes the same synthetic, native and shared-image
checks. Repeated windows average 59.55 versus 56.96 images/s in Chromium and
49.63 versus 49.95 in Firefox. The individual Chromium candidate windows are
55.23 and 58.69; both remain in the result. All frame-gap/audio gates still fail.
Both upload variants were rejected and removed from the working runtime.

The allocation investigation exposed a separate correctness bug in the retained
bridge: failed data-texture growth could delete the old image and publish the new
cached row count before replacement storage existed. Texture allocation now
reports null handles and driver storage errors, frees incomplete replacements,
and updates the cached handle/dimensions only after successful allocation.
Twenty asset-free cases per browser cover first allocation and growth in R32UI
and RGBA32UI, including null handles with/without a GL error, thrown storage or
parameter calls, and a real invalid-storage driver error. They verify old pixels,
resource ownership and exact clean retries. The preceding implementation fails
all twenty cases in each browser. The regular ordered/mip suite also passes on
the isolated fix. Expected injected driver warnings remain in evidence; other
warnings and uncaught errors fail the allocation verifier. This is helper-level
allocation recovery, not whole-game context-loss recovery or a performance fix.

The private retained renderer rebuilt with the allocation fix also passes both
native probes and matches all 599 shared game images in each browser. Fresh
keyboard/simulated-standard-gamepad checks pass all 28 native checkpoints per
browser with no application errors or warnings. The checks include reconnect,
two controllers, analog inputs, API recovery and pause/resume. Physical pads are
not tested. No new performance qualification is claimed for this correctness
change; the hosted WebGPU release remains unchanged.


Two further private vertex formats preserve exact 12.4 positions, 24-bit depth,
8-bit fog and every color/STQ bit in six words, with the original eight-word
format retained whenever the checks fail. A reserved high format bit avoids
colliding with existing packet hints. The first layout packs records into
RGBA32UI texels; the second uses two RGB32UI texels per vertex and separate
packed/raw textures to permit safe fallback switches. Each passes twenty native
aligned/unaligned layouts plus rejection/alias guards, twenty integer-GPU
reconstruction layouts, two corrupted-data controls, four malformed-payload
checks, 1,094 ordered and 3,360 mip comparisons, and sixteen large rendered
comparisons per browser. NaN payloads and signed zero in STQ remain intact;
positions that cannot round-trip exactly use the original representation.
Both native probes and all 599 shared gameplay images also match per browser.

Actual RGBA-layout upload counters show approximately 24.98% fewer vertex bytes,
including padding. Its isolated Wasm encoder processes 12.288 million vertices
in 51–58 ms across five runs, excluding browser upload/draw costs. These byte and
microbenchmark results do not establish a game-speed gain. Repeated RGBA-layout
windows average 57.95 versus 59.15 images/s in Chromium and 45.14 versus 44.66 in
Firefox, baseline versus candidate. Individual Firefox baselines are 49.36/40.92
and candidates 49.59/39.73; the slow windows remain included. The RGB-layout
comparison averages 54.32 versus 55.74 in Chromium and 43.90 versus 41.62 in
Firefox, again with substantial session variation. Every window retains
frame-gap/audio failures. Neither format demonstrates a dependable cross-browser
gain; both were removed from the working runtime. Fresh RGB-candidate keyboard
and simulated gamepad checks pass all 28 native checkpoints per browser without
application errors or warnings.

The fixed-window observations begin only about 5–9 seconds after page load.
A separate unchanged-build Firefox check repeats the identical saved-state
window in three new pages within one browser session. It measures 49.65, 47.14
and 49.28 images/s, cold then two repeats; all have audio underruns and maximum
intervals of 48.18–57.06 ms. A warmed reload does not remove the performance
failure. This does not isolate compiler tiering or establish steady-state
performance across the full game.

Further analysis of the existing Firefox profile uses matching Mozilla build
identifiers and its [native symbolication service](https://github.com/firefox-devtools/profiler/blob/main/docs-developer/symbolication.md).
Previously unnamed CanvasRenderer callers include texture subimage uploads,
shared-memory mapping cleanup and draw submission, as well as event-loop wake
frames. These are sampled caller attributions over thread-specific diagnostic
ranges, not additive self times or a new gameplay benchmark. A separate submitted
batch counter finds 6,402 batches in the 600-field window that meet the existing
hardware conditions except for complete-channel framebuffer masking. No sampled
batch qualifies solely by allowing PSMCT24 or alpha-failure KEEP. Extending the
per-channel mask path is an unimplemented candidate, not a measured speedup.
The main branch and hosted WebGPU release remain unchanged.


The complete-channel-mask path was then implemented privately for PSMCT32 only,
using fixed-function component write masks while retaining every other hardware
eligibility condition. Partial-bit masks and masked 16-bit targets keep the
ordered path. An expanded 1,222-case bridge matrix passes in each browser,
including all sixteen component masks, depth modes, FBA, textures/filtering and
explicit routing guards. Both intentional depth/order controls and twenty
allocation/retry checks still pass. The preceding implementation fails the new
hardware-routing assertion. Forty-eight larger comparisons per browser also
match, including fractional geometry, distinct preserved channels and three
target sizes.

Both compiled native probes pass, and Chromium matches all 599 shared game
images. The first Firefox oracle instead fails at image sequence 526: twenty-three
world pixels differ, with unchanged alpha and RGB differences reaching 90 levels.
An unchanged retained-build capture matches the original reference and localizes
those differences. This is larger than the earlier isolated rounding observations.
The failure is retained; there is no performance qualification or selected runtime
change for this prototype.

A private diagnostic then records normalized GS register writes, effective
vertex attributes, uploaded image words and display registers at presentation
boundaries. A forced-ordered baseline matches the image reference; one candidate
run fails at sequence 461 and a candidate repeat matches. Every recorded GS-input
fingerprint and count matches the baseline over 691 comparable boundaries in the
failed run and 692 in the clean repeat. Retained raw command words for boundaries
523–530 also have identical SHA-256 hashes across all three runs; sequence 461 is
outside that raw retention range. These are GS-input comparisons, not complete
GL API histories or proof of the cause.

A separate diagnostic copies the initial target color/depth and replays each
newly eligible batch through both hardware and forced-ordered paths. A GPU
comparison checks color and depth before returning a one-pixel difference flag.
With explicit high-precision depth samplers, 7,762 candidate batches and 7,738
forced-ordered control batches match. A deliberate one-pixel corruption detects
one changed color and one changed depth value. This diagnostic introduces copies,
queries and synchronous reads; its passing result does not exclude a state,
resource-lifetime or timing problem in the ordinary pipeline. Diagnostic timing
is excluded from qualification, and native input tracing was removed from the
working source after the captures.

The normal private candidate also passes all 28 keyboard/simulated-gamepad native
checkpoints in both browsers, without application errors or warnings. Those
input checks do not clear the failed image oracle. The masked path remains
private and unselected while investigation moves to GL calls and resource-update
histories. Main and the hosted WebGPU release remain unchanged.

Further private GL-input traces match all 599 shared reference images, but their
overhead changes scheduling and they have not captured a failing image. A smaller
state observer does reproduce a failure at sequence 617. A reference-matching
retained-build capture localizes it to twelve pixels in a 4-by-3 patch, with RGB
differences up to 152 levels and unchanged alpha. The failure remains retained.
That run reports no inconsistency across 227,200 target-depth checks, 682,083
cached-texture checks and 576,795 cached-sampler checks. These observations narrow
the checked hypotheses; they do not establish the cause or clear image fidelity.

The [state observer and its negative controls](../tests/webgl_backend/README.md#native-gl-state-diagnostic)
are now reusable from the fixed-state oracle. Both browsers detect deliberate
depth, texture and sampler faults. The native failing capture and diagnostic
hashing tools remain private. No renderer optimization or hosted change is
selected from these results.

## Cached-page lifecycle and native stack switching

The direct presenter previously disposed its GL resources on every `pagehide`,
including cached documents whose Wasm runtime remained resumable. A controlled
cached-page event reproduced that disposal in both browsers. The presenter now
retains its resources when `event.persisted` is true; ordinary page disposal still
cancels pending work and frees owned resources. Both browsers pass 35 presenter
lifecycle scenarios, including retained queued images, resumed presentation and
subsequent noncached disposal. These simulate lifecycle events, not browser
back/forward-cache eligibility or actual navigation.

WebGL also accepts an explicit `PS2_WEB_ASYNC=jspi` build. The installed Chromium
156 and Firefox 158 expose the required APIs without feature overrides. Both
compiled runtime probes pass, and both JSPI gameplay oracles match all 599 shared
image hashes against the retained reference. Renderer work counts match exactly.
The compatibility Asyncify configuration remains available. CI is configured to
compile both probes; the default hosted WebGPU release remains unchanged.

Before the lifecycle-only fix, repeated direct-presentation windows compared
Asyncify/JSPI/JSPI/Asyncify over fields 3600–4200 in fresh headed desktop sessions.
Chromium averaged 55.96 versus 58.34 images/s; Firefox averaged 42.88 versus 43.83.
JSPI maximum intervals reached 33.45 ms and 54.30 ms respectively; all windows had
audio underruns. These results support an experimental build option, not release
qualification. The final lifecycle-fixed bundles passed 28 native input/resume
checkpoints for each browser and suspension mode, using simulated standard pads.
Physical controllers and broader gameplay remain unqualified.

A separate fused-framebuffer-input trial removed 100,911 of 378,268 raster draws
from the fixed window and matched all 599 common game images in each browser.
Independent GL-call counters confirmed two ordered draws instead of three; the
preceding renderer fails that count check while retaining exact fixture pixels.
The trial passed 1,094 ordered and 1,920 mip bridge cases per browser plus runtime
probes. Chromium averaged only 56.17 versus 56.61 images/s. Across three Firefox
windows per variant, the average fell from 43.96 to 42.50, including an unexplained
37.94 candidate window. A later candidate recovered to 45.20, but did not explain
that failure. The fusion trial and its extra fixtures were rejected.

## Opt-in direct presenter follow-up

The experimental branch now includes the same-context GPU presenter behind
`?direct`; the default copy presenter and hosted WebGPU release are unchanged.
The follow-up adds CPU-region fallback, bounded pending submissions,
resource/partial-initialization cleanup and exactly-once completion. The prior
prototype could call a completion callback twice if it threw; the corrected
path preserves the original exception. Fractional destination sizes now use a
full-canvas viewport and explicit edge coverage instead of truncating the
viewport and clipping image edges.

Asset-free checks exercise 35 lifecycle scenarios per browser, foreign GL-state
and resource ownership, ten CPU images and 20 resampling cases. The compiled
runtime extension checks 32 GPU images and 24 CPU-region images, including four
PS2 formats, halved rows and rejection of an earlier GL fault. Browser automation
uses standard simulated gamepads; 27 native keyboard/gamepad checkpoints passed
per browser on the hardened private player. Separate fixed-state image oracles
matched all 599 shared prepared-image sequences against the copy renderer in
each browser; the adjacent window-edge observations remain separate.

Before the viewport correction and redundant state-query removal, single
600-field diagnostic comparisons measured 52.43 versus 56.12 images/s in
Chromium and 36.32 versus 44.16 in Firefox (copy versus direct). Both direct
windows still had audio underruns and maximum intervals above 25 ms. These
numbers are not a qualification of the final source or full-game fidelity.
An earlier copy run also differed on one image; a later private upload trial
captured a 12-pixel texture discrepancy. Additional diagnostic reads did not
establish its cause. The failed observations remain open evidence.

The initial direct-presenter commit `de9866c` passed
[source CI](https://github.com/therealparmesh/ssx3/actions/runs/41272626640).
The clean game bundle contains no test-only capture hooks. `copy/direct/direct/copy`
comparisons used the same compiled JS/Wasm/data in fresh sessions, with two
600-field windows per path/browser (fields 3600–4200). All renderer work counts
matched exactly. Mean results were:

| Browser | Copy images/s | Direct images/s | Worst direct interval | Mean missing stereo PCM frames |
| --- | ---: | ---: | ---: | ---: |
| Chromium 156 | 53.53 | 55.38 | 37.61 ms | 40,688 |
| Firefox 158 | 37.52 | 45.05 | 51.60 ms | 156,672 |

Direct Chromium windows varied from 53.39 to 57.37 images/s; both Firefox windows
were close to 45. Final-source image oracles again matched all 599 common image
sequences in each browser, keeping both unmatched window-edge observations.
The input checks also passed 27 checkpoints per browser on the rebuilt player.
These bounded results establish an improvement and failed release gates, not
completion of the overall production goal.

The public fixed-state tool now also supports the direct presenter, injecting
test-only texture capture only in oracle mode. Its direct runs matched all 599
shared image hashes in each browser; Firefox copy matched all 600. Chromium copy
differed at prepared-image sequence 403 in this run. That failure is retained
alongside the preceding intermittent differences; these checks do not resolve
the open image discrepancy. Both browsers passed the updated CPU capture fixture
and compiled direct-runtime probe.

The direct path is not production ready and must not replace WebGPU until its
current-source performance, audio and longer gameplay paths qualify. Reproduction
commands are in [building](building.md#opt-in-direct-webgl-presentation).

## Rejected whole-byte mask trial

A private follow-up allowed hardware color-channel masks for PSMCT32 and bypassed
RGB blending when all RGB bytes were preserved. Partial-byte masks, packed formats,
destination-alpha tests and the existing depth/alpha guards retained the ordered
path. Both browsers passed 1,290 bridge and 1,322 kernel color/depth cases, with
negative controls for depth, ordering and forced masked-channel writes. Runtime
probes passed, and both game oracles matched all 599 shared image hashes.

Repeated baseline/candidate/candidate/baseline windows used the same fields
3600–4200, direct presentation, headed 1280×800/DPR 1 sessions and no GPU overrides.
Chromium averaged 56.96 versus 57.21 images/s; Firefox averaged 44.37 versus 44.91.
Candidate maximum intervals reached 35.89 ms and 56.72 ms respectively, with audio
underruns in every window. These small differences relative to session variation
do not establish meaningful progress toward the release target. The trial was
rejected; its code and additional fixtures are not selected in this branch.

The retained direct-presenter bundle independently passed another 27 native
keyboard/controller checkpoints in each browser, including disconnect neutrality
and resume ordering. Those checks simulate standard browser gamepads; physical
controllers were not tested. Source commit `6bc4241` passed
[CI](https://github.com/therealparmesh/ssx3/actions/runs/41274896292).
The hosted WebGPU release and main branch remain unchanged.

## Private GPU presentation trials

Three initial display-transfer alternatives were tested against the fence-backed
copy presenter. Those initial variants were not selected or included in the hosted
WebGPU release.
These are ordinary-menu, partial Snow Jam race windows at 1280×800/DPR 1,
with WebGPU withheld, default Performance effects, no GPU feature overrides,
and no overlapping build or profiler. Scene variation prevents treating these
windows as deterministic speed comparisons.

| Private presentation path | Chromium images/s | Firefox images/s |
| --- | ---: | ---: |
| ImageBitmap queue with intermediate 2D scaling | 58.91 | 34.28 |
| GPU logical resolve and full-size BitmapRenderer transfer | not qualified | 30.45 |
| Same-context source FBO and three-texture FIFO | 58.32 | 45.99 |

All three trials pass the real renderer API fixture in both browsers,
including 32 additional FIFO frames and 90,560 independently checked logical
pixels, varying source sizes, odd interlaced crops and bounded capacity waits.
The same-context trial redirects both synchronous and asynchronous source
exports to its FBO. Snapshot/error checks exposed restoration of a deleted
shader program; the corrected trial passes the injected-error boundary and
suppressed-error negative control. These logical-pixel checks do not qualify
every final viewport size or the remaining production lifecycle work.

The same-context trial removes display readbacks and ImageBitmap transfers,
but still fails delivery and audio requirements. Chromium presents 1,167
images over 20.011 seconds, with a 43.40 ms maximum interval and 38 intervals
above 25 ms. Firefox presents 921 images over 20.024 seconds, with a 51.86 ms
maximum interval and 302 intervals above 25 ms. Neither normal gameplay run
logs application errors or warnings.

Actual AudioWorklet read-counter instrumentation observes 23,712 underrun
frames in Chromium (0.494 seconds at 48 kHz) and 221,600 in Firefox
(4.617 seconds). The full-size BitmapRenderer Firefox trial records 467,968
underrun frames (9.749 seconds). In all three instrumented windows, source
audio and native video clocks remain within the 50 ms synchronization bound
while progressing too slowly in real time. A passing source-clock comparison
therefore cannot substitute for real-time presentation and zero actual audio
underruns; the existing media gate requires all of them. The same immutable same-context game also passes all 27 native keyboard and
simulated standard-controller checks in both browsers, including all buttons,
analog pressure, independent sticks/D-pad, disconnect/reconnect, two-controller
reordering, API denial/recovery, hidden-tab suspension and restoration of held
inputs before native resume. Both sessions report zero application errors and
warnings. These are browser API checks, not physical-controller certification.
The trials remain private diagnostics, with context/resource cleanup,
CPU-region fallback, long-run stability and completed-race qualification still
open.

## Raster and upload retests

The earlier single-draw ordered-raster trial was retested with the newer
scheduler and same-context presenter in Firefox. It still passes the
1,062-case exact color/depth matrix, depth/order negative controls and real
runtime API fixture, including mip, snapshot, register-order, slice-budget,
GL-fault and FIFO pixel checks. Its sampled race window reduces raster draw
calls from the preceding trial's 567,849 to 265,596, but delivers only 900
images in 20.014 seconds (44.97/s), with a 52.20 ms maximum interval and
234,400 actual AudioWorklet underrun frames (4.883 seconds at 48 kHz).
Reducing this pass count alone does not meet the delivery gate. The shader
alternative remains outside source.

A separate roughly 12-second Firefox diagnostic instruments bridge methods
and GL entry points. It records about 1.60 seconds inside bridge texture
uploads and 0.96 seconds inside native texture uploads. The bridge's `render`
method takes about 5.63 seconds inclusively across 128,305 calls; this includes
its child methods and GL calls, so the timings must not be added together.
Instrumentation changes throughput. These observations identify submission
costs for investigation, not uninstrumented gameplay performance.

A subsequent private trial rotates upload textures, retaining at most 64
slots and a four-MiB budget per stream, except that one supported texture
larger than that budget can still be allocated. The fixture and real runtime
checks pass in Firefox, and the sampled game uses eight MiB across its two
streams. With the same-context presenter, the first normal-menu race window
presents 1,049 images in 20.019 seconds (52.40/s), with a 65.68 ms maximum
interval and 115,872 actual underrun frames (2.414 seconds). The same storage
change on the selected PBO/copy player presents only 742 images in 20.002
seconds (37.10/s), with a 67.24 ms maximum interval and 319,936 underrun frames
(6.665 seconds). Both game sessions log no application errors or warnings.
Each storage trial preserves its respective baseline Wasm; only the private
JavaScript upload method and its loading hook differ. These naturally varying
partial-race windows do not prove a deterministic speed gain. The rotation
is not selected, and it cannot be assumed to improve other presenters.
Chromium was not qualified for these later trials. The production WebGPU
release and selected WebGL renderer are unchanged.

## Private worker-owned WebGL prototype

A later private prototype runs the same-context WebGL renderer on the existing
runtime worker, with the DOM canvas transferred as an OffscreenCanvas. WebGPU
is withheld and no GPU enablement preferences are applied. The initial menu
run boots and draws, but a native-frame wait times out after resume: the worker
is actually at frame 4,607 while the page's shared status still reports 1,964.
The game resumed; the worker's timer-based telemetry publisher was starved.
Publishing shared status at presentation fixes that trial's ordinary-menu
navigation and repeated native pause acknowledgements. The failed telemetry
runs remain separate from the later performance window.

The corrected worker trial presents 920 images over 20.005 seconds (45.99/s),
with a 64.20 ms maximum presentation interval and 219,776 actual underrun
frames (4.579 seconds at 48 kHz). The page's 16 ms timer runs 1,242 times and
its largest gap is 17.78 ms, with none above 100 ms. The earlier main-thread
same-context trial's largest timer gap was 267.70 ms. Worker ownership removes
the large observed page task stalls; it does not establish 60 fps or continuous
audio. The first worker observer routes source-clock captures to the wrong
comparison field. Its original result is retained; a separate comparison of
the saved native captures passes the 50 ms bound. This is not a passing media
qualification.

The same worker prototype in Chromium presents 1,158 images over 20.013
seconds (57.86/s), with a 37.23 ms maximum interval, 31,264 actual underrun
frames (0.651 seconds), and an 18.21 ms maximum page-timer gap. Its source-clock
comparison passes while delivery and actual audio still fail. Neither browser
therefore qualifies for release on this private path.

A same-Wasm JavaScript trial enabling the alternate timer race for buffered
WebGL delivers 884 images in 20.010 seconds (44.18/s), a 54.24 ms maximum
interval and 249,056 underrun frames (5.189 seconds). Its page timer's maximum
gap is 18.26 ms. The corrected observer's source-clock comparison passes,
again while output is too slow. The timer change is rejected. Neither normal
worker gameplay window logs application errors or warnings. The corrected worker game also passes all 27 native keyboard and simulated
standard-controller checks in Chromium and Firefox, with the real worker input exports
observed after forwarding each call. This includes both sticks, trigger
pressure, disconnect/reconnect, two-controller reordering, hidden-tab pause
and held-input restoration before native resume. Both sessions report no
application errors or warnings. Worker pixel,
lifecycle and resource qualification remain incomplete; the source build
still rejects WebGL worker mode and these prototypes are not shipped.

## Same-state race benchmark and further rejected trials

A new private state capture restores the same Snow Jam race entry in fresh
Firefox sessions. Two ordinary-player oracle runs agree on all 20 SHA-256
observations of native image bytes at fields 3600, 3630, …, 4170. This establishes
those sampled observations, not complete determinism or full-game fidelity.
The repository now includes a [fixed-state browser driver](../scripts/test_browser_fixed_state.cjs)
that needs no extra exports in the player. It observes the exact native-field
boundaries inside callbacks, actual copy submissions, actual AudioWorklet
underruns and source-clock bounds. Hashing runs separately from performance.
A late-boundary negative control fails rather than silently shifting the range.
See [usage](building.md#repeatable-private-race-measurements).

With the ordinary unchanged WebGL player, fields 3600–4200 produce:

| Browser | Fresh images/s | Native fields/s | Longest image interval | Actual underrun frames at 48 kHz |
| --- | ---: | ---: | ---: | ---: |
| Chromium 156 | 53.27 | 53.27 | 39.01 ms | 60,256 |
| Firefox 158 | 36.64 | 39.76 | 65.98 ms | 242,592 |

Both use headed Linux browsers, 1280×800/DPR 1, no GPU feature flags or Firefox
preferences, and WebGPU withheld. The source clocks pass, pages render the race,
pause is acknowledged and there are no application errors/warnings. Both fail
release delivery/audio requirements. This is a bounded private-race measurement,
not a completed race, physical output check or new hosted release. A first
port of the driver omitted the audio observer's subframe availability guard;
that script error was corrected before these measurements.

Two other renderer trials remain unselected. Skipping unused mip texture/sampler
bindings preserves both browsers' mip, ordered and native API oracles, including
untextured packets with unused reserved TEX1 bits. It avoids 365,585 and 344,886
level bindings in two Firefox windows but delivers 37.40/38.24 images/s against
bracketing original controls at 37.92/38.53. It establishes no gameplay gain.

A separate opaque route for whole-byte RGBA32 framebuffer masks passes 32
additional exact color/depth cases in both browsers, plus the original native
API probe and original-path controls. A deliberately ignored channel mask fails
pixel comparisons with no GL error. The verification snapshot explicitly resets
its own color-write mask before reading the target. An ordinary-menu candidate
window delivers 40.46 images/s versus a fresh control's 43.52; these are naturally
varying scenes. The subsequent same-state comparison uses identical private
QA Wasm in all four runs, exact fields 3600–4200 and unchanged source-clock checks.
Two controls together deliver 40.683 native fields/s and 37.259 images/s; two
mask candidates deliver 40.608 native fields/s and 37.461 images/s. Actual audio
underruns total 452,672 and 455,072 frames, respectively. Reduced fixture work
and one faster run do not establish a repeatable throughput gain. The mask route
is not selected. Runtime, renderer and hosted release remain unchanged.

## Further allocation and upload trials

A bounded, reentrant-safe, thread-local packed-vertex cache passes the native
API fixture in both browsers. A fresh original-allocation Firefox control
presents 947 images in 20.008 seconds (47.33/s); the cache candidate presents
914 in 20.015 seconds (45.67/s). Maximum intervals are 52.68 and 66.00 ms,
respectively, with actual audio underruns in both. The cache is not selected.
These naturally varying partial-race windows are not deterministic replay.

Three further JavaScript transport trials preserve that control's Wasm:

| Private transport | Firefox images/s | Maximum interval | Actual underrun frames at 48 kHz |
| --- | ---: | ---: | ---: |
| Small vertex batches through a uniform buffer | 11.36 | 199.06 ms | 779,584 |
| Opaque triangles through instanced integer attributes | 43.17 | 71.54 ms | 236,704 |
| Existing vertex/index textures through an unpack buffer | 42.57 | 67.62 ms | 246,944 |

The uniform trial passes an expanded 1,065-case exact color/depth matrix in
both browsers, including its storage boundary, texture fallback, return to
uniform storage and buffer cleanup. An initial standalone run used the old
lexical constructor and is excluded; final gates require the new upload
counters. The attribute trial passes 1,063 cases, including instance order and
VAO/buffer cleanup. An incorrect instance divisor fails pixels with no GL
error, proving that the pixel oracle observes the altered data path. The
unpack trial passes the existing 1,062 cases plus binding restoration, injected
upload failure/retry and owned-buffer cleanup. All three also pass the real
runtime API fixture and legacy-path controls in both browsers.

All three ordinary-menu Firefox gameplay windows fail delivery and actual
AudioWorklet output requirements, despite logging no application errors or
warnings. The uniform trial's verified race-start screenshot is at GO/0%,
while the faster control is already near 2%; do not interpret the rates as a
matched-scene speed ratio. The source clocks remain synchronized while running
too slowly in real time. No Chromium gameplay qualification was attempted for
these rejected candidates. None of these caches or transports is selected.
A separate reverse-blend classifier observes 51,502 such batches among
168,864 sampled batches but finds no candidates under its conservative
conditions; no blend change follows from that diagnostic.

## Clock-check cleanup trial

A separate canonical rebuild removes the additional pre-eighth-packet clock
read from synchronous WebGL, retaining its deadline check after every packet.
Both browsers pass the native fixture's coalescing, expired short-queue budget
and presentation-boundary checks, alongside pixels, mips, snapshots, register
ordering, readback lifecycle and injected-error controls. The standalone Wasm
GS readback/snapshot check passes all 162 cases. The rebuilt game also passes
all 27 native keyboard/controller checks in Chromium and Firefox, with no
application errors or warnings.

Its ordinary-menu Firefox race window nevertheless presents 761 images over
20.011 seconds (38.03/s), with a 62.16 ms maximum interval and
292,192 actual underrun frames (6.087 seconds at 48 kHz).
The fresh control uses a different final Wasm/link layout and naturally varying
race scenes, so this does not isolate the timing edit's effect. It establishes
no performance benefit; the timing cleanup is reverted. The preceding source
implementation remains selected. The shared build archive is restored to the
canonical backend, with the private presenter archived separately. These trials
introduce no production renderer or hosting changes.

A separate stock-browser capability check on this Linux test host uses secure,
cross-origin-isolated pages without GPU feature flags or Firefox preferences.
Firefox 158.0.1 exposes no WebGPU API in either the window or worker. Chromium
156.0.8078.47 exposes the API but returns no adapter in either context. Earlier
WebGPU gameplay qualification used explicit GPU enablement; it does not
establish default-browser support on this host. This capability observation
does not characterize other hardware or operating systems.

## Fence-backed display readbacks

The copy presenter now submits pixel-pack-buffer readbacks before collecting
the preceding image. The FIFO retains two GL buffers, including submission
and collection in flight. An already-ready fence completes through the
callback adapter synchronously; an unfinished fence suspends the GPU API
wrapper until browser tasks observe completion. The native GS handler stays
synchronous, and its existing Asyncify exclusions are unchanged. WebGPU keeps
its preceding build and presentation path.

The expanded real-runtime fixture passes in Chromium and Firefox. Alongside
the existing exact-pixel, mip, register-order, slice-budget and error checks,
it covers odd interlaced crops, shared memory growth during an outstanding
readback, source uploads/resizes, synchronous-display and snapshot cancellation,
and alternating CPU/GPU fallback frames. It forces a native fence wait until
a browser task releases it and checks context-loss cleanup. The helper tests
also cover synchronous completion, canceled waits, driver/consumer failures,
pack-state restoration and timeout cleanup.

A same-sized, distinct-frame sequence exposed a Chromium readback-storage
warning that the preceding resize-every-frame fixture missed. Its old-storage
control passes pixels but emits 33 warnings. Refreshing GPU storage before
each reused buffer's next submission removes those warnings in the runtime
fixture. GL buffer objects and CPU scratch arrays remain reusable. The first
game controller run exercised all 27 functional cases but failed the warning
gate; that failed run is retained and is not counted as passing qualification.

Before the storage fix, two ordinary-menu Chromium race-entry windows at
1280×800/DPR 1 delivered 1,153 images in 20.002 seconds (57.64/s) and 1,150 in
20.007 seconds (57.48/s). Maximum intervals were 55.43 and 50.29 ms, and maximum
browser timer delays were 61.55 and 56.17 ms. Firefox delivered 795 images in
20.003 seconds (39.74/s), with a 63.78 ms maximum presentation interval and
65.28 ms maximum timer delay. All three windows exhausted audio. The canonical
pre-storage-fix Wasm matches these private game builds exactly; JavaScript
differs only in output-directory references.

The warning-fixed canonical game then delivered 1,035 images in 20.009 seconds
in Chromium (51.73/s), with a 74.03 ms maximum presentation interval and a
76.61 ms maximum timer delay. Firefox delivered 893 images in 20.002 seconds
(44.65/s), with a 54.24 ms maximum presentation interval and a 67.54 ms maximum
timer delay. Both exhausted audio; neither game run logged application errors
or warnings. These later windows supersede the earlier 57/s Chromium trials
for the selected implementation; the earlier rate is not its qualification.
Race scenes vary naturally, so these are bounded observations, not matched
deterministic throughput claims. The final canonical game passes all 27
keyboard/simulated standard-controller checks in both Chromium and Firefox,
including disconnect/reconnect, two-controller reorder, analog pressure,
actual hidden-tab suspension and held-input restoration before native resume.
Both controller sessions report zero application errors and warnings.

These are partial-race software-submission diagnostics. They do not establish
steady 60 fps, uninterrupted audio, physical input/output latency or completed
race/game qualification. A separate synchronous-function exclusion trial
passed the rendering fixture but delivered 46.67/s in ordinary Chromium
race entry versus the preceding canonical 48.04/s; it remains unselected.

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
