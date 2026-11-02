# Native WebGL upload lifetime checks

These asset-free fixtures exercise client-memory transfers used by the native
WebGL backend. They require WebGL2 and cross-origin isolation. All input patterns
are generated; no disc, BIOS, guest code, captured textures or save state is used.

Run with Node.js and `puppeteer-core` 25.16.0:

```sh
PUPPETEER_MODULE=/path/to/puppeteer-core node scripts/test_webgl_uploads.cjs chromium
PUPPETEER_MODULE=/path/to/puppeteer-core node scripts/test_webgl_uploads.cjs firefox
```

The driver starts an isolated loopback server that serves only the four fixture
files, then closes its pages, browser and server. It records results and fixture
SHA-256 identities in a temporary directory, or `SSX3_WEBGL_ARTIFACT_DIR`.
`SSX3_CHROMIUM_BIN` and `SSX3_FIREFOX_BIN` override executable paths.
`SSX3_WEBGL_HEADLESS=1` opts into headless functional testing; no GPU override
flags are used. The tests require several hundred megabytes of memory.

Each browser checks:

- **480 texture cases**, reading every RGBA result for 58,169,856 source bytes.
  These use normalized R8, RED/UNSIGNED_BYTE and both subviews and the native
  full-heap `srcOffset` overload. Shapes range from 16×16 through 1024×1024,
  including rectangular index maps and 1 MB uploads.
- **576 buffer cases**, reading every word through integer GPU vertex attributes
  for 68,115,840 source bytes. `bufferData` and `bufferSubData` use both subviews
  and the native full-heap Uint8Array offset/length overloads. Sizes include a
  3,264-byte native sprite batch and extend to 1 MB.
- Unshared, shared and 320 MB shared WebAssembly memories; source offsets up to
  288 MB; immediate source overwrite; 16 queued draws before reading results;
  and memory growth, including a 32 MB growth step.
- Independent generated expected values, plus deliberately wrong-data controls
  that must be detected without graphics API errors.

These are transfer correctness checks. The buffer fixture preserves arbitrary
32-bit payloads rather than exercising native float vertex transforms or uniform
blocks. Neither fixture verifies native fallback shader math, complete rendering
history, full-game fidelity, frame pacing, audio, physical controllers or speed.
Passing them cannot clear a failed game-image comparison.
