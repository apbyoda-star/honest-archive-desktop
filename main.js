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
    // Personal: "Failed" is the pages sitting in failed/ right now (each counted
    // once), not how many upload attempts went wrong this session.
    stats: config.accountType === "personal" ? { ...stats, failed: P.failed } : stats,
    folders: config.accountType === "personal" ? [] : folderStatuses(),
    privateDocsEnabled,
    accountType: config.accountType || "shop",
    // Honest Archive Personal only: what's waiting, what failed, and whether the
    // server can be reached — the window shows an attention state from these.
    personal: config.accountType === "personal" ? {
      waiting: P.waiting,
      failed: P.failed,
      retryable: P.retryable,
      trouble: P.trouble,
      problem: P.trouble || P.failed ? personalProblem(true) : null,
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
  const unreachable = () => new Error(`Can't reach Honest Archive at ${base}. Check the server address and the internet connection.`);
  let res;
  try {
    res = await fetch(base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw unreachable();
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) {
    throw new Error(`Nothing at ${base} answers as Honest Archive. Check the server address.`);
  }
  if (!res.ok) {
    throw new Error(typeof body.detail === "string" && body.detail
      ? body.detail : "Login failed. Check your email and password.");
  }
  const personal = Boolean(body.user && body.user.account_type === "personal");

  // Exchange the session for the long-lived per-shop ingest token.
  let st;
  try {
    st = await fetch(base + "/api/v1/onboarding/status", {
      headers: { Authorization: "Bearer " + body.access_token },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw unreachable();
  }
  const stBody = await st.json().catch(() => ({}));
  if (!st.ok || !stBody.ingest_token) {
    throw new Error(personal ? "Signed in, but couldn't load your account key." : "Signed in, but couldn't load your shop key.");
  }

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
  failed: 0,              // unique pages in failed/
  retryable: 0,           // ...of which "Retry failed scans" can usefully send again
  oneByOne: new Set(),    // feed keys whose pages go up singly (a multi-page request was refused whole)
  finished: new Set(),    // feed keys already reported as sent this session (more pages = "the rest of")
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
  constructor(message, kind, status, detail) {
    super(message);
    this.kind = kind;
    this.status = status || 0;
    this.detail = detail || "";
  }
}

function apiBaseUrl() {
  return (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}

async function personalFetch(urlPath, opts, timeoutMs, baseOverride) {
  let res;
  try {
    res = await fetch((baseOverride || apiBaseUrl()) + urlPath, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
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
  if (s === 413) reason = TOO_BIG;
  else if (s === 404) reason = ADDRESS_WRONG;
  else if (s === 422) reason = NOT_READABLE;
  else reason = (detail && detail !== "Not Found") ? detail : "Honest Archive couldn't open this file. Scan it again as a PDF.";
  throw new SendError(reason, "rejected", s, detail);
}

async function sendPages(key, files, complete) {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([fs.readFileSync(f.full)]), f.name);
  form.append("batch_key", key);
  form.append("complete", complete ? "true" : "false");
  const res = await personalFetch("/api/v1/personal/scans", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.ingestToken },
    body: form,
  }, UPLOAD_TIMEOUT_MS);
  return res.json().catch(() => ({}));
}

// What a person is told about a page Honest Archive couldn't use. The server's
// own wording goes in the .error.txt as detail; this is the headline.
const NOT_READABLE = "This page can't be read — scan it again.";
const TOO_BIG = "This page is too big to send — scan it again at a lower resolution.";
const ADDRESS_WRONG = "Honest Archive didn't recognise this upload — check the server address in the Scan Client, then press “Retry failed scans”.";

function plainSkipReason(serverReason) {
  return /MB|too big|too large/i.test(serverReason || "") ? TOO_BIG : NOT_READABLE;
}

/** Per-file reasons from a 422 "Nothing we could use — “a.pdf”: reason; “b.pdf”: reason." */
function reasonsFromDetail(detail) {
  const out = new Map();
  const re = /“([^”]+)”: (.+?)(?=; “|\.?$)/g;
  let m;
  while ((m = re.exec(detail || ""))) out.set(m[1], m[2]);
  return out;
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

/** "Scan…_001_1730812345678.pdf" (a second copy uniqueDest made) -> "Scan…_001.pdf". */
function originalName(name) {
  return name.replace(/_\d{13}(\.[^.]+)$/, "$1");
}

/** Pages in failed/, each counted once, and how many of them a retry can help. */
function refreshFailedCounts(root) {
  const names = failedFiles(root);
  const stuck = new Set();
  for (const r of failedRecords(root)) if (!r.retryable) r.files.forEach((f) => stuck.add(f));
  const all = new Set(names.map(originalName));
  const retry = new Set(names.filter((n) => !stuck.has(n)).map(originalName));
  P.failed = all.size;
  P.retryable = retry.size;
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
  if (kind === "offline") log(`Can't reach Honest Archive at ${apiBaseUrl()} — will keep trying.` + safe, "error");
  else if (kind === "server") log("Honest Archive is having trouble right now — will keep trying." + safe, "error");
  else if (kind === "account") log((P.block && P.block.message) || "Honest Archive didn't accept this computer's sign-in.", "error");
}

function noteConnected() {
  if (!P.trouble) return;
  P.trouble = null;
  const n = P.waiting;
  log("Connected to Honest Archive again" + (n ? ` — sending ${plural(n, "waiting page")}.` : "."), "ok");
}

/** Move pages Honest Archive said no to into failed/, with a note saying why.
 *  kind: "unreadable" (the file itself is bad — retrying can't help),
 *        "address" (404 — wrong server address), "rejected" (anything else). */
function recordRejected(root, label, files, reason, kind, detail) {
  kind = kind || "rejected";
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
      "Kind: " + kind,
      "Retryable: " + (kind === "unreadable" ? "no" : "yes"),
      ...(detail ? ["Honest Archive said: " + detail] : []),
      "",
      kind === "unreadable"
        ? "Retrying won't help — Honest Archive can't use this file. Scan the paper again; once it's in, you can delete the file here."
        : kind === "address"
          ? "Check the server address in the Scan Client (Change, next to the address), then press “Retry failed scans”."
          : "Fix the file (or scan it again) and press “Retry failed scans” in the Scan Client.",
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
    const kind = kindLine ? kindLine[1] : "";
    const network = kindLine
      ? !["rejected", "unreadable", "address"].includes(kind)
      : /HTTP (5\d\d|429|408)\b|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|socket|network|timed? ?out|aborted|terminated/i.test(text);
    const retryable = kind !== "unreadable" && !/^Retryable: no/m.test(text);
    const reasonLine = /^Couldn't send: (.*)$/m.exec(text);
    out.push({ record: path.join(failedDir, n), files, network, retryable, kind,
               reason: reasonLine ? reasonLine[1].trim() : "" });
  }
  return out;
}

/** Move failed pages back into the watch folder so they're sent again. Brother
 *  pages keep their names, so a feed regroups by itself. Pages Honest Archive
 *  couldn't read stay put — sending the same bad file again can't help.
 *  which: "network" (auto-retry), "address" (after the address was fixed), or
 *  anything else for every retryable page. */
function retryFailed(root, which) {
  const failedDir = path.join(root, "failed");
  const records = failedRecords(root);
  let wanted;
  if (which === "network" || which === "address") {
    wanted = new Set();
    for (const r of records) {
      if (which === "network" ? r.network : r.kind === "address") r.files.forEach((f) => wanted.add(f));
    }
  } else {
    const stuck = new Set();
    for (const r of records) if (!r.retryable) r.files.forEach((f) => stuck.add(f));
    wanted = new Set(failedFiles(root).filter((n) => !stuck.has(n)));
  }
  let moved = 0;
  for (const name of wanted) {
    const from = path.join(failedDir, name);
    // Give a second copy its scanner name back so it rejoins its feed.
    let to = path.join(root, originalName(name));
    if (fs.existsSync(to)) to = path.join(root, name);
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

/** What's wrong, in plain words. The website puts its own "N pages couldn't be
 *  sent." in front of the check-in message, so the ping sends only the reason;
 *  the window (withCount) says the count itself. */
function personalProblem(withCount) {
  if (!scanning) return "The Scan Client is paused — press Start watching on the scanner computer.";
  if (P.block && P.block.kind === "account") return P.block.message;
  if (P.trouble === "offline") return "The scanner computer can't reach Honest Archive — it will keep trying.";
  if (P.trouble === "server") return "Honest Archive had trouble receiving scans — the Scan Client keeps trying.";
  if (P.failed > 0) {
    let reason = "";
    if (P.retryable > 0) {
      // The newest reason among pages a retry can help (survives a restart).
      let newest = null;
      for (const r of failedRecords(config.watchDir || "")) {
        if (!r.retryable || !r.reason) continue;
        try {
          const t = fs.statSync(r.record).mtimeMs;
          if (!newest || t > newest.t) newest = { t, reason: r.reason };
        } catch {}
      }
      reason = newest ? newest.reason : (P.lastReject || "");
      if (!reason) reason = "Press “Retry failed scans” on the scanner computer.";
    } else {
      reason = P.failed === 1 ? NOT_READABLE : "These pages can't be read — scan them again.";
    }
    return withCount ? `${plural(P.failed, "page")} couldn't be sent. ${reason}` : reason;
  }
  return null;
}

/** The check-in the website shows on Home and Scans. `retryable` tells it whether
 *  "Retry failed scans" can help the failed pages (false: they have to be scanned
 *  again), or null when nothing has failed. */
function pingBody() {
  return JSON.stringify({
    version: appVersion(),
    waiting: P.waiting,
    failed: P.failed,
    retryable: P.failed > 0 ? P.retryable > 0 : null,
    message: personalProblem(),
  });
}

async function pingPersonal() {
  if (config.accountType !== "personal" || !config.ingestToken) return;
  P.lastPing = Date.now();
  P.pingAt = 0;
  if (config.watchDir) {
    P.waiting = personalInbox(config.watchDir).length;
    refreshFailedCounts(config.watchDir);
  }
  try {
    await personalFetch("/api/v1/personal/scanner/ping", {
      method: "POST",
      headers: { Authorization: "Bearer " + config.ingestToken, "Content-Type": "application/json" },
      body: pingBody(),
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

/** Pages of group g that Honest Archive couldn't use: into failed/, say so once. */
function failPages(root, g, bad, reason, kind, detail) {
  recordRejected(root, g.scanner ? g.key : bad[0].name, bad, reason, kind, detail);
  const what = g.scanner
    ? `${plural(bad.length, "page")} of the ${describeFeed(g.key, bad[0].name)} (${bad.map((f) => f.name).join(", ")})`
    : `“${bad[0].name}”`;
  const where = kind === "unreadable"
    ? "It's in the “failed” folder — retrying won't help."
    : "It's in the “failed” folder.";
  log(`Couldn't send ${what}: ${reason} ${where}`, "error");
  refreshFailedCounts(root);
  // Those pages aren't waiting any more — they're in failed/.
  P.waiting = personalInbox(root).length;
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
    const n = retryFailed(root, "network");
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
  refreshFailedCounts(root);

  // Tell people what the scanner is doing — only when the page count changes.
  for (const g of groups.values()) {
    if (!g.scanner) continue;
    g.files.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
    let feed = P.feeds.get(g.key);
    if (!feed) {
      // Pages of a feed that already finished earlier (a jam cleared, a retry):
      // say "the rest of the scan from …" so it doesn't read like a new scan.
      const desc = describeFeed(g.key, g.files[0].name);
      feed = { desc: P.finished.has(g.key) ? (desc.startsWith("scan") ? "the rest of the " : "the rest of ") + desc : desc,
               total: 0, sent: 0, lastNewAt: now };
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
      const per = P.oneByOne.has(g.key) ? 1 : PAGES_PER_REQUEST;
      for (let i = 0; i < ready.length; i += per) {
        const chunk = ready.slice(i, i + per);
        let reply;
        try {
          reply = await sendPages(g.key, chunk, !g.scanner);
        } catch (e) {
          if (!(e instanceof SendError)) {
            // A file vanished or couldn't be read mid-way — look again next poll.
            continue outer;
          }
          if (e.kind === "rejected") {
            const nothingUsable = e.status === 422 && /^Nothing we could use/.test(e.detail);
            if (!nothingUsable && chunk.length > 1 && e.status !== 404) {
              // Refused as a whole, but we can't tell which page is the problem:
              // send this feed one page at a time so only the bad one fails.
              P.oneByOne.add(g.key);
              continue outer;
            }
            const kind = e.status === 404 ? "address"
              : (e.status === 422 || e.status === 413) ? "unreadable" : "rejected";
            if (nothingUsable) {
              // Every page in this request was unusable; group them by reason.
              const named = reasonsFromDetail(e.detail);
              const byReason = new Map();
              for (const f of chunk) {
                const why = named.has(f.name) ? plainSkipReason(named.get(f.name)) : NOT_READABLE;
                if (!byReason.has(why)) byReason.set(why, []);
                byReason.get(why).push(f);
              }
              for (const [why, bad] of byReason) {
                const detail = bad.map((f) => named.has(f.name) ? `“${f.name}”: ${named.get(f.name)}` : null)
                  .filter(Boolean).join("; ");
                failPages(root, g, bad, why, "unreadable", detail);
              }
            } else {
              failPages(root, g, chunk, e.message, kind, e.detail);
            }
            if (e.status === 404) {
              // Something answered, but not Honest Archive (wrong address): that's
              // not "connected again". The failure line already says what to do.
              P.trouble = null;
            } else {
              noteConnected();
            }
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
        // Sent. Pages the server skipped (damaged, empty, too big) go to failed/
        // with their reason; everything else it took.
        P.block = null;
        P.groupBackoff.delete(g.key);
        const skipped = new Map();
        for (const sk of (reply && Array.isArray(reply.skipped) ? reply.skipped : [])) {
          if (sk && sk.name) skipped.set(String(sk.name), String(sk.reason || ""));
        }
        const bad = chunk.filter((f) => skipped.has(f.name));
        const good = chunk.filter((f) => !skipped.has(f.name));
        if (bad.length) {
          const byReason = new Map();
          for (const f of bad) {
            const why = plainSkipReason(skipped.get(f.name));
            if (!byReason.has(why)) byReason.set(why, []);
            byReason.get(why).push(f);
          }
          for (const [why, list] of byReason) {
            failPages(root, g, list, why, "unreadable",
              list.map((f) => `“${f.name}”: ${skipped.get(f.name)}`).join("; "));
          }
        }
        for (const f of good) {
          try { fs.renameSync(f.full, uniqueDest(processed, f.name)); } catch {}
          P.seen.delete(f.full);
        }
        // Count what's still waiting AFTER the pages moved, then say we're back.
        P.waiting = personalInbox(root).length;
        noteConnected();
        if (good.length) {
          stats.uploaded += good.length;
          stats.lastUpload = new Date().toLocaleString();
        }
        if (g.scanner) {
          const feed = P.feeds.get(g.key);
          // The server answers an all-repeat upload (a re-drop, or a retry of pages
          // it already has) with the feed's already-filed batch: nothing new.
          const repeat = reply && reply.status && !["receiving", "queued"].includes(reply.status);
          if (feed) {
            if (repeat) feed.repeats = (feed.repeats || 0) + good.length;
            else feed.sent += good.length;
            feed.sentAt = Date.now();
          }
        } else if (good.length) {
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
    const cap = feed.desc.charAt(0).toUpperCase() + feed.desc.slice(1);
    if (feed.sent > 0) {
      log(`${cap} (${plural(feed.sent, "page")}) sent — it'll be filed in a minute or two.`, "ok");
    } else if (feed.repeats > 0) {
      log(`${cap}: ${feed.repeats === 1 ? "that page was" : "those pages were"} already sent earlier — nothing new to file.`, "ok");
    }
    if (feed.sent > 0 || feed.repeats > 0) P.finished.add(key);
    P.feeds.delete(key);
  }
  for (const key of P.oneByOne) if (!groups.has(key)) P.oneByOne.delete(key);

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
    title: config.accountType === "personal"
      ? "Choose the folder your scanner saves to"
      : "Choose the folder to watch for invoices",
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
/** Change the server address from the signed-in window, then check it straight
 *  away with a real check-in — so "check the server address" is something a
 *  person can actually do. */
ipcMain.handle("set-server", async (_e, raw) => {
  let addr = String(raw || "").trim();
  if (!addr) return { ok: false, message: "Type the server address first.", state: currentState() };
  if (!/^https?:\/\//i.test(addr)) addr = (/^(localhost|127\.|\[::1\])/i.test(addr) ? "http://" : "https://") + addr;
  try {
    const u = new URL(addr);
    addr = (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return { ok: false, message: "That doesn't look like a web address — it should look like https://example.com.", state: currentState() };
  }
  const personal = config.accountType === "personal";
  const previous = apiBaseUrl();
  const changed = addr !== previous;
  if (!personal) {
    // Shops: unchanged behaviour (save, then check).
    config.apiBase = addr;
    saveConfig(config);
    if (changed) log("Server address changed to " + addr, "info");
  }

  let ok = false;
  let message;
  try {
    // Personal: check the NEW address before saving it, so a typo never replaces
    // an address that works.
    const res = await personalFetch(personal ? "/api/v1/personal/scanner/ping" : "/api/v1/invoices/scan-categories",
      personal
        ? {
            method: "POST",
            headers: { Authorization: "Bearer " + config.ingestToken, "Content-Type": "application/json" },
            body: pingBody(),
          }
        : { headers: { Authorization: "Bearer " + config.ingestToken } },
      PING_TIMEOUT_MS, personal ? addr : undefined);
    // Something else (a website that redirects every path to a page) can answer
    // 200 too; only Honest Archive answers with this.
    const body = await res.json().catch(() => null);
    const real = config.accountType === "personal"
      ? Boolean(body && body.ok === true)
      : Boolean(body && Array.isArray(body.categories));
    if (!real) throw new SendError("not Honest Archive", "rejected", 404);
    ok = true;
    P.lastPing = Date.now();
    message = "Connected — Honest Archive answered at " + addr + ".";
  } catch (e) {
    if (e instanceof SendError && e.kind === "offline") {
      message = `Can't reach ${addr}. Check the address and the internet connection.`;
    } else if (e instanceof SendError && e.status === 404) {
      message = `Something answered at ${addr}, but it isn't Honest Archive. Check the address.`;
    } else if (e instanceof SendError && e.kind === "account") {
      message = e.message;
    } else {
      message = personal
        ? `Honest Archive at ${addr} is having trouble right now. Try again in a few minutes.`
        : `Honest Archive at ${addr} is having trouble right now — the Scan Client will keep trying.`;
    }
    if (personal) message += ` The address is still ${previous}.`;
  }
  if (ok && personal) {
    config.apiBase = addr;
    saveConfig(config);
    if (changed) log("Server address changed to " + addr, "info");
  }
  if (ok) {
    // Everything that was waiting on the address goes now.
    P.block = null;
    P.groupBackoff.clear();
    noteConnected();
    if (config.accountType === "personal" && config.watchDir) {
      const n = retryFailed(config.watchDir, "address");
      refreshFailedCounts(config.watchDir);
      if (n) {
        log(`Sending ${plural(n, "page")} again that couldn't be sent because of the server address.`, "ok");
        message += ` Sending ${plural(n, "page")} again that ${n === 1 ? "was" : "were"} waiting on the address.`;
      }
    } else {
      await refreshCategories();
    }
  }
  log(message, ok ? "ok" : "error");
  pushState();
  return { ok, message, state: currentState() };
});

ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));
ipcMain.handle("retry-failed", () => {
  if (config.accountType !== "personal" || !config.watchDir) return currentState();
  const n = retryFailed(config.watchDir, "all");
  refreshFailedCounts(config.watchDir);
  if (n) {
    log(`Moved ${plural(n, "page")} back — sending ${n === 1 ? "it" : "them"} again.`, "ok");
  } else if (P.failed > 0) {
    log(P.failed === 1
      ? "Nothing to retry. " + NOT_READABLE
      : `Nothing to retry. ${plural(P.failed, "page")} can't be read — scan them again.`, "info");
  } else {
    log("There was nothing to retry.", "info");
  }
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
