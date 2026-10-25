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

## Primary Chromium Peak 3 check

The version-32 primary JSPI build was cold-booted in a fresh, visible Chromium 156.0.8078.47 window at 1280×800 on the desktop above. All three runtime asset hashes matched the deployed primary release. This browser selected the GPU frame-copy presentation path. No memory card or save-state fixture was used; the built-in peak unlock enabled course access without qualifying career progression.

A continuous 420.916-second window began at the visually verified Gravitude briefing on Peak 3, covering its countdown, full race and results tail. Simulated standard-controller jump/grab inputs ran only from seconds 20 to 90; the rider finished sixth in 3:57. All 25,256 measured refreshes received a fresh image, approximately 60.002 submissions/second, with zero missed/overwritten submissions, zero animation gaps above 25 ms and a 16.67 ms maximum gap. The three-record copy presentation pool recorded zero underflows or producer replacements. The actual 48 kHz worklet produced 20,206,080 stereo frames without underruns, with at least 34.67 ms queued. The heap held at 307.25 MiB after growth. The VU interpreter counter remained zero and no application errors or warnings were recorded. No build, upload or profiler ran during the window; screenshots were taken before and after it.

This adds current primary-build and Peak 3 event coverage. The timed window includes the results tail and measures browser submissions, not physical scanout. It does not qualify other hardware, every event, physical controllers or real phones. Agent device access was still disabled when this check was run. No runtime change was made for this check.

## Hosted HTTPS race check

The private version-32 primary release was also tested directly from its deployed HTTPS origin in a fresh, visible Chromium context on the same desktop. The normal game worker and disc reader fetched from the hosted service; no local server or save-state fixture supplied the game. Owner-authorized test headers were scoped to that origin, including worker requests. The browser selected its GPU frame-copy path. An initial test-setup attempt using page-only authentication timed out before Play became available and produced no race measurement; the working context-wide setup is the one reported here.

A continuous 421.083-second window began at the visually verified Gravitude briefing and covered countdown, racing and the results tail. Jump/grab inputs ran only during seconds 20–90. Zoe finished sixth in 4:02. All 25,266 measured refreshes received fresh submissions, approximately 60.002/second. There were zero missed/overwritten refreshes, zero callback gaps above 25 ms, a 16.67 ms maximum gap, zero presentation-pool underflows/replacements and no console warnings or errors. The worklet produced 20,213,248 stereo frames without underruns, with at least 48 ms queued. Its elapsed clock differed from the emulated frame clock by about 7.3 ms; this is digital clock agreement, not physical A/V synchronization. The heap held at 307.25 MiB and the VU interpreter counter remained zero.

During measurement, 78 HTTP Range reads completed successfully with status 206, transferring 19.5 MiB. Observed fetch durations ranged from 120.04 to 985.32 ms, with a 193.11 ms median. These timings include the actual hosted route and authenticated test setup; they do not establish performance for other network conditions. No builds, uploads, profiler or screenshot capture ran inside the window.

To check for repeated content as well as fresh submissions, the test sampled a 16×12 grid from each copy-presenter ImageData already available on the CPU, without adding GPU readbacks. During seconds 10–210, all 12,000 sampled image signatures differed from the signature two images earlier, including the check for a repeating two-field pattern. This is a sampled content check over that gameplay interval, not exhaustive pixel comparison or physical scanout verification. No runtime or hosting change was required for this test. Real phones, physical controllers and broader game progression remain unqualified.

## Hosted fresh-career save and reload

The version-32 primary release was tested on the same desktop in an isolated, visible Chromium context at 1280×800, directly from its private HTTPS origin. This session used the default inserted memory card, initially unformatted, with no existing card file, imported fixture, save state or unlock code. Normal keyboard and simulated standard-controller inputs entered Conquer The Mountain as Zoe. The game's Save game flow formatted the card and created `PLAYER1` in slot 1, ending with its own **Save complete** acknowledgement.

The 8,650,752-byte card was exported through the player's actual export handler. After the normal player reload, the card restored from browser storage had the identical SHA-256 before Play was pressed. The game's Load game screen recognized `PLAYER1`, completed the load, and returned to a playable Zoe career on the mountain. A subsequent save to the same slot exercised the game's overwrite confirmation and produced **Save complete** again. Its card hash changed, and a second export/reload restored that updated hash exactly. These checks used real game writes rather than JavaScript-created save markers.

