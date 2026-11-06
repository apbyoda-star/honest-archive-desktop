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
// The shop's filing categories, fetched from the server. Used only to TELL the user
// what each of their subfolders will do — the server still decides on upload, so a
// stale copy here can misinform but can never misfile.
let categories = [];
let privateDocsEnabled = false;
let scanning = false;
let scanInProgress = false; // guards against overlapping scans (double-processing)

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
    folders: config.accountType === "personal" ? [] : folderStatuses(),
    privateDocsEnabled,
    accountType: config.accountType || "shop",
    // Honest Archive Personal only: what's waiting, what failed, and whether the
    // server can be reached — the window shows an attention state from these.
    personal: config.accountType === "personal" ? {
      waiting: P.waiting,
      failed: P.failed,
      trouble: P.trouble,
      problem: P.trouble || P.failed ? personalProblem() : null,
    } : null,
  };
}

/** Normalise a folder name the same way the server does, so what the client shows
 *  and what the server decides can't disagree. */
function slugify(name) {
  return String(name || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

/**
 * Each subfolder of the watch folder, and what will actually happen to scans in it.
 *
 * This is the answer to "how do I know my folder is set up right?" — without it the
 * only way to find out is to scan something and go hunting in the web app.
 */
function folderStatuses() {
  if (!config.watchDir) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(config.watchDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (RESERVED_DIRS.includes(e.name.toLowerCase())) continue;
    const want = slugify(e.name);
    const hit = categories.find((c) => want === c.key || want === slugify(c.label));
    out.push({
      name: e.name,
      matched: Boolean(hit),
      label: hit ? hit.label : null,
      private: Boolean(hit && hit.private),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function refreshCategories() {
  if (!config.ingestToken || config.accountType === "personal") return;
  const base = (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  try {
    const res = await fetch(base + "/api/v1/invoices/scan-categories", {
      headers: { Authorization: "Bearer " + config.ingestToken },
    });
    if (!res.ok) return;               // older backend: folders still work, just unlabelled
    const b = await res.json();
    categories = Array.isArray(b.categories) ? b.categories : [];
    privateDocsEnabled = Boolean(b.private_docs_enabled);
  } catch {
    // Offline is not an error worth shouting about — uploads carry the folder name
    // regardless and the server is the one that decides.
  }
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

  return {
    base,
    ingestToken: stBody.ingest_token,
    shopName: stBody.shop_name || (body.user && body.user.account_type === "personal" ? "your archive" : ""),
    accountType: (body.user && body.user.account_type) || "shop",
    user: body.user,
  };
}

// ---- Honest Archive Personal: whole scanner feeds, not single files ---------
//
// A Brother ADS-3100 saves every page as its own PDF, named after the moment the
// feed started plus the page's position in it:
//     Scan2026-11-03_094512_001.pdf, Scan2026-11-03_094512_002.pdf, ...
// Pages of one paper document are therefore split across files, and only the
// whole feed, in order, tells the server where one document ends and the next
// begins. So every page goes up under its feed's key with complete=false, as soon
// as the file has finished arriving; the SERVER closes the feed once no new page
// has come for a minute. That survives paper jams (the feed just pauses), and a
// retried page is harmless because the server skips file names it already has
// for that feed. Loose files (a photo, a PDF dropped in by hand) are each their
// own batch and go up with complete=true.
//
// Files only ever move to failed/ when Honest Archive looked at them and said no
// (a damaged file, too big). If the server can't be reached, or has a hiccup, the
// pages stay exactly where the scanner put them and are tried again later.
const BROTHER_RE = /^(.+?)_(\d{3,4})\.(pdf|jpe?g|png|tiff?|bmp)$/i;
const PAGES_PER_REQUEST = 25;
const MIN_FILE_AGE_MS = 3000;            // a page must be this old AND unchanged since the last look
const FEED_QUIET_MS = 65000;             // matches the server's 60s settle (+ a little)
const PING_MS = 5 * 60 * 1000;
const AUTO_RETRY_MS = 60 * 60 * 1000;
const BACKOFF_MS = [30e3, 60e3, 120e3, 240e3, 480e3, 600e3];
const UPLOAD_TIMEOUT_MS = 120000;
const PING_TIMEOUT_MS = 15000;

const P = {
  seen: new Map(),        // full path -> {size, mtime} from the previous look
  feeds: new Map(),       // feed key -> {desc, total, sent, lastNewAt}
  groupBackoff: new Map(),// feed key -> {attempts, nextAt}  (server hiccups for one feed)
  block: null,            // {kind, attempts, nextAt, since}  (can't reach / sign-in refused)
  trouble: null,          // what was last logged about the connection, so it's said ONCE
  lastReject: "",         // plain-words reason for the newest file moved to failed/
  waiting: 0,
  failed: 0,
  lastPing: 0,
  pingAt: 0,              // a ping is due at this time (after uploads/failures)
  lastAutoRetry: 0,
};

function batchKeyFor(name) {
  const m = BROTHER_RE.exec(name);
  // A scanner feed's key carries the date/time the feed started; "IMG_0423.jpg"
  // from a phone does not, and must stay a loose file (its own batch).
  if (!m || !/\d{6}/.test(m[1])) return null;
  return { key: m[1], seq: parseInt(m[2], 10) };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "scan from Nov 5, 8:12 AM" for a Brother key; never the raw key. */
function describeFeed(key, firstName) {
  const m = /(\d{4})-?(\d{2})-?(\d{2})[_\-T ]?(\d{2})(\d{2})(\d{2})?/.exec(key || "");
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if (!isNaN(d.getTime())) {
      return "scan from " + d.toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
    }
  }
  return firstName ? `“${firstName}”` : "scan";
}

class SendError extends Error {
  // kind: "offline" (can't reach), "server" (5xx/429/408 — temporary),
  //       "account" (401/402/403 — sign-in/plan), "rejected" (the server said no to the file)
  constructor(message, kind, status) {
    super(message);
    this.kind = kind;
    this.status = status || 0;
  }
}

function apiBaseUrl() {
  return (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}

async function personalFetch(urlPath, opts, timeoutMs) {
  let res;
  try {
    res = await fetch(apiBaseUrl() + urlPath, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new SendError("Can't reach Honest Archive.", "offline");
  }
  if (res.ok) return res;
  let detail = "";
  try {
    const b = await res.json();
    if (b && typeof b.detail === "string") detail = b.detail;
  } catch {}
  const s = res.status;
  if (s >= 500 || s === 429 || s === 408) {
    throw new SendError("Honest Archive is having trouble right now.", "server", s);
  }
  if (s === 401 || s === 403) {
    throw new SendError("Honest Archive didn't accept this computer's sign-in. Sign out of the Scan Client and sign in again.", "account", s);
  }
  if (s === 402) {
    throw new SendError(detail || "The Honest Archive subscription needs attention.", "account", s);
  }
  let reason;
  if (s === 413) reason = detail || "This file is too big to send.";
  else if (s === 404) reason = "Honest Archive didn't recognise this upload — check the server address in the Scan Client, or that this is a home (Personal) account.";
  else reason = (detail && detail !== "Not Found") ? detail : "Honest Archive couldn't open this file. Scan it again as a PDF.";
  throw new SendError(reason, "rejected", s);
}

async function sendPages(key, files, complete) {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([fs.readFileSync(f.full)]), f.name);
  form.append("batch_key", key);
  form.append("complete", complete ? "true" : "false");
  await personalFetch("/api/v1/personal/scans", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.ingestToken },
    body: form,
  }, UPLOAD_TIMEOUT_MS);
}

/** Supported files the scanner (or a person) left in the watch folder or one of
 *  its direct subfolders — the scanner may save into a dated subfolder. */
function personalInbox(root) {
  const dirs = [root];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (RESERVED_DIRS.includes(e.name.toLowerCase())) continue;
      dirs.push(path.join(root, e.name));
    }
  } catch {
    return [];
  }
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (!SUPPORTED.includes(path.extname(name).toLowerCase())) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      out.push({ name, full, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

function failedFiles(root) {
  try {
    return fs.readdirSync(path.join(root, "failed"))
      .filter((n) => !n.startsWith(".") && SUPPORTED.includes(path.extname(n).toLowerCase()));
  } catch {
    return [];
  }
}

function backoffMs(attempts) {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] || BACKOFF_MS[0];
}

/** Say once that something's wrong with the connection; say once when it's fixed. */
function noteTrouble(kind) {
  if (P.trouble === kind) return;
  P.trouble = kind;
  const n = P.waiting;
  const safe = n ? ` ${plural(n, "page")} ${n === 1 ? "is" : "are"} waiting safely in the folder.` : "";
  if (kind === "offline") log("Can't reach Honest Archive — will keep trying." + safe, "error");
  else if (kind === "server") log("Honest Archive is having trouble right now — will keep trying." + safe, "error");
  else if (kind === "account") log((P.block && P.block.message) || "Honest Archive didn't accept this computer's sign-in.", "error");
}

function noteConnected() {
  if (!P.trouble) return;
  P.trouble = null;
  const n = P.waiting;
  log("Connected to Honest Archive again" + (n ? ` — sending ${plural(n, "waiting page")}.` : "."), "ok");
}

function recordRejected(root, label, files, reason) {
  const failedDir = path.join(root, "failed");
  const moved = [];
  for (const f of files) {
    try {
      if (!fs.existsSync(f.full)) continue;
      const dest = uniqueDest(failedDir, f.name);
      fs.renameSync(f.full, dest);
      moved.push(path.basename(dest));
    } catch {}
    P.seen.delete(f.full);
  }
  if (!moved.length) return;
  const safeLabel = String(label).replace(/[^\w.\- ]+/g, "_").slice(0, 80);
  let errPath = path.join(failedDir, safeLabel + ".error.txt");
  if (fs.existsSync(errPath)) errPath = path.join(failedDir, `${safeLabel}_${Date.now()}.error.txt`);
  try {
    fs.writeFileSync(errPath, [
      "Couldn't send: " + reason,
      "When: " + new Date().toLocaleString(),
      "Files: " + moved.join(", "),
      "Kind: rejected",
      "",
      "Fix the file (or scan it again) and press “Retry failed scans” in the Scan Client.",
      "",
    ].join("\n"));
  } catch {}
  stats.failed += moved.length;
  P.lastReject = reason;
}

/** Error records in failed/ and the files each one covers. Older versions wrote
 *  records without a Files: line — work the files out from the record's name. */
function failedRecords(root) {
  const failedDir = path.join(root, "failed");
  let names = [];
  try { names = fs.readdirSync(failedDir); } catch { return []; }
  const pages = names.filter((n) => SUPPORTED.includes(path.extname(n).toLowerCase()));
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".error.txt")) continue;
    let text = "";
    try { text = fs.readFileSync(path.join(failedDir, n), "utf-8"); } catch { continue; }
    const label = n.slice(0, -".error.txt".length);
    const fl = /^Files: (.*)$/m.exec(text);
    let files;
    if (fl) {
      files = fl[1].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (label.startsWith("file-")) {
      const base = label.slice(5).replace(/-\d+$/, "");
      files = pages.filter((p) => path.basename(p, path.extname(p)).startsWith(base));
    } else if (pages.includes(label)) {
      files = [label];
    } else {
      files = pages.filter((p) => { const b = batchKeyFor(p); return b && b.key === label; });
    }
    const kindLine = /^Kind: (\w+)/m.exec(text);
    const network = kindLine
      ? kindLine[1] !== "rejected"
      : /HTTP (5\d\d|429|408)\b|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|socket|network|timed? ?out|aborted|terminated/i.test(text);
    out.push({ record: path.join(failedDir, n), files, network });
  }
  return out;
}

/** Move failed pages back into the watch folder so they're sent again. Brother
 *  pages keep their names, so a feed regroups by itself. */
function retryFailed(root, onlyNetwork) {
  const failedDir = path.join(root, "failed");
  const records = failedRecords(root);
  let wanted;
  if (onlyNetwork) {
    wanted = new Set();
    for (const r of records) if (r.network) r.files.forEach((f) => wanted.add(f));
  } else {
    wanted = new Set(failedFiles(root));
  }
  let moved = 0;
  for (const name of wanted) {
    const from = path.join(failedDir, name);
    const to = path.join(root, name);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.renameSync(from, to);
      moved += 1;
    } catch {}
  }
  // Drop records whose files have all gone back.
  for (const r of records) {
    if (r.files.every((f) => !fs.existsSync(path.join(failedDir, f)))) {
      try { fs.unlinkSync(r.record); } catch {}
    }
  }
  if (moved) {
    P.lastReject = "";
    P.groupBackoff.clear();
    if (P.block) P.block.nextAt = 0;
  }
  return moved;
}

function personalProblem() {
  if (!scanning) return "The Scan Client is paused — press Start watching on the scanner computer.";
  if (P.block && P.block.kind === "account") return P.block.message;
  if (P.trouble === "offline") return "The scanner computer can't reach Honest Archive.";
  if (P.trouble === "server") return "Honest Archive had trouble receiving scans — the Scan Client keeps trying.";
  if (P.failed > 0) {
    if (!P.lastReject && config.watchDir) {
      // After a restart: take the reason from the newest record in failed/.
      let newest = null;
      for (const r of failedRecords(config.watchDir)) {
        try {
          const t = fs.statSync(r.record).mtimeMs;
          if (!newest || t > newest.t) newest = { t, path: r.record };
        } catch {}
      }
      if (newest) {
        try {
          const m = /^Couldn't send: (.*)$/m.exec(fs.readFileSync(newest.path, "utf-8"));
          if (m) P.lastReject = m[1].trim();
        } catch {}
      }
    }
    return `${plural(P.failed, "page")} couldn't be sent` + (P.lastReject ? `: ${P.lastReject}` : ". Press “Retry failed scans” on the scanner computer.");
  }
  return null;
}

async function pingPersonal() {
  if (config.accountType !== "personal" || !config.ingestToken) return;
  P.lastPing = Date.now();
  P.pingAt = 0;
  if (config.watchDir) {
    P.waiting = personalInbox(config.watchDir).length;
    P.failed = failedFiles(config.watchDir).length;
  }
  try {
    await personalFetch("/api/v1/personal/scanner/ping", {
      method: "POST",
      headers: { Authorization: "Bearer " + config.ingestToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: appVersion(),
        waiting: P.waiting,
        failed: P.failed,
        message: personalProblem(),
      }),
    }, PING_TIMEOUT_MS);
    // The server answered, so if we were waiting out a "can't reach", try now.
    if (P.block && P.block.kind === "offline") P.block.nextAt = 0;
  } catch {
    // A missed check-in is what tells the website the computer is offline.
  }
}

function pingSoon() {
  if (!P.pingAt) P.pingAt = Date.now() + 3000;
}

function appVersion() {
  try { return app.getVersion(); } catch { return ""; }
}

async function scanPersonal(root) {
  const processed = path.join(root, "processed");
  try {
    fs.mkdirSync(processed, { recursive: true });
    fs.mkdirSync(path.join(root, "failed"), { recursive: true });
  } catch {}
  const now = Date.now();

  if (now - P.lastAutoRetry >= AUTO_RETRY_MS) {
    P.lastAutoRetry = now;
    const n = retryFailed(root, true);
    if (n) log(`Trying ${plural(n, "page")} again that couldn't be sent earlier because of a connection problem.`);
  }

  const files = personalInbox(root);
  const present = new Set(files.map((f) => f.full));
  for (const k of P.seen.keys()) if (!present.has(k)) P.seen.delete(k);

  // Group into feeds; a page is ready once it's a few seconds old and hasn't
  // changed since the previous look (the scanner has finished writing it).
  const groups = new Map();
  for (const f of files) {
    const prev = P.seen.get(f.full);
    f.ready = Boolean(prev && prev.size === f.size && prev.mtime === f.mtime && now - f.mtime >= MIN_FILE_AGE_MS);
    P.seen.set(f.full, { size: f.size, mtime: f.mtime });
    const b = batchKeyFor(f.name);
    f.seq = b ? b.seq : 0;
    const key = b ? b.key
      : "file-" + path.basename(f.name, path.extname(f.name)).slice(0, 60) + "-" + Math.round(f.mtime);
    if (!groups.has(key)) groups.set(key, { key, scanner: Boolean(b), files: [] });
    groups.get(key).files.push(f);
  }
  const prevWaiting = P.waiting;
  P.waiting = files.length;
  P.failed = failedFiles(root).length;

  // Tell people what the scanner is doing — only when the page count changes.
  for (const g of groups.values()) {
    if (!g.scanner) continue;
    g.files.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
    let feed = P.feeds.get(g.key);
    if (!feed) {
      feed = { desc: describeFeed(g.key, g.files[0].name), total: 0, sent: 0, lastNewAt: now };
      P.feeds.set(g.key, feed);
    }
    const total = feed.sent + g.files.length;
    if (total > feed.total) {
      feed.total = total;
      feed.lastNewAt = now;
      const cap = feed.desc.charAt(0).toUpperCase() + feed.desc.slice(1);
      log(`${cap}: ${plural(total, "page")} so far — waiting for the scanner to finish…`);
    }
  }

  const blocked = P.block && now < P.block.nextAt;
  if (!blocked) {
    const order = [...groups.values()].sort(
      (a, b) => Math.min(...a.files.map((f) => f.mtime)) - Math.min(...b.files.map((f) => f.mtime)));
    outer:
    for (const g of order) {
      const gb = P.groupBackoff.get(g.key);
      if (gb && now < gb.nextAt) continue;
      const ready = g.files.filter((f) => f.ready);
      if (!ready.length) continue;
      for (let i = 0; i < ready.length; i += PAGES_PER_REQUEST) {
        const chunk = ready.slice(i, i + PAGES_PER_REQUEST);
        try {
          await sendPages(g.key, chunk, !g.scanner);
        } catch (e) {
          if (!(e instanceof SendError)) {
            // A file vanished or couldn't be read mid-way — look again next poll.
            continue outer;
          }
          if (e.kind === "rejected") {
            // If the server named one page, fail only that one; the rest go next poll.
            const named = chunk.length > 1 ? chunk.find((f) => e.message.includes(f.name)) : null;
            const bad = named ? [named] : chunk;
            recordRejected(root, g.scanner ? g.key : bad[0].name, bad, e.message);
            const what = g.scanner ? `${plural(bad.length, "page")} of the ${describeFeed(g.key, bad[0].name)}` : `“${bad[0].name}”`;
            log(`Couldn't send ${what}: ${e.message} It's in the “failed” folder.`, "error");
            noteConnected();
            pingSoon();
            pushState();
            continue outer;
          }
          if (e.kind === "server") {
            const attempts = ((gb && gb.attempts) || 0) + 1;
            P.groupBackoff.set(g.key, { attempts, nextAt: Date.now() + backoffMs(attempts) });
            noteTrouble("server");
            pingSoon();
            pushState();
            continue outer;
          }
          // Can't reach the server, or it refused this computer's sign-in: stop
          // for now, leave every file where it is, try again after a pause.
          const attempts = (P.block && P.block.kind === e.kind ? P.block.attempts : 0) + 1;
          P.block = { kind: e.kind, attempts, nextAt: Date.now() + backoffMs(attempts), message: e.message,
                      since: (P.block && P.block.since) || new Date() };
          noteTrouble(e.kind);
          pushState();
          break outer;
        }
        // Sent.
        P.block = null;
        P.groupBackoff.delete(g.key);
        noteConnected();
        for (const f of chunk) {
          try { fs.renameSync(f.full, uniqueDest(processed, f.name)); } catch {}
          P.seen.delete(f.full);
        }
        P.waiting = Math.max(0, P.waiting - chunk.length);
        stats.uploaded += chunk.length;
        stats.lastUpload = new Date().toLocaleString();
        if (g.scanner) {
          const feed = P.feeds.get(g.key);
          if (feed) { feed.sent += chunk.length; feed.sentAt = Date.now(); }
        } else {
          log(`Sent “${chunk[0].name}” — it'll be filed in a minute or two.`, "ok");
        }
        pingSoon();
        pushState();
      }
    }
  }

  // A feed that's all sent and hasn't grown for a minute is complete on the server.
  for (const [key, feed] of P.feeds) {
    const g = groups.get(key);
    if (g && g.files.length) continue;
    if (now - Math.max(feed.lastNewAt, feed.sentAt || 0) < FEED_QUIET_MS) continue;
    if (feed.sent > 0) {
      const cap = feed.desc.charAt(0).toUpperCase() + feed.desc.slice(1);
      log(`${cap} (${plural(feed.sent, "page")}) sent — it'll be filed in a minute or two.`, "ok");
    }
    P.feeds.delete(key);
  }

  if (P.waiting !== prevWaiting) pushState();
}

/** Called every few seconds whatever else is happening: the 5-minute check-in,
 *  plus one shortly after uploads and failures. */
function personalTick() {
  if (config.accountType !== "personal" || !config.ingestToken) return;
  const now = Date.now();
  if ((P.pingAt && now >= P.pingAt) || now - P.lastPing >= PING_MS) pingPersonal();
}

async function uploadFile(filePath, folder) {
  const base = (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const data = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([data]), path.basename(filePath));
  // Which subfolder it came from, when it wasn't the watch root. The server maps
  // this to one of the shop's categories; an unrecognised name holds the document
  // for review rather than being ignored, so a folder that was created but never
  // configured doesn't silently file everything as a parts invoice.
  if (folder) form.append("folder", folder);
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

// Folders that are ours, not filing destinations.
const RESERVED_DIRS = ["processed", "failed"];

/**
 * Every folder to watch: the root, plus each direct subfolder.
 *
 * A subfolder is a filing destination — drop a scan in `Tax Documents/` and it
 * files as a tax document; drop it loose in the root and it's an ordinary parts
 * invoice. This matches how people already use a filing cabinet, and a shop adds a
 * new destination by creating a folder rather than by waiting for a release.
 *
 * Only ONE level deep. Recursing would eventually walk into a shop's own archive of
 * years of scans and re-upload all of it.
 */
function watchTargets(root) {
  const targets = [{ dir: root, folder: null }];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return targets;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (RESERVED_DIRS.includes(e.name.toLowerCase())) continue;
    targets.push({ dir: path.join(root, e.name), folder: e.name });
  }
  return targets;
}

async function scanOnce() {
  // Never let two scans run at once — that double-processes files (file races)
  // and floods the backend with concurrent uploads.
  if (scanInProgress || !config.watchDir || !config.ingestToken) return;
  scanInProgress = true;
  try {
    if (config.accountType === "personal") {
      await scanPersonal(config.watchDir);
    } else {
      for (const target of watchTargets(config.watchDir)) {
        await scanFolder(target.dir, target.folder);
      }
    }
  } finally {
    scanInProgress = false;
  }
}

async function scanFolder(dir, folder) {
  {
    // processed/ and failed/ live INSIDE the folder the file came from, so a
    // private document's filename never lands in a shared folder next to the
    // ordinary invoices, and you can always see where something was filed from.
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
      // Re-check the file still exists right before uploading.
      if (!fs.existsSync(full)) continue;

      log("Uploading " + name + (folder ? ` (${folder})` : "") + " …");
      try {
        await uploadFile(full, folder);
        fs.renameSync(full, uniqueDest(processed, name));
        stats.uploaded += 1;
        stats.lastUpload = new Date().toLocaleString();
        log("Uploaded " + name + (folder ? ` → ${folder}` : ""), "ok");
      } catch (e) {
        stats.failed += 1;
        try {
          if (fs.existsSync(full)) {
            fs.renameSync(full, uniqueDest(failed, name));
            fs.writeFileSync(path.join(failed, name + ".error.txt"), String(e.message || e));
          }
        } catch {}
        log("Failed " + name + ": " + (e.message || e), "error");
      }
      pushState();
    }
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
    // Schedule the NEXT scan only after this one fully finishes — no overlap.
    if (scanning) watchTimer = setTimeout(loop, POLL_MS);
  };
  loop();
  pushState();
  updateTray();
  if (config.accountType === "personal") pingSoon();
}

function stopWatching() {
  scanning = false;
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  log("Stopped watching.");
  pushState();
  updateTray();
  if (config.accountType === "personal") pingSoon();
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
  mainWindow.webContents.on("did-finish-load", async () => {
    pushState();
    await refreshCategories();
    pushState();
  });

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
  config.accountType = r.accountType;
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
    await refreshCategories();   // so the folder list is right immediately
    pushState();
  }
  return currentState();
});

ipcMain.handle("refresh-categories", async () => { await refreshCategories(); pushState(); return currentState(); });
ipcMain.handle("start-watch", async () => { await refreshCategories(); startWatching(); return currentState(); });
ipcMain.handle("stop-watch", () => { stopWatching(); return currentState(); });
ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));
ipcMain.handle("retry-failed", () => {
  if (config.accountType !== "personal" || !config.watchDir) return currentState();
  const n = retryFailed(config.watchDir, false);
  P.failed = failedFiles(config.watchDir).length;
  log(n ? `Moved ${plural(n, "page")} back — sending ${n === 1 ? "it" : "them"} again.` : "There was nothing to retry.", n ? "ok" : "info");
  pingSoon();
  pushState();
  return currentState();
});

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
    // Honest Archive Personal check-ins (every 5 minutes, and soon after uploads).
    setInterval(personalTick, 5000);
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
