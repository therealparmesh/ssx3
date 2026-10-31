# Building SSX 3

The wrapper accepts an ISO or a completed ZIP/7z archive containing one. It extracts the boot executable, verifies the supported USA revision, explores indirect entry points and vector programs, and builds native and browser runners. The browser translation is generated separately with `--no-tail-calls`, including the same startup/effects gates and recorded vector programs. Game files, generated translations, captures and build output remain under ignored directories.

```sh
bash scripts/build_ssx3.sh "/path/to/SSX 3 (USA).iso"
```

`--frames`, `--rounds` and `--press` are forwarded to `scripts/port.sh` to control exploration. `--no-explore` reuses existing entry/vector discoveries when rebuilding. Native SDL window support needs SDL2 development headers.

The default player is `build/web-ssx3-asyncify-worker/ps2web.html`. Serve it with:

```sh
python3 scripts/serve.py build/web-ssx3-asyncify-worker games/ssx3/disc.iso 8620
```

`scripts/build_web.sh ssx3` rebuilds this player after the wrapper has generated its code. `scripts/play_ssx3.sh` starts the same server at port 8620 by default. `scripts/host_ssx3.sh` optionally installs a local Linux user service with all required worker helpers; it is not needed for ordinary local play. These scripts share variant selection. Set `PS2_WEB_ASYNC=jspi` for the preceding main-thread JSPI variant, or `PS2_WEB_WORKER=OFF` for main-thread Asyncify. Rebuild and play with the same overrides. Generic games retain their preceding JSPI default.

## Main-thread Asyncify variant

The wrapper already generates the Asyncify translation for the default worker. For a diagnostic main-thread variant, complete the wrapper build so `games/ssx3/entries.txt`, vector recordings, native tools and SDK are available. The equivalent manual generation/build commands are:

```sh
build/tools/eerecomp games/ssx3/disc/SLUS_207.72 \
  --entries games/ssx3/entries.txt --no-tail-calls \
  --out generated/ssx3-asyncify
python3 scripts/optional_visuals.py generated/ssx3-asyncify 002E30D0 002E3130
python3 scripts/ssx3_startup.py generated/ssx3-asyncify
build/tools/vurecomp games/ssx3/vu1 generated/ssx3-asyncify

source tools/emsdk/emsdk_env.sh
emcmake cmake -S . -B build/web-ssx3-asyncify -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DPS2_DEVELOPER_TOOLS=OFF \
  -DPS2_WEB_ASYNC=asyncify -DPS2_WEB_WORKER=OFF \
  -DPS2_GENERATED="$PWD/generated/ssx3-asyncify" \
  -DPS2_WEB_ELF="$PWD/games/ssx3/disc/SLUS_207.72" \
  -DPS2_WEB_BOOT_FILE="$PWD/build/web-ssx3/boot.txt" \
  -DPS2_WEB_PATCHES=
cmake --build build/web-ssx3-asyncify --target ps2web --parallel 2
python3 scripts/serve.py build/web-ssx3-asyncify games/ssx3/disc.iso 8680
```

Use the original executable for both variants. The old `patches/ssx3-no-lensfx.pnach` is retained only as a legacy diagnostic; do not combine it with the selectable visual-effects build.

The local server serves the selected directory directly. Use the directory and port for the variant being tested. Separate ports are separate storage origins, so export/import a card when switching between them. Alternate variants do not inherit qualification from the default worker.

The browser host passes the selected startup/effects mode to the runtime. The native runner accepts `--fast-boot` and `--full-effects` to enable the corresponding paths.

### Dedicated game worker

This is the default SSX 3 browser configuration. The explicit command, equivalent to `scripts/build_web.sh ssx3`, is:

```sh
PS2_WEB_ASYNC=asyncify PS2_WEB_WORKER=ON bash scripts/build_web.sh ssx3
python3 scripts/serve.py build/web-ssx3-asyncify-worker games/ssx3/disc.iso 8681
```

This variant requires worker WebGPU and transferable OffscreenCanvas in addition to the shared-memory requirements. The page owns user gestures, controls and audio; the game worker owns the runtime and saved-card filesystem. The window creates a separate lightweight presentation worker with three shared pixel slots, keeping its refresh callback separate from the larger Wasm realm. A MessagePort connects it directly to the game worker, so frame data bypasses the window. This also supplies Chromium's window-owned worker animation callbacks. Both workers are explicitly released on shutdown; a renderer crash preserves the game worker for card export. Add `?presenter=direct` to select the preceding direct game-worker surface for diagnostics. Both paths use the same frame-pacing clock.

