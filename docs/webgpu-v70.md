# WebGPU desktop release v70

Release date: 2026-10-31. Tag: `webgpu-v70`.

This release selects the WebGPU desktop worker player already deployed as private
hosted version 70. It includes keyboard and standard browser gamepad input,
stereo audio, startup skipping, pause/resume, memory-card import/export and
browser persistence. The tag contains source, build tooling and regression
tests. Supply your own supported USA disc; generated game binaries, disc data
and memory cards are excluded.

## Supported target and checks

The qualified configuration is Linux desktop, headed Chromium 156 and Firefox
158, a hardware WebGPU adapter, shared memory and cross-origin isolation.
Timing checks used 1280×800 CSS pixels, DPR 1 and calibrated 120 Hz. Linux browser
WebGPU overrides are documented in the README. This release does not establish
support for browsers/platforms without WebGPU.

Separate hosted five-minute Gravitude race/results windows passed the unchanged
25 ms maximum submission interval, zero image/audio loss and 50 ms source-audio
clock checks. Chromium measured 60.002494 submissions/s and a 21.47 ms maximum;
Firefox measured 60.000035 and 19.20 ms. Both also passed 27 native-worker
keyboard/gamepad checkpoints and separate audio/pause/resume checks. Controller
automation uses the browser Gamepad API with simulated standard pads.

Source commit `7e6e6030ce9a26e89b105db58d6b13fa2c27e40a` passed
[source CI](https://github.com/therealparmesh/ssx3/actions/runs/41223418670).
Its GPU color/fade fixture additionally passed headed Chromium and Firefox in
normal, staged-upload and scale-2 modes. This release checkpoint only adds
documentation; runtime, native game build and hosted assets are unchanged.
See [release status](release-status.md) for the exact deployed hashes and
individual qualifications, including retained earlier failures.

A subsequent hosted Chromium freeride check entered The Throne through ordinary
menus, skipped its opening cinematic, descended through the ice canyon and trees,
and reached terrain with station signs. Five health/audio windows totalled
270.428 seconds, separated by acknowledged pauses for screenshots. They consumed
12,980,736 stereo PCM frames with zero missing or full-scale samples, no
application errors/warnings, and constant 322,174,976-byte Wasm memory after
loading. Collisions, recovery and steering corrections are retained. This is
sustained route coverage, not a new per-frame timing qualification or proof of a
complete mountain descent. The sourced QA career was imported through the UI;
its unlock provenance is unverified, and no earned unlock or saved reward is
claimed. The final card remained byte-identical to the imported card.

## Delivery and limits

The owner-private hosted player is the playable deployment. This GitHub release
does not change its audience or include a downloadable game bundle. Local builds
use the pinned SDK and the instructions in [building](building.md).

The bounded desktop checks support shipping this target. Full normal career
progression and every course/mode remain unverified. Physical controller latency,
speaker/headphone delivery and display scanout are unqualified. Phone testing was
explicitly removed from the release gate. These results do not guarantee zero
bugs or a minimum 60 fps on every machine.

WebGL and Fire TV packaging are subsequent work. They are not part of this tag
and cannot replace the WebGPU player until independently qualified.
