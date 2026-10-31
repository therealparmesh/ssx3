const qaImport = self.importScripts.bind(self);
self.importScripts = (...urls) =>
  qaImport(...urls.map((file) => new URL(file, QA_BASE).href));
let qaInput = null;
self.addEventListener("message", (e) => {
  const m = e.data;
  if (!m?.qaInput) return;
  try {
    if (!qaInput) {
      qaInput = {
        events: [],
        pads: {},
        connected: {},
        pressure: {},
        resumes: [],
      };
      for (const [name, kind] of [
        ["_ps2web_pad", "pads"],
        ["_ps2web_pad_connected", "connected"],
        ["_ps2web_pressure", "pressure"],
        ["_ps2web_pause", "pause"],
      ]) {
        const native = Module[name];
        Module[name] = function (...args) {
          const result = native.apply(this, args);
          if (kind === "pause") {
            if (!args[0])
              qaInput.resumes.push(
                JSON.parse(
                  JSON.stringify({
                    pads: qaInput.pads,
                    connected: qaInput.connected,
                    pressure: qaInput.pressure,
                  }),
                ),
              );
          } else qaInput[kind][args[0]] = args.slice(1);
          if (qaInput.events.length < 500)
            qaInput.events.push({ name, args, frame: Module._ps2web_frames() });
          return result;
        };
      }
    }
    self.postMessage({
      qaInputReply: m.id,
      result: {
        ...qaInput,
        frame: Module._ps2web_frames(),
        paused: Module.paused,
        failed: Module.failed,
      },
    });
  } catch (error) {
    self.postMessage({ qaInputReply: m.id, error: error.message });
  }
});
importScripts("./game-runtime-worker.js");