Keep all seven helper scripts listed in `ps2web-worker-assets.json` beside `ps2web.js`, `.wasm` and `.data`. The build checks their JavaScript and generates compressed copies. A deployment must include these helpers in its release identity and supply their JavaScript MIME types and isolation headers. Private QA wrappers, generated game translations and memory cards are not distributable source assets.

The split presenter submits empty GPU work only while a readback mapping is pending, to advance completion on Firefox implementations with slow completion polling. Map completion, failure and shutdown cancel pending progress polls. Desktop checks do not qualify phone GPUs or physical controllers/audio devices; see [validation](validation.md).

Normal browser play disables GPU timestamp queries; `?debug` enables them when supported. Native runs retain timing collection by default. `PS2_GPU_TIMESTAMPS=0` disables native timing collection, while an explicit `PS2_GPU_PROFILE` still requests the timestamps needed for its profile. Native environment variables are not arbitrary URL options.

## Experimental live WebGL runtime

The optional WebGL backend now implements the runtime GPU API, beyond the standalone captured-command fixtures. The default backend remains WebGPU. WebGL currently requires Asyncify, native internal resolution and the window-owned runtime (`PS2_WEB_WORKER=OFF`). Its private WebGL canvas supplies the existing copy presenter; a separate game/presentation worker is not integrated. It does not use WebGPU. GPU timing is unavailable: a zero GPU-time counter does not measure rendering cost.

Build and run the asset-free integration probe with the pinned SDK active:

```sh
python3 scripts/prepare_webgl_backend.py build/webgl-upstream
emcmake cmake -S . -B build/webgl-runtime -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DPS2_WEB_ASYNC=asyncify \
  -DPS2_GPU_BACKEND=webgl -DPS2_WEB_WORKER=OFF -DPS2_GPU_TESTS=ON \
  -DPS2_WEBGL_UPSTREAM="$PWD/build/webgl-upstream"
cmake --build build/webgl-runtime --target gpu_copy_readback --parallel 2
python3 scripts/serve.py build/webgl-runtime /dev/null 8723
```

In a second terminal, with Puppeteer Core available:

```sh
SSX3_TEST_BROWSER=chrome node scripts/test_webgl_runtime.cjs
SSX3_TEST_BROWSER=firefox node scripts/test_webgl_runtime.cjs
```

The driver withholds `navigator.gpu`, uses no GPU feature flags or Firefox preferences, and verifies 64 ordered asynchronous frames, synchronous display and nonzero-offset download, actual drawing/export, uncached local copy, native snapshot round trips, partial RGB24 transfer restoration rejection of malformed snapshots without changing VRAM, and explicit host-yield requests after synchronous rendering work. `PUPPETEER_MODULE`, `SSX3_TEST_URL`, `SSX3_TEST_OUTPUT`, `CHROMIUM_EXECUTABLE` and `FIREFOX_EXECUTABLE` select local dependencies, URLs and artifacts. CI compiles this probe; the headed hardware-browser checks run separately. The WebGL checks also inject six native GL errors at dirty/clean export, snapshot, synchronous/asynchronous display and CPU-display fallback. Failed exports and snapshots retain caller buffers, and clean retries compare exact pixels. A control that hides driver errors must fail the dirty-export assertion.

To build the game, use the compatibility configuration above with `-DPS2_GPU_BACKEND=webgl -DPS2_WEBGL_UPSTREAM="$PWD/build/webgl-upstream" -DPS2_WEB_WORKER=OFF`. Keep the locally generated game translation and game files private. Build-time selection is intentional; this is not an automatic fallback in the shipped WebGPU player.

Asyncify uses `web/sync-webgl-functions.json` for this backend, including the existing synchronous EE/VU worker exclusions and the synchronous GS handler methods. The runtime probe uses the same list. The host still suspends between completed submissions; excluded renderer methods must not call browser-yield or asynchronous readback callbacks. WebGPU continues to use `web/sync-game-functions.json`.

This remains an experimental integration. Full-game transitions, rendering accuracy, frame pacing, context loss/recovery, old snapshot interchange, audio and physical devices still require qualification. Native RAM export rejects unsupported overlapping physical layouts rather than silently overwriting them. Passing the asset-free probe does not establish a playable or performant full game.

