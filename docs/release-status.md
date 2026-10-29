# Release status

As of 2026-10-29, saved version 62 is running on the owner-private hosted site. Its four normal desktop race/results windows passed the existing timing, image and audio gates. Full production sign-off remains open; phones, physical controllers/audio and full-game progression are not qualified.

The desktop player uses source `4d26bf93c414b54a7de3e1397f8c7212eb488dcd`; the hosting source is `d81c95b62bf395a2627c01da32f5f2f8aca4435b`. The immutable desktop asset release is `97ea17232a6f2831fd209bbef0a4c465569ad7285742b1910180db1769e272e6`. Version 61 remains available for rollback. Game assets and private access credentials are excluded from this repository.

## Pause acknowledgement and focus recovery

Version62 fixes a reproduced native ordering exposure in version61: an ordinary widget pause sent both neutral controller states while the emulation worker was still running, before its native pause call. No delay was injected. This proves the ordering defect, not a particular guest jump/crash or the cause of earlier timing outliers. A normal Crow's Nest heat was reached during the investigation, but no medal or unlock was earned.

The player now requests pause before clearing local keyboard/touch state and sends neutral native input only after actual pause acknowledgement. The existing UI polling path retires that release; rapid Resume waits for acknowledgement, restores current input, then wakes the guest. Window focus loss also pauses first, because Firefox's active-tab-switch check exposed an earlier blur-driven release in the rejected widget-only candidate. Focus return requires a fresh Resume action. Hidden tabs can defer neutral delivery until visible while the guest remains stopped; stale resume work cannot clear later active input.

Thirty source pause/resume scenarios and all22 JavaScript suites passed. Four negative controls rejected the preceding shell, a reorder-only change, missing acknowledgement gating and the widget-only focus fix. Each staged browser passed14 actual-native checkpoints, including ordinary pause, temporarily withheld client acknowledgement, rapid Resume, real active-to-hidden switching, cancellation, held-input restoration and controlled terminal failure. Withholding the page readiness getter delays client knowledge, not the underlying native pause; native calls/readiness were observed independently on the real worker. The rebuilt native binary, linked JavaScript and seven worker helpers stayed byte-identical. The normal staged and actual-live checks below also passed with these diagnostic hooks removed.

## Desktop release checks

Each window followed cold startup, memory-card import through the player UI and ordinary Single Event menus/default rules into a Snow Jam race and results. Headed Chromium 156 and Firefox 158.0.1 ran separately on the same Linux desktop at 60 Hz, 1280×800 CSS pixels and DPR 1. Linux WebGPU enablement was explicit. Simulated standard gamepad input drove the race; keyboard input navigated menus. This does not qualify physical controllers. GPU timestamps, per-frame completion requests, screen capture and profiling were disabled during these normal timed windows.

| Window | Seconds | Fresh submissions/s | Worst submission interval, ms | Missing images | Missing stereo frames |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium staged | 300.632 | 60.002445 | 21.925 | 0 | 0 |
| Firefox staged | 300.806 | 60.000039 | 19.800 | 0 | 0 |
| Chromium live | 300.628 | 60.002371 | 22.985 | 0 | 0 |
| Firefox live | 300.831 | 60.000081 | 19.680 | 0 | 0 |

All four also had zero overwritten images, presentation-pool underflows, producer replacements or application errors. Native/audio clock differences stayed within the existing 50-ms bound. Both actual live application documents matched the staged candidate exactly, allowing only the previously verified hosting-script template. The live checks used actual server documents and immutable assets, with no response substitution. Every existing acceptance gate, including the 25-ms submission-interval gate, remained unchanged.

An earlier qualification found a historical test browser actively emulating another game instance and closed it. Its influence on previous timing outliers is unknown. The earlier failed runs remain recorded; these passes do not establish their cause or guarantee universal absence of stalls. Future performance checks must verify that other historical game-test instances are stopped, close their own browser in cleanup, and keep builds/profiling/capture outside measurement.

## Live controller transport and tab recovery

The preceding version61 also passed eleven native-worker input checkpoints in each of Chromium and Firefox. Actual keyboard events and simulated standard controller snapshots traversed the production page/worker bridge into the real native input exports. The observer forwarded each native call successfully before recording it. Both browsers verified analogue trigger pressure, stable player-two ownership when player one disconnects, player-one keyboard fallback, reconnecting at a different browser index/reordered snapshot, temporary controller-access denial/recovery, and both controllers disconnected. A real tab switch released native input and paused the runtime; returning required a fresh Resume action, with held buttons, sticks and pressure restored before native unpause. Guest frames advanced afterward, and final pause was acknowledged. There were no application errors.

