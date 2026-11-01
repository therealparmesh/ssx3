const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const shell = fs.readFileSync(
  path.join(__dirname, "../web/shell.html"),
  "utf8",
);
const start = shell.indexOf("function preferWebglSurface() {");
const end = shell.indexOf("var Module = {", start);
assert(start >= 0 && end > start);
const functions = shell.slice(start, end);
const cases = [
  [true, "asyncify", "", "Chrome/156 Linux", false, true],
  [true, "asyncify", "direct", "Chrome/156 Linux", true, false],
  [true, "asyncify", "direct&copy", "Firefox/158 Linux", false, true],
  [true, "asyncify", "direct&nosurface", "Firefox/158 Linux", false, true],
  [true, "asyncify", "direct", "Firefox/158 Linux", true, false],
  [false, "asyncify", "direct", "Chrome/156 Linux", false, false],
  [false, "jspi", "direct", "Chrome/156 Linux", false, true],
  [false, "jspi", "direct", "Chrome/156 Android Mobile", false, false],
  [false, "jspi", "direct", "Firefox/158 Linux", false, false],
  [false, "asyncify", "copy", "Firefox/158 Linux", false, true],
];
for (const [webglBackend, asyncMode, query, userAgent, direct, copy] of cases) {
  const context = vm.createContext({
    webglBackend,
    params: new URLSearchParams(query),
    navigator: { userAgent },
  });
  const result = vm.runInContext(
    functions.replaceAll("@PS2_WEB_ASYNC@", asyncMode) +
      "\n({direct:preferWebglSurface(),copy:preferFrameCopy()})",
    context,
  );
  assert.equal(
    result.direct,
    direct,
    JSON.stringify([webglBackend, asyncMode, query, userAgent]),
  );
  assert.equal(
    result.copy,
    copy,
    JSON.stringify([webglBackend, asyncMode, query, userAgent]),
  );
}
console.log(
  "WebGL surface opt-in and existing WebGPU selection: 10 scenarios passed",
);
