// Runs the REAL Scan Client main process (main.js) without a window, for
// automated testing on a machine where the GUI can't be shown. Electron's UI
// pieces are stubbed; the config, folder watching and upload code are the
// shipping code, unmodified.
//   node test/headless-run.js <userDataDir>
// Type an IPC channel name on stdin (e.g. "retry-failed", "get-state") to call
// the same handler the window's buttons call; "set-server=<address>" passes an argument.
const Module = require("module");
const path = require("path");
const userData = path.resolve(process.argv[2] || path.join(__dirname, ".userdata"));
const noop = () => {};
const handlers = {};
const pkgVersion = require(path.join(__dirname, "..", "package.json")).version;
class Stub { constructor() {} on() { return this; } loadFile() { return Promise.resolve(); } show() {} hide() {} focus() {} setToolTip() {} setContextMenu() {} isVisible() { return false; } isDestroyed() { return false; } setMenu() {} setMenuBarVisibility() {} }
const electron = {
  app: {
    getPath: () => userData,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: noop, quit: () => process.exit(0), isQuitting: false,
    setLoginItemSettings: noop, getVersion: () => pkgVersion, dock: { hide: noop, show: noop },
  },
  BrowserWindow: class extends Stub { constructor() { super(); this.webContents = { send: (ch, p) => { if (ch === "status") console.log(`[${p.time}] ${p.level}: ${p.line}`); }, on: noop, setWindowOpenHandler: noop }; } static getAllWindows() { return []; } },
  Tray: Stub,
  Menu: { buildFromTemplate: () => ({}) , setApplicationMenu: noop },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: noop },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  shell: { openExternal: noop, openPath: async (p) => { console.log("[headless] openPath " + p); return ""; } },
  nativeImage: { createFromPath: () => ({ resize: () => ({}), isEmpty: () => false, setTemplateImage: noop }), createFromDataURL: () => ({ resize: () => ({}), isEmpty: () => false, setTemplateImage: noop }) },
};
const orig = Module._load;
Module._load = function (req, ...rest) { return req === "electron" ? electron : orig.call(this, req, ...rest); };
const origLog = console.log;
require(path.join(__dirname, "..", "main.js"));
origLog("[headless] scan client started; userData =", userData);
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk) => {
  for (const ch of chunk.split(/\s+/).filter(Boolean)) {
    // "set-server=http://host:port" passes one argument to the handler.
    const eq = ch.indexOf("=");
    const name = eq > 0 ? ch.slice(0, eq) : ch;
    let arg = eq > 0 ? ch.slice(eq + 1) : {};
    // "login={\"email\":…}" passes a JSON object (no spaces).
    if (typeof arg === "string" && arg.startsWith("{")) { try { arg = JSON.parse(arg); } catch {} }
    if (!handlers[name]) { origLog("[headless] no handler", name); continue; }
    try {
      const r = await handlers[name]({}, arg);
      const brief = (x) => (x && x.personal !== undefined ? { scanning: x.scanning, apiBase: x.apiBase, personal: x.personal, stats: x.stats } : x);
      origLog(`[headless] ${name} ->`, JSON.stringify(r && r.state ? { ok: r.ok, message: r.message, state: brief(r.state) } : brief(r)));
    } catch (e) { origLog(`[headless] ${ch} failed:`, e.message); }
  }
});
