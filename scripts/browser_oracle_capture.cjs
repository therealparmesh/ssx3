// Save full-resolution oracle failures individually; never aggregate their
// base64 payloads into the browser's final JSON result.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

async function installOracleCapture(page, output) {
  const pending = new Set();
  const seen = new Set();
  let images = 0,
    bytesWritten = 0;
  await page.exposeFunction("ssx3WriteOracleMismatch", async (capture) => {
    const {
      imageSequence,
      nativeFrame,
      width,
      height,
      sha256,
      expectedSha256,
      base64,
    } = capture;
    assert(
      Number.isSafeInteger(imageSequence) && imageSequence > 0,
      "Invalid image sequence",
    );
    assert(
      Number.isSafeInteger(nativeFrame) && nativeFrame >= 0,
      "Invalid native frame",
    );
    assert(
      Number.isSafeInteger(width) &&
        width > 0 &&
        Number.isSafeInteger(height) &&
        height > 0,
      "Invalid image dimensions",
    );
    assert(
      Number.isSafeInteger(width * height * 4),
      "Invalid image byte count",
    );
    assert(
      /^[a-f0-9]{64}$/.test(sha256) && /^[a-f0-9]{64}$/.test(expectedSha256),
      "Invalid image hash",
    );
    assert(typeof base64 === "string", "Missing mismatch bytes");
    const bytes = Buffer.from(base64, "base64");
    assert.equal(
      bytes.length,
      width * height * 4,
      "Incomplete mismatch capture",
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      sha256,
      "Mismatch capture hash differs",
    );
    assert(!seen.has(imageSequence), "Duplicate mismatch image sequence");
    seen.add(imageSequence);
    const file = "image-" + imageSequence + "-mismatch.rgba";
    const write = fs.promises.writeFile(path.join(output, file), bytes);
    pending.add(write);
    try {
      await write;
      images++;
      bytesWritten += bytes.length;
      return {
        imageSequence,
        nativeFrame,
        width,
        height,
        sha256,
        expectedSha256,
        file,
      };
    } catch (error) {
      seen.delete(imageSequence);
      throw error;
    } finally {
      pending.delete(write);
    }
  });
  await page.evaluateOnNewDocument(() => {
    globalThis.ssx3SaveOracleMismatch = async (
      record,
      expectedSha256,
      bytes,
    ) => {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 16384)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 16384),
        );
      return globalThis.ssx3WriteOracleMismatch({
        ...record,
        expectedSha256,
        base64: btoa(binary),
      });
    };
  });
  return {
    stats: () => ({ images, bytesWritten }),
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}
module.exports = { installOracleCapture };
