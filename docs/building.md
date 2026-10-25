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

Normal browser play disables GPU timestamp queries; `?debug` enables them when supported. Native runs retain timing collection by default. `PS2_GPU_TIMESTAMPS=0` disables native timing collection, while an explicit `PS2_GPU_PROFILE` still requests the timestamps needed for its profile. Native environment variables are not arbitrary URL options.

## Hosting

A private HTTPS deployment needs WebGPU, secure-context APIs, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, byte-range disc requests and suitable Wasm/JavaScript MIME types. Authentication must cover the player, disc and game assets. The existing private deployment's identity, credentials, bucket bindings and release objects are not part of this repository.

The generic runtime design and additional porting flags are documented in [upstream.md](upstream.md).