Four separately scoped measurements covered the operations below. The windows include menu/acknowledgement tails; they are not continuous racing. Screenshots, hashing, exports and reloads occurred outside the measured windows.

| Window | Seconds | Fresh refreshes | Missed refreshes | Audio underruns |
| --- | ---: | ---: | ---: | ---: |
| First format and save | 45.232 | 2,714 | 0 | 0 |
| Confirmed card load | 25.199 | 1,512 | 0 | 0 |
| Enter restored career | 40.215 | 2,413 | 0 | 0 |
| Overwrite existing slot | 30.199 | 1,812 | 0 | 0 |

Each window measured approximately 60.002 fresh browser submissions/second, a 16.67 ms maximum callback gap, zero overwritten submissions, zero presentation-pool underflows/replacements and no application warnings or errors. The actual 48 kHz worklet produced 6,765,056 stereo frames across these windows with zero underruns and at least 44 ms queued. The format/first-save window contained three native save notifications and three successful browser-storage commits; the overwrite window contained one of each. Storage commits took 27.37–28.44 ms without a measured refresh miss. Revisions matched after saving, the native pending flag cleared, and the player displayed **Saved on this device**.

This qualifies fresh-card formatting, one career slot, loading and overwriting on this hosted desktop path. It does not qualify every career event, all six slots, browser-storage durability after OS eviction, physical display/audio timing or real phones. No runtime or hosting change was needed.

## Hosted Firefox career and card portability

The private version-32 compatibility release was tested directly over HTTPS in visible Firefox 158.0.1 on the desktop above, with WebGPU enabled, a 1280×800 CSS viewport, device pixel ratio 2 and the buffered GPU-surface presenter. The normal import confirmation/reload flow restored the actual Chromium-exported career card byte-for-byte before Play. The game recognized `PLAYER1`, completed the load, and ran Zoe's career without an unlock code or save-state fixture. Setup included free riding, transport and menu navigation in the same context; the measured qualifier was not a cold course/cache test. Two earlier test-runner navigation waits timed out after the app reached Ready; correcting the runner's incomplete BiDi network-event subscription resolved those setup failures.

A continuous 400.099-second measurement started at Snow Jam's race staging sequence and included the complete qualifier and results tail. Scripted jump/grab inputs ran during seconds 10–150 and boost during seconds 10–270. Zoe finished sixth in 4:34 and did not advance to the semifinal. All 24,006 refreshes received fresh submissions, approximately 60.000114/second, with zero missed/overwritten submissions, zero callback gaps above 25 ms and a 17.52 ms maximum gap. The three-record presentation pool had zero underflows or producer replacements. The 48 kHz worklet produced 19,206,656 stereo frames with zero underruns, no full-scale samples and at least 64 ms queued. The heap held at 307.25 MiB and the VU interpreter counter remained zero. During measurement, 100 HTTP Range reads returned 206 and transferred 25 MiB; observed fetch durations ranged from 107.10 to 1,790.32 ms, with a 193.64 ms median. No build, upload, profiler or screenshot ran inside the window.

A separate 60.117-second career-entry window also had fresh submissions at every refresh and no audio underruns. After the qualifier, further normal menu/transport navigation returned to free riding. The in-game Save game flow overwrote `PLAYER1` and acknowledged **Save complete**. Its separately measured 30.234-second window covered 1,814 refreshes with zero misses, overwritten submissions, pool underflows/replacements or audio underruns. Both native save notifications and both successful browser-storage commits occurred inside this window; storage commits took 69.40 and 49.88 ms. The native pending flag cleared, stored/current revisions matched, and the player displayed **Saved on this device**. The actual Firefox export button downloaded the updated 8,650,752-byte card. After normal player reload, its restored hash matched that download exactly and differed from the imported card. The game's Load game flow accepted the updated profile and displayed **Load complete** again.

Firefox logged rejected `__cf_bm` cookies with an invalid-domain warning. Read-only response probes confirmed that the hosted `/health` and `/disc.iso` responses attach this Cloudflare cookie with `Domain=chatgpt.site`; the game's worker does not set it. These hosting-response warnings remain recorded rather than being counted as a clean browser console. No other application errors or warnings were observed through the final reload/load check. No runtime or hosting change was made.

This adds hosted Firefox streaming, one completed career qualifier, cross-browser card import and Firefox save/export/reload coverage. It does not establish advancement through later rounds, winning/medal progression, whole-game completion, physical scanout, real-phone performance or physical-controller qualification. Device access remained disabled.

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
