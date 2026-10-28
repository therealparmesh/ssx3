# Building SSX 3

The wrapper accepts an ISO or a completed ZIP/7z archive containing one. It extracts the boot executable, verifies the supported USA revision, explores indirect entry points and vector programs, translates the code and builds the native/primary browser runners. Game files, generated translations, captures and build output remain under ignored directories.

```sh
bash scripts/build_ssx3.sh "/path/to/SSX 3 (USA).iso"
```

`--frames`, `--rounds` and `--press` are forwarded to `scripts/port.sh` to control exploration. `--no-explore` reuses existing entry/vector discoveries when rebuilding. Native SDL window support needs SDL2 development headers.

The primary player is `build/web-ssx3/ps2web.html`. Serve it with:

```sh
python3 scripts/serve.py build/web-ssx3 games/ssx3/disc.iso 8620
```

`scripts/build_web.sh ssx3` rebuilds the primary after source changes. `scripts/play_ssx3.sh` starts the same server at port 8620 by default. `scripts/host_ssx3.sh` optionally installs a local Linux user service; it is not needed for ordinary local play.

## Compatibility build

First complete the wrapper build so `games/ssx3/entries.txt`, vector recordings, the native tools and SDK are available. From the repository root:

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
  -DPS2_WEB_ASYNC=asyncify \
  -DPS2_GENERATED="$PWD/generated/ssx3-asyncify" \
  -DPS2_WEB_ELF="$PWD/games/ssx3/disc/SLUS_207.72" \
  -DPS2_WEB_BOOT_FILE="$PWD/build/web-ssx3/boot.txt" \
  -DPS2_WEB_PATCHES=
cmake --build build/web-ssx3-asyncify --target ps2web --parallel 2
python3 scripts/serve.py build/web-ssx3-asyncify games/ssx3/disc.iso 8680
```

Use the original executable for both variants. The old `patches/ssx3-no-lensfx.pnach` is retained only as a legacy diagnostic; do not combine it with the selectable visual-effects build.

The local server serves the selected directory directly. It does not choose between primary and compatibility builds automatically. Use the URL for the variant your browser supports. Separate ports are separate storage origins, so export/import a card when switching between them.

The browser host passes the selected startup/effects mode to the runtime. The native runner accepts `--fast-boot` and `--full-effects` to enable the corresponding paths.

### Dedicated game worker

After generating the compatibility translation above, build the optional worker player with:

```sh
PS2_WEB_ASYNC=asyncify PS2_WEB_WORKER=ON bash scripts/build_web.sh ssx3
python3 scripts/serve.py build/web-ssx3-asyncify-worker games/ssx3/disc.iso 8681
```

This variant requires worker WebGPU and transferable OffscreenCanvas in addition to the shared-memory requirements. The page owns user gestures, controls and audio; the game worker owns the runtime and saved-card filesystem. The window creates a separate lightweight presentation worker with three shared pixel slots, keeping its refresh callback separate from the larger Wasm realm. A MessagePort connects it directly to the game worker, so frame data bypasses the window. This also supplies Chromium's window-owned worker animation callbacks. Both workers are explicitly released on shutdown; a renderer crash preserves the game worker for card export. Add `?presenter=direct` to select the preceding direct game-worker surface for diagnostics. Both paths use the same frame-pacing clock.

Keep all seven helper scripts listed in `ps2web-worker-assets.json` beside `ps2web.js`, `.wasm` and `.data`. The build checks their JavaScript and generates compressed copies. A deployment must include these helpers in its release identity and supply their JavaScript MIME types and isolation headers. Private QA wrappers, generated game translations and memory cards are not distributable source assets.

The split presenter submits empty GPU work only while a readback mapping is pending, to advance completion on Firefox implementations with slow completion polling. Map completion, failure and shutdown cancel pending progress polls. Desktop checks do not qualify phone GPUs or physical controllers/audio devices; see [validation](validation.md).

Normal browser play disables GPU timestamp queries; `?debug` enables them when supported. Native runs retain timing collection by default. `PS2_GPU_TIMESTAMPS=0` disables native timing collection, while an explicit `PS2_GPU_PROFILE` still requests the timestamps needed for its profile. Native environment variables are not arbitrary URL options.

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
