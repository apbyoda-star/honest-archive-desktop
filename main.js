// Honest Archive Scan Client — Electron main process.
// Signs in to Honest Archive, watches a folder, and uploads scanned invoices
// automatically. Uses only built-ins (fetch/FormData/Blob available in modern
// Electron main) — no runtime npm dependencies.

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULT_API_BASE = "https://honest-archive-backend-production.up.railway.app";
const SUPPORTED = [".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp"];
const POLL_MS = 3000;

let mainWindow = null;
let tray = null;
let watchTimer = null;
let scanning = false;

// ---- Persistent config (in the OS user-data dir) --------------------------
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  } catch {
    return { apiBase: DEFAULT_API_BASE, ingestToken: "", shopName: "", email: "", watchDir: "" };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
let config = null;

const stats = { uploaded: 0, failed: 0, lastUpload: null };

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function log(line, level) {
  send("status", { line, level: level || "info", time: new Date().toLocaleTimeString() });
}
function pushState() {
  send("state", currentState());
}
function currentState() {
  return {
    signedIn: Boolean(config.ingestToken),
    apiBase: config.apiBase || DEFAULT_API_BASE,
    shopName: config.shopName || "",
    email: config.email || "",
    watchDir: config.watchDir || "",
    scanning,
    stats,
  };
}

// ---- Backend calls ---------------------------------------------------------
async function apiLogin(apiBase, email, password) {
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const res = await fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || "Login failed. Check your email and password.");

  // Exchange the session for the long-lived per-shop ingest token.
  const st = await fetch(base + "/api/v1/onboarding/status", {
    headers: { Authorization: "Bearer " + body.access_token },
  });
  const stBody = await st.json().catch(() => ({}));
  if (!st.ok || !stBody.ingest_token) throw new Error("Signed in, but couldn't load your shop key.");

  return { base, ingestToken: stBody.ingest_token, shopName: stBody.shop_name || "", user: body.user };
}

async function uploadFile(filePath) {
  const base = (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const data = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([data]), path.basename(filePath));
  const res = await fetch(base + "/api/v1/invoices/upload", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.ingestToken },
    body: form,
  });
  if (!res.ok) {
    let detail = "HTTP " + res.status;
    try {
      const b = await res.json();
      if (b && b.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(detail);
  }
}

// ---- Folder watching -------------------------------------------------------
function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

async function scanOnce() {
  if (!config.watchDir || !config.ingestToken) return;
  const dir = config.watchDir;
  const processed = path.join(dir, "processed");
  const failed = path.join(dir, "failed");
  try {
    fs.mkdirSync(processed, { recursive: true });
    fs.mkdirSync(failed, { recursive: true });
  } catch {}

  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!SUPPORTED.includes(path.extname(name).toLowerCase())) continue;

    // Wait for the file to finish arriving (size stable) — handles slow scans
    // and OneDrive hydration.
    const size1 = stat.size;
    await new Promise((r) => setTimeout(r, 1000));
    let size2;
    try {
      size2 = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (size2 !== size1 || size2 === 0) continue;

    log("Uploading " + name + " …");
    try {
      await uploadFile(full);
      fs.renameSync(full, uniqueDest(processed, name));
      stats.uploaded += 1;
      stats.lastUpload = new Date().toLocaleString();
      log("Uploaded " + name, "ok");
    } catch (e) {
      stats.failed += 1;
      try {
        fs.renameSync(full, uniqueDest(failed, name));
        fs.writeFileSync(path.join(failed, name + ".error.txt"), String(e.message || e));
      } catch {}
      log("Failed " + name + ": " + (e.message || e), "error");
    }
    pushState();
  }
}

function startWatching() {
  if (scanning || !config.watchDir || !config.ingestToken) return;
  scanning = true;
  log("Watching " + config.watchDir, "ok");
  const loop = async () => {
    try {
      await scanOnce();
    } catch (e) {
      log("Watcher error: " + (e.message || e), "error");
    }
  };
  loop();
  watchTimer = setInterval(loop, POLL_MS);
  pushState();
  updateTray();
}

function stopWatching() {
  scanning = false;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  log("Stopped watching.");
  pushState();
  updateTray();
}

// ---- Window + tray ---------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: "Honest Archive Scan Client",
    backgroundColor: "#0f1419",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => pushState());

  // Closing the window hides it to the tray and keeps the uploader running in
  // the background. Fully quit from the tray menu → Quit.
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function updateTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: scanning ? "Watching…" : "Idle", enabled: false },
    { type: "separator" },
    { label: "Open", click: () => { if (mainWindow) mainWindow.show(); } },
    scanning
      ? { label: "Stop watching", click: () => stopWatching() }
      : { label: "Start watching", click: () => startWatching() },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip("Honest Archive Scan Client" + (scanning ? " — watching" : ""));
}

function createTray() {
  try {
    const { nativeImage } = require("electron");
    let img = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
    if (img.isEmpty()) {
      // 1x1 transparent fallback so the tray still works if the asset is missing.
      img = nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAYEjQ4nnAAAAAElFTkSuQmCC"
      );
    }
    tray = new Tray(img);
    updateTray();
    tray.on("click", () => { if (mainWindow) mainWindow.show(); });
  } catch {
    // Tray is optional.
  }
}

// ---- IPC -------------------------------------------------------------------
ipcMain.handle("get-state", () => currentState());

ipcMain.handle("login", async (_e, { apiBase, email, password }) => {
  const r = await apiLogin(apiBase, email, password);
  config.apiBase = r.base;
  config.ingestToken = r.ingestToken;
  config.shopName = r.shopName;
  config.email = email;
  saveConfig(config);
  log("Signed in as " + email + (r.shopName ? " (" + r.shopName + ")" : ""), "ok");
  pushState();
  return currentState();
});

ipcMain.handle("logout", () => {
  stopWatching();
  config.ingestToken = "";
  config.shopName = "";
  saveConfig(config);
  pushState();
  return currentState();
});

ipcMain.handle("pick-folder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose the folder to watch for invoices",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: config.watchDir || app.getPath("documents"),
  });
  if (!res.canceled && res.filePaths[0]) {
    config.watchDir = res.filePaths[0];
    saveConfig(config);
    pushState();
  }
  return currentState();
});

ipcMain.handle("start-watch", () => { startWatching(); return currentState(); });
ipcMain.handle("stop-watch", () => { stopWatching(); return currentState(); });
ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));

// ---- App lifecycle ---------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    config = loadConfig();
    createWindow();
    createTray();
    // Resume watching automatically if it was configured before.
    if (config.ingestToken && config.watchDir) startWatching();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (mainWindow) mainWindow.show();
    });
  });

  // Keep running in the tray when the window is closed.
  app.on("window-all-closed", (e) => {
    if (!app.isQuitting && process.platform !== "linux") {
      // window already closed; app stays alive via tray
    } else {
      app.quit();
    }
  });
}
