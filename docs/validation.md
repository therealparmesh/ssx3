# Validation scope

The source was tested on a Linux desktop with an AMD Ryzen 7 8745HS / Radeon 780M, a 60 Hz display and a 1280×800 CSS browser viewport. Firefox 158.0.1 used `dom.webgpu.enabled=true`. Chromium 156 used the runner's Vulkan/WebGPU flags. Browser runners use isolated profiles and local test cards.

Prior full Snow Jam runs on this runtime line measured approximately 60 fresh browser submissions/second over about 341 seconds, with no missed or overwritten submissions. Firefox's worklet produced 16,362,496 stereo frames in its full-course run without underruns. The final startup/control revision repeated a 61.150-second segment at 60.000 submissions/second, with no misses, queue drops or audio underruns and a 256 MiB Wasm heap.

These counters measure work submitted before paint, not physical display scanout. The presentation queue trades about 33–50 ms of buffering for stable delivery. Restoring original decorative lens effects caused isolated misses in a desktop copy-path test; Performance remains the default.

The startup/control revision passed:

- Nine native checks covering disc-cache reservation, code-generation transitions/VU warmup, runtime behavior, SPU2 audio, IPU streaming and optional visual/startup hooks.
- Thirteen Firefox functional checks on each build: keyboard/controller assignment, both sticks, opposing directions, Start/fullscreen separation, Escape pause/resume, resizing, refresh, card persistence/import, runtime/device recovery, both startup modes and failed-save protection.
- Chromium input/storage checks and seven touch viewports, including scroll access to all settings at 568×260.
- Cold boots with quick start, the original-intro override and an existing career card. Quick start reaches the title; Enter opens Main Menu and Space selects the first mode.
- A 32.067-second original-intro test at 59.999 submissions/second with zero missed frames or underruns across 1,540,608 stereo worklet frames.

The game still requires initialization and disc loading; skipping the opening is not a saved-state restore. Required memory-card/profile choices remain interactive. Hosted cold-boot tests must wait for rendered UI rather than absolute guest-frame counts, which can advance rapidly while network loading is pending.

Real phones, physical controllers, Bluetooth routing, physical A/V synchronization, exhaustive cutscene coverage and the whole game remain unqualified.

## Latest split-screen check, October 25

The current compatibility build was cold-booted locally in a normal Firefox window on the desktop above, with no card or save-state fixture. Its Wasm/JavaScript/data hashes match the version-31 release manifest. Two simulated standard controllers independently selected Zoe and Moby. The session started from the R&B menu selection; automated jump/grab/confirmation inputs subsequently advanced into Snow Jam. Snow Jam gameplay and its two-player results were verified visually: Player 1 finished in 4:15 and Player 2 in 4:24.

Two measured windows of 300.083 and 120.083 seconds totalled 25,210 refresh intervals over 420.165 seconds, approximately 60.000 fresh submissions/second. They had zero missed/overwritten submissions, zero animation gaps above 25 ms and a 17.48 ms maximum gap. The actual 48 kHz worklet produced 20,170,240 stereo frames without underruns. The heap held at 307.25 MiB and the presentation pool at three records. There were no application errors.

The first window mixes loading, menu confirmations and split-screen gameplay. Inputs were released before the separate finish window, which reached the results screen. Screenshots and the gap between windows are excluded; these are not 420 seconds of continuous racing. The pool counter installed before menu navigation accumulated 64 producer replacements before it was reset, so that unscoped count cannot establish when they occurred. After resetting it, the finish window recorded zero producer replacements or pool underflows, with at least 52.67 ms of audio queued before each measured quantum. This local streaming check does not qualify mobile hardware, hosted network conditions or physical scanout.

A follow-up cold boot kept the entire R&B Slopestyle event in one 331.034-second measurement, including loading and its results tail. Queue counters were reset at the start and active only during measurement; one-second health samples were retained and no screenshots were taken inside the window. Different jump/grab inputs ran for each controller only between seconds 20 and 90, preventing automatic confirmation at the end. The actual R&B results showed Player 2 winning with 17,901 points and the unattended Player 1 marked DNF. All 19,862 measured refresh intervals had fresh submissions, approximately 60.000/second, with zero missed/overwritten submissions, zero gaps above 25 ms, a 17.28 ms maximum gap and no application errors. The worklet produced 15,890,944 stereo frames with zero underruns and at least 38.67 ms queued; the heap held at 307.25 MiB after loading. One queued producer image was replaced at 22.706 seconds, with no pool underflow or presentation miss. This verifies stable displayed cadence through the event; it does not establish zero producer-image replacement, two successful rider finishes, physical scanout or full-game coverage. No runtime change was made.

