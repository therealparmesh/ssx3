# Browser gamepad verification

The production player uses WebGPU and the browser's standard Gamepad API.
Graphics backend selection does not change controller mappings. The initial
Play click enables browser audio; press a controller button so the browser
exposes it to the page. Keep the game tab focused. Start/Options maps to the
game's Start button. Focus loss pauses the player; Resume restores current
controller state before the game worker continues.

Build the dedicated game worker using [the build instructions](../../docs/building.md#dedicated-game-worker),
then run the headed browser check against that local player:

```sh
NODE_PATH=/tmp/ssx3-browser-tools/node_modules \
SSX3_TEST_URL=http://127.0.0.1:8681/ \
node scripts/test_browser_gamepad.cjs chrome

NODE_PATH=/tmp/ssx3-browser-tools/node_modules \
SSX3_TEST_URL=http://127.0.0.1:8681/ \
node scripts/test_browser_gamepad.cjs firefox
```

Use `puppeteer-core` 25.16.0 outside the source checkout, as with the other
browser checks. `PUPPETEER_MODULE`, `CHROMIUM_EXECUTABLE`, `FIREFOX_EXECUTABLE`
and `SSX3_TEST_OUTPUT` override dependencies, executables and evidence output.
Evidence defaults to a new temporary directory. This Linux test explicitly
enables WebGPU with Chromium's unsafe-WebGPU/Vulkan flags or Firefox's
`dom.webgpu.enabled` preference. It does not prove default-browser GPU support.

Before supplying synthetic controllers, the driver verifies a secure context
and calls the browser's real `navigator.getGamepads()`. A missing or denied API
fails before Play. Run with `SSX3_TEST_DENY_GAMEPAD=1` as a negative control;
it must exit unsuccessfully with `Native browser Gamepad API access failed`.
This prevents simulated inputs from hiding a browser permission failure.

Each browser checks 27 checkpoints: independent keyboard stick/D-pad channels;
all sixteen standard controller buttons against fixed PS2 bit assignments;
both sticks and analog trigger pressure; two-player input; disconnect,
reconnect and reordered snapshots; temporary API denial and recovery; actual
tab hiding; neutral input after native pause acknowledgement and return to focus; restoration of
held controls before native resume; and neutral input after all controllers
disconnect. Native frame progress must continue and application errors fail
the run.

The test supplies standard Gamepad API snapshots and observes calls to the
actual native worker exports after forwarding them unchanged. It does not
replace the guest, alter game memory or substitute a native input fixture.
The private worker wrapper exists only in the test browser and is never shipped
with the player. This instrumented check is separate from performance testing.
It requires the user's private game build; no ROM or compiled game asset is
included in the repository. It does not certify every physical controller or
Bluetooth connection. Physical-phone testing is outside the release scope.
