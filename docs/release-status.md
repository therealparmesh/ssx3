# Release status

As of 2026-10-29, saved version 61 is running on the owner-private hosted site. Its four normal desktop race/results windows passed the existing timing, image and audio gates. Full production sign-off remains open; phones, physical controllers/audio and full-game progression are not qualified.

The application runtime is source `25d915e04964bdcb3dbbbb21c7e8b0c2d54d1f3c`; the hosting source is `a4869d4ce198b558b0a85420aa744f8c1f986d5f`. The immutable desktop asset release is `97ea17232a6f2831fd209bbef0a4c465569ad7285742b1910180db1769e272e6`. Version 56 remains available for rollback. Game assets and private access credentials are excluded from this repository.

## Desktop release checks

Each window followed cold startup, memory-card import through the player UI and ordinary Single Event menus/default rules into a Snow Jam race and results. Headed Chromium 156 and Firefox 158.0.1 ran separately on the same Linux desktop at 60 Hz, 1280×800 CSS pixels and DPR 1. Linux WebGPU enablement was explicit. Simulated standard gamepad input drove the race; keyboard input navigated menus. This does not qualify physical controllers. GPU timestamps, per-frame completion requests, screen capture and profiling were disabled during these normal timed windows.

| Window | Seconds | Fresh submissions/s | Worst submission interval, ms | Missing images | Missing stereo frames |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium staged | 300.626 | 60.002456 | 19.785 | 0 | 0 |
| Firefox staged | 300.878 | 60.000032 | 19.280 | 0 | 0 |
| Chromium live | 300.645 | 60.002394 | 20.675 | 0 | 0 |
| Firefox live | 300.855 | 60.000007 | 18.860 | 0 | 0 |

All four also had zero overwritten images, presentation-pool underflows, producer replacements or application errors. Native/audio clock differences stayed within the existing 50-ms bound. Both actual live application documents matched the staged candidate exactly, allowing only the previously verified hosting-script template. The live checks used actual server documents and immutable assets, with no response substitution. Every existing acceptance gate, including the 25-ms submission-interval gate, remained unchanged.

Before these windows, a historical test browser was found actively emulating another game instance and was closed. Its influence on previous timing outliers is unknown. The earlier failed runs remain recorded; these passes do not establish their cause or guarantee universal absence of stalls. Future performance checks must verify that other historical game-test instances are stopped, close their own browser in cleanup, and keep builds/profiling/capture outside measurement.

## Live controller transport and tab recovery

The deployed version also passed eleven native-worker input checkpoints in each of Chromium and Firefox. Actual keyboard events and simulated standard controller snapshots traversed the production page/worker bridge into the real native input exports. The observer forwarded each native call successfully before recording it. Both browsers verified analogue trigger pressure, stable player-two ownership when player one disconnects, player-one keyboard fallback, reconnecting at a different browser index/reordered snapshot, temporary controller-access denial/recovery, and both controllers disconnected. A real tab switch released native input and paused the runtime; returning required a fresh Resume action, with held buttons, sticks and pressure restored before native unpause. Guest frames advanced afterward, and final pause was acknowledged. There were no application errors.

The first Firefox driver attempt rejected the keyboard API name `Space` before testing that input. Using its supported literal-space spelling corrected the driver; the clean complete run is the recorded result. This was not a player failure. The probes changed no application assets or game state and made no performance claim. Synthetic controllers do not qualify physical devices, vibration, USB/Bluetooth mappings or latency.

## Separate GPU diagnostic

An opt-in Chromium diagnostic on the same application completed 180.435 seconds at 60.002658 submissions/s, with no image/audio loss or application errors. All 10,826 GPU completion requests completed; none were rejected/skipped, no RAF stamps were unknown and no clock errors occurred. At most two requests were outstanding. Maximum completion-notification lag was 16.965 ms after submit and 18.560 ms after RAF; maximum CPU submission interval was 19.470 ms. No natural late event reproduced.

Runtime frame/time/pool counters were frozen before awaiting presenter completion. Presenter audio/visual counters were frozen before GPU settlement. A controlled five-second delayed settlement verified that neither counter snapshot included that wait. Actual settlement took 0.055 ms. Completion requests can alter GPU progress, and notification lag includes scheduling delay: it is neither GPU execution time nor physical presentation time. This diagnostic is excluded from the normal checks above.

## Remaining sign-off

- Real iPhone and Android browser compatibility, sustained performance, memory pressure, thermal behavior and touch play. Agent device access is currently unavailable; desktop viewport emulation is not device qualification.
- Physical USB/Bluetooth controller mappings, disconnect/reconnect behavior and latency, plus physical speaker/headphone/Bluetooth audio and A/V synchronization.
- Full normal progression, unlocks, medals and broader courses/modes. The recorded race windows and earlier save/recovery checks do not establish complete game coverage.
- Physical display delivery and historical rare timing events. CPU submissions, completion notifications and screenshots alone do not prove physical scanout timing.

See [validation scope](validation.md) for the individual fixes, controlled fault tests, earlier rejected candidates and measurement limitations. These results are bounded desktop evidence, not a bug-free or universal 60-fps guarantee.
