# SSX 3

An experimental SSX 3 (USA, PlayStation 2) browser port built on [ps2-web-recomp](https://github.com/snuri00/ps2-web-recomp). The Emotion Engine executable is statically translated to C++ and compiled to WebAssembly; the remaining console hardware runs in the runtime, with WebGPU graphics and stereo AudioWorklet output.

This repository contains the runtime, recompiler, browser player, build scripts and source regression tests. Supply your own disc image. ROMs, BIOS files, generated game translations, compiled game assets and memory cards are excluded.

## Build and play locally

Use Linux with Bash, Git, CMake 3.20+, Ninja, Python 3, Node.js and a recent Clang/C++20 standard library with `<format>` support. Install 7-Zip when using a compressed disc archive. The scripts install the pinned Emscripten SDK and fetch the native graphics dependency when missing. The previously tested environment was Linux; other build hosts need separate qualification.

```sh
bash scripts/build_ssx3.sh "/absolute/path/to/SSX 3 (USA).iso"
bash scripts/play_ssx3.sh
```

Open `http://127.0.0.1:8620/` in a WebGPU-capable browser. The local server supplies the cross-origin isolation headers and HTTP Range support needed for threaded WebAssembly and disc streaming. Keep the disc and resulting build private.

The build verifies the executable's SHA-1 before translating it: `77114dfd1205eaccf1ccc18c5f9650097fa78bd8` (`SLUS_207.72`). Other regions/revisions are not supported by the SSX 3 wrapper.

The default build uses JSPI and modern Wasm exception handling. A separate Asyncify build is available for browsers missing those features; see [build instructions](docs/building.md). WebGPU, shared memory and cross-origin isolation are required by both builds. Firefox on Linux may require `dom.webgpu.enabled=true` in `about:config`.

## Controls

Connect a standard USB/Bluetooth controller and press a button to activate it. Browser gamepad mappings support two controller slots; physical-device qualification remains incomplete. Touch controls appear on phones and can be enabled with `?touch` for layout testing.

Keyboard positions follow [PCSX2's layout](https://github.com/PCSX2/pcsx2/blob/master/pcsx2/Input/InputManager.cpp), with Space added for jump/select:

| Action | Keys |
| --- | --- |
| Left stick (steer / air adjustment) | WASD |
| D-pad (steer / prewind / spins) | Arrows |
| Crouch / jump / select (Cross) | Space or K |
| Back (Triangle) | I |
| Square / Circle | J / L |
| L1 / R1 | Q / E |
| L2 / R2 | 1 / 3 |
| Left / right stick click | 2 / 4 |
| Right stick | T / F / G / H |
| Game Start / Select | Enter (including numpad Enter) / Backspace |
| Player pause / resume | Escape |
| Fullscreen | Alt+Enter or double-click the game |

Z/X remain Cross/Circle aliases. WASD and arrows operate independently; opposing directions on the same stick cancel to neutral. Browser shortcuts and focused form controls do not become game inputs. Browsers can consume Escape while leaving native fullscreen. Losing window focus or hiding the tab pauses play; use Resume after returning.

Hold Space/K (Cross) to crouch and charge a jump; release it to jump. J (Square) boosts when adrenaline is available. Q/E/1/3 operate the shoulder grabs while airborne.

The steering and air-control labels assume the game's **Default** controller setting. Check it from **Select Character → J (Options) → Controller Settings**. The game's **Pro** setting changes the steering and spin actions; keyboard bindings still represent the same controller inputs.

## Startup, graphics and saves

Opening logos, the timed legal screen and startup movies are skipped by default. The normal title screen, memory-card prompts and profile choices remain interactive. Select **Options → Startup → Show full intro** to restore the sequence.

**Performance** visual effects are the default. **Original (lens flares)** restores the translated decorative effects and can reduce frame rate. Resolution and aspect ratio are also selectable. Settings save the current memory card before reloading; a failed save leaves the old setting intact.

Live FPS/statistics and GPU timestamp queries are opt-in. Add `?debug` to the player URL to show diagnostics and GPU timings when supported. Normal play leaves the HUD inactive: repainting it caused native canvas snapshot waits in Firefox. Debug mode adds measurement overhead.

Save career progress in the game first: **Mcomm → Options → Save game**, or the lodge's **Save Game** command. Saves use the browser's storage for the current origin. Then use the player's **Options → Export card** before changing browser, device or host. Import restores that `.ps2` card on the destination; load the career through the game's normal menus. Concurrent tabs cannot independently overwrite the same origin's card.

## Status and testing

Version 68 is deployed privately with live statistics moved to the existing `?debug` mode. Separate five-minute hosted two-player Snow Jam windows passed at 120 Hz: Firefox 60.000005 fresh submissions/s with a 19.180 ms maximum interval; Chromium 60.002325 with a 20.080 ms maximum. Both riders finished in each run. There was no image/audio loss, clipping or application error. All 50 asset-free CI suites pass. See [current release status](docs/release-status.md) for exact builds, scope and retained earlier failures, and [validation scope](docs/validation.md) for historical evidence and limitations.

The Linux timing tests explicitly enable WebGPU: Firefox uses `dom.webgpu.enabled=true`; Chromium uses `--enable-unsafe-webgpu --enable-features=Vulkan`. Fresh automation profiles without those overrides do not start the game on the tested AMD Linux host. Hardware WebGL 2 is available there, but this build has no WebGL renderer. Default-browser startup therefore remains an open compatibility requirement.

Real iPhone/Android performance, physical controllers, Bluetooth audio and full-game coverage remain unqualified. These results are not a universal 60 fps or bug-free guarantee.

Asset-free checks can run without a disc image:

```sh
cmake -S . -B build/checks -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_COMPILER=clang++ \
  -DPS2_RUNTIME_TESTS=ON -DPS2_DEVELOPER_TOOLS=OFF
cmake --build build/checks --parallel 2
ctest --test-dir build/checks --output-on-failure
node scripts/test_frame_presentation.cjs
node scripts/test_frame_status.cjs
node scripts/test_queue_wait.cjs
node scripts/test_yield_tasks.cjs
node scripts/test_gpu_probe.cjs
node scripts/test_staged_uploads.cjs
node scripts/test_disc_fetch.cjs
```

After installing the pinned Emscripten SDK, run `python3 scripts/test_vu_jit_web.py` for the asset-free optimized Wasm VU compiler and worker check.

If your compiler needs libc++, add `-DCMAKE_CXX_FLAGS=-stdlib=libc++` when configuring. Browser regressions require a local build, a WebGPU-capable browser and locally generated fixtures; instructions are in [validation](docs/validation.md).

## Credits and license

The recompiler/runtime is derived from Samir Nuri's MIT-licensed [ps2-web-recomp](https://github.com/snuri00/ps2-web-recomp), based on commit `6526f4803d98e10de50bea3af104a4d26e9df033`. See [UPSTREAM.md](UPSTREAM.md), [LICENSE](LICENSE) and the preserved [upstream technical documentation](docs/upstream.md).

The IPU VLC tables retain Play!'s BSD-2-Clause notice in [runtime/src/ipu/NOTICE](runtime/src/ipu/NOTICE). Game code and assets are not covered by this repository's license. This project is not affiliated with EA or Sony.