The first Firefox driver attempt rejected the keyboard API name `Space` before testing that input. Using its supported literal-space spelling corrected the driver; the clean complete run is the recorded result. This was not a player failure. The probes changed no application assets or game state and made no performance claim. Synthetic controllers do not qualify physical devices, vibration, USB/Bluetooth mappings or latency.

## Ordinary career save and cross-browser restoration

The preceding live version61 Chromium player loaded a previously game-created `PLAYER1` career through the normal menus. An in-game acceleration purchase changed 1.0 to 1.2 and cash from $508 to $258. Before Save Game, the worker's card still matched the imported original. The game then showed Save complete, both browser-storage revisions completed, and the actual Export card download matched the worker's 8,650,752 bytes. A full page reload restored those exact bytes; loading the career again visibly restored acceleration 1.2 and cash $258. Ordinary free ride then advanced and earned additional trick cash.

Firefox imported that actual Chromium export through the UI, loaded the career and showed acceleration 1.2/cash $258. A normal speed purchase changed 1.0 to 1.2, leaving $8. Save complete, the browser-storage commit, a matching real card export and byte-exact restoration after a full reload all passed. Loading the career again showed acceleration 1.2, speed 1.2 and cash $8. The byte checks were derived from the actual downloads, asynchronous worker card reads and reloaded cards; rendered screenshots supplied the separate visual value checks.

Both players finished paused and their test browsers closed, with no application errors or application warnings. Firefox also emitted the known hosting `__cf_bm` cookie-domain warning, recorded separately. No application assets, native save-state fixtures, game memory or card bytes were edited by the driver; purchases and saves used ordinary in-game controls. These functional checks add career persistence and cross-browser evidence, not a new performance window, event medals/unlocks, complete progression or physical-device qualification. A final Firefox image named free-ride actually showed a lodge Save progress prompt and is excluded from free-ride evidence.

## Current career qualifier and return flow

On live version62, Chromium imported the actual Firefox-exported career card through the player UI and loaded `PLAYER1` using the normal game menus. Free ride showed the saved $8 balance. Transport entered Peak1's Crow's Nest Big Air event. Both qualifiers completed: Zoe scored 3,100 and 2,000, and the final standings correctly carried a combined 5,100 into sixth place. The game rejected advancement because the top three qualify. Transport then returned to Select Peak, where Peaks2/3 remained locked, and the Peak1 Freeride destinations opened normally.

The run used ordinary keyboard events and simulated standard gamepad snapshots through production input polling, with player pauses between observations. It used no native save-state fixture, game-memory edits, altered rules or fabricated scores. There were no application errors or warnings. No in-game save was performed, and the final worker card still matched the imported 8,650,752-byte card exactly. The browser finished with native pause acknowledged and was closed. This checks the unsuccessful qualification/results/return path; it does not verify a medal, unlock, newly earned progress persistence, Firefox event progression or a new performance window.

## Separate GPU diagnostic

An opt-in Chromium diagnostic on preceding source `25d915e` completed 180.435 seconds at 60.002658 submissions/s, with no image/audio loss or application errors. All 10,826 GPU completion requests completed; none were rejected/skipped, no RAF stamps were unknown and no clock errors occurred. At most two requests were outstanding. Maximum completion-notification lag was 16.965 ms after submit and 18.560 ms after RAF; maximum CPU submission interval was 19.470 ms. No natural late event reproduced.

Runtime frame/time/pool counters were frozen before awaiting presenter completion. Presenter audio/visual counters were frozen before GPU settlement. A controlled five-second delayed settlement verified that neither counter snapshot included that wait. Actual settlement took 0.055 ms. Completion requests can alter GPU progress, and notification lag includes scheduling delay: it is neither GPU execution time nor physical presentation time. This diagnostic is excluded from the normal checks above.

## Remaining sign-off

- Real iPhone and Android browser compatibility, sustained performance, memory pressure, thermal behavior and touch play. Agent device access is currently unavailable; desktop viewport emulation is not device qualification.
- Physical USB/Bluetooth controller mappings, disconnect/reconnect behavior and latency, plus physical speaker/headphone/Bluetooth audio and A/V synchronization.
- Full normal progression, unlocks, medals and broader courses/modes. The recorded race windows and earlier save/recovery checks do not establish complete game coverage.
- Physical display delivery and historical rare timing events. CPU submissions, completion notifications and screenshots alone do not prove physical scanout timing.

See [validation scope](validation.md) for the individual fixes, controlled fault tests, earlier rejected candidates and measurement limitations. These results are bounded desktop evidence, not a bug-free or universal 60-fps guarantee.