## Later-peak texture streaming and runtime VU compilation

Broader testing reached Peak 2's Intimidator through the game's normal single-event menus in a disposable no-card profile, using the built-in peak-unlock code only for course access. A cold version-31 run recorded 53 refreshes without a fresh image over 330.900 seconds, a worst one-second sample of 47.008 submissions/second, and 44,256 missing stereo worklet frames. The player completed the event. A warm replay and a separate profiled cold run did not reproduce that cluster, so these were not deterministic before/after trials.

A diagnostic CPU profile exposed repeated copying inside deferred PATH3 delivery: each released texture packet allocated a temporary vector and shifted the entire remaining queue. Delivery now advances a read cursor, occasionally compacts consumed storage on append, and clears an exhausted queue. Packet boundaries, interleaved PATH1 writes and version-5 snapshot contents retain their existing behavior. Native checks exercise direct and queued delivery, appending before/after compaction, payload ownership after source reuse, partial-queue snapshot restoration and reset.

The expanded event also exposed a separate VU compiler failure: optimized builds rename raw Wasm exports, so constructing dynamic import names against `wasmExports` produced an undefined helper and a link error. The compiler now uses the public KEEPALIVE bindings on `Module`. An asset-free test reproduces the old link failure and verifies compilation, helper imports, integer arithmetic and end-delay memory writes on both the host and a pthread worker. GitHub Actions runs it using the pinned Emscripten SDK.

The final revision was cold-booted again in a fresh Firefox profile with both fixes. One uninterrupted 400.167-second measurement began by confirming the visually verified Intimidator briefing and included the countdown, complete race and results tail. Zoe finished sixth in 4:56; no automated inputs ran after the initial confirmation. All 24,010 measured refreshes received a fresh image: 59.999929 submissions/second, zero missed/overwritten refreshes, zero animation gaps above 25 ms and a 17.34 ms maximum gap. The worklet produced 19,209,728 stereo frames with zero underruns and a 40.67 ms minimum queue. The VU interpreter counter remained zero, and no console errors or warnings were recorded. The heap held at 307.25 MiB after growth, with a three-record presentation pool. One queued producer image was replaced 5.299 seconds into the event without a pool underflow or missed refresh. This is a desktop result for that event and opponent set, including its results tail; it does not qualify every course, physical display scanout, real phones or physical controllers. No profiler, build or upload ran during measurement.

Hosted checks on both release variants verified exact asset selection, cross-origin isolation, creation of the one-shot compiler worker, exclusive memory-card ownership, second-tab rejection, actual frame presentation and acknowledged pause/resume without console warnings or errors. These used headless Chromium's copy presentation path and cover startup behavior, not hosted race cadence or physical scanout. Both identity and gzip forms of all twelve runtime assets were verified against the release manifests before deployment; prior-release fallback remains available.

## Repeatable checks

Follow the README for asset-free native checks. Browser scripts use these common environment variables:

- `SSX3_TEST_URL`: URL of the locally served build.
- `SSX3_TEST_OUTPUT`: output folder for screenshots/results, preferably outside source.
- `PLAYWRIGHT_MODULE` / `CHROMIUM_EXECUTABLE`: Playwright and Chromium paths for the Chromium scripts.
- `PUPPETEER_MODULE` / `FIREFOX_EXECUTABLE`: Puppeteer Core and Firefox paths for the Firefox scripts.
- `SSX3_FIREFOX_WEBGPU=1`: enable the Firefox Linux test-profile preference.
- `SSX3_TEST_CARD`: a local exported `.ps2` card for `test_browser_firefox.cjs`.
- `SSX3_TEST_STATE`: a locally captured race/menu fixture for scripts that accept it. The Firefox functional runner expects `test.state` in the served directory.

Fixtures contain game data and are intentionally absent. Generate them locally with the native runner's `--save-state frame:file`; choose a frame limit greater than the save frame. Native `--load-state` replays them. Browser performance checks need a calibrated 60 Hz environment and one active game browser, with no builds, uploads or profilers running concurrently.

`scripts/test_browser_media.cjs` cold-boots through the original opening with `?intro=1` and samples actual stereo AudioWorklet quanta. `SSX3_TEST_END_FRAME=18000` extends its default window. It checks measured cadence, digital clock agreement and pause/audio interruption recovery; it does not qualify physical audio latency.

A fresh asset-free build of this publication snapshot passed all nine native checks and the JavaScript disc-fetch/presentation checks. The first [GitHub Actions source run](https://github.com/therealparmesh/ssx3/actions/runs/40199851623) also passed all nine native checks and both JavaScript checks on a clean Ubuntu 24.04 runner using Clang 18/libc++.
