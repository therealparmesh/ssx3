# Validation scope

The source was tested on a Linux desktop with an AMD Ryzen 7 8745HS / Radeon 780M, a 60 Hz display and a 1280×800 CSS browser viewport. Firefox 158.0.1 used `dom.webgpu.enabled=true`. Chromium 156 used the runner's Vulkan/WebGPU flags. Browser runners use isolated profiles and local test cards.

Prior full Snow Jam runs on this runtime line measured approximately 60 fresh browser submissions/second over about 341 seconds, with no missed or overwritten submissions. Firefox's worklet produced 16,362,496 stereo frames in its full-course run without underruns. The final startup/control revision repeated a 61.150-second segment at 60.000 submissions/second, with no misses, queue drops or audio underruns and a 256 MiB Wasm heap.

These counters measure work submitted before paint, not physical display scanout. The presentation queue trades about 33–50 ms of buffering for stable delivery. Restoring original decorative lens effects caused isolated misses in a desktop copy-path test; Performance remains the default.

The final revision passed:

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