## GPU readback regression without game assets

With the pinned SDK activated, build the optional fixture against the actual GS renderer and shaders:

```sh
emcmake cmake -S . -B build/gpu-tests -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DPS2_WEB_ASYNC=asyncify -DPS2_GPU_TESTS=ON
cmake --build build/gpu-tests --target gpu_copy_readback --parallel 2
python3 scripts/serve.py build/gpu-tests /dev/null 8722
```

The disc argument is unused by this fixture. With Puppeteer Core installed, run in a second terminal:

```sh
SSX3_TEST_BROWSER=firefox node scripts/test_gpu_copy_readback.cjs
SSX3_TEST_BROWSER=chrome node scripts/test_gpu_copy_readback.cjs
```

Set `PUPPETEER_MODULE` to its installed directory when it is outside the project. `SSX3_TEST_URL` selects another fixture URL and `SSX3_TEST_OUTPUT` selects the result directory. Optional `SSX3_GPU_TEST_PROFILE=1` also requires timestamp-query support and exercises the profiling submission path. The fixture verifies all pixels from 64 ordered asynchronous frames, varying dimensions, doubled scale, staged uploads, synchronous display and a nonzero-offset VRAM readback. It needs a real WebGPU browser and does not qualify game performance or physical devices.

## Pixel presenter regression without game assets

The worker presenter also has a standalone real-browser check that serves its own isolated local fixture. It needs Node, Python 3, Puppeteer Core and an installed browser with WebGPU; no game build or disc is loaded:

```sh
node scripts/test_pixel_presenter_browser.cjs firefox
node scripts/test_pixel_presenter_browser.cjs chrome
```

Set `PUPPETEER_MODULE` when the module is outside the project, `SSX3_BROWSER_EXECUTABLE` for another browser executable and `SSX3_TEST_OUTPUT` to retain results at a chosen path. `SSX3_TEST_PRESENTER` selects another presenter file for isolated candidate/mutant checks. `SSX3_TEST_HEADLESS=1` selects headless correctness testing. Firefox explicitly enables `dom.webgpu.enabled` for this check; it does not establish stock-browser availability on every platform.

The fixture checks aligned buffer uploads, unaligned texture-upload fallback, exact first-frame updates, shared-storage growth, pause/resume, both aspect ratios, viewport resize and actual device-loss forwarding. Screenshots are compared against an independent bilinear reference, including alpha-zero source pixels and opaque output. A two-pixel viewport-edge margin excludes rasterizer coverage differences; interior RGB error is limited to two levels. Reports include source hashes and API counts so an all-fallback run cannot qualify the buffer path. This checks rendering correctness and lifecycle, not game performance or physical devices.

## Prepared-copy pause and recovery regression

After building and serving the primary JSPI player, Chromium with JSPI and WebGPU can exercise a full copy queue while animation callbacks are held:

```sh
SSX3_TEST_URL=http://127.0.0.1:8620 \
  SSX3_TEST_STATE=test.state \
  node scripts/test_browser_copy_wait.cjs
```

Supply your own compatible runtime state in the served directory; it is not included in the repository. Set `PUPPETEER_MODULE` when Puppeteer Core is installed elsewhere, `CHROMIUM_EXECUTABLE` for another Chromium path, and `SSX3_TEST_OUTPUT` for the evidence directory. The default run uses a visible desktop window so another real tab can background the game. It checks pause acknowledgement with frames frozen, backgrounding, runtime failure and a clean reload into gameplay, with no further animation callback available to release the blocked presenter. It uses `nocard` and leaves saved careers untouched. This is a recovery regression, not a performance measurement.

## Hosting

A private HTTPS deployment needs WebGPU, secure-context APIs, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, byte-range disc requests and suitable Wasm/JavaScript MIME types. Authentication must cover the player, disc and game assets. The existing private deployment's identity, credentials, bucket bindings and release objects are not part of this repository.

The generic runtime design and additional porting flags are documented in [upstream.md](upstream.md).

The standalone backend browser driver also runs native and hybrid depth-alias fixtures. These compare complete target images against forced framebuffer revalidation and full-surface copying, covering stable owners, changed/expired owners, reset, resized storage, nonzero coordinates and disjoint rectangles. Reported validation calls and copied pixel areas measure fixture work, independently of full-game performance.
