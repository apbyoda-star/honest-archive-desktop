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
    shopName: accountName(),
    email: config.email || "",
    watchDir: config.watchDir || "",
    scanning,
    // Personal: "Failed" is the pages sitting in failed/ right now (each counted
    // once), not how many upload attempts went wrong this session.
    stats: config.accountType === "personal" ? { ...stats, failed: P.failed } : stats,
    folders: config.accountType === "personal" ? [] : folderStatuses(),
    privateDocsEnabled,
    // "personal" or "shop" — or null while it isn't known yet (signed out, or a
    // config saved before account types existed and not yet checked with the
    // server). The window keeps its wording neutral until it's known, so a
    // Personal account never sees shop (parts-invoice) wording, even briefly.
    accountType: knownAccountType(),
    // Honest Archive Personal only: what's waiting, what failed, and whether the
    // server can be reached — the window shows an attention state from these.
    personal: config.accountType === "personal" ? {
      waiting: P.waiting,
      failed: P.failed,
      retryable: P.retryable,
      // ...of which are waiting on a wrong server address: "Retry" can't help
      // those (same address, same failure) — "Change address" can.
      addressFailed: P.addressFailed,
      // ...and of the ones a retry can't help, how many are a kind of file
      // Honest Archive can't read (an iPhone .HEIC photo) rather than a bad scan.
      unsupported: P.unsupported,
      trouble: P.trouble,
      problem: P.trouble || P.failed ? personalProblem(true) : null,
    } : null,
  };
}

function knownAccountType() {
  const t = config.accountType;
  return t === "personal" || t === "shop" ? t : null;
}

/**
 * A config saved before account types existed has a sign-in but no type. Ask the
 * server which it is (the Personal check-in answers only for Personal accounts)
 * and remember it. Until it's known the window stays neutral; uploads keep the
 * old (shop) behaviour, exactly as before, if the server can't be asked.
 * Returns the type, or null if it couldn't be decided this time.
 */
let accountTypeCheck = null;
async function resolveAccountType() {
  if (knownAccountType() || !config.ingestToken) return knownAccountType();
  if (accountTypeCheck) return accountTypeCheck;
  accountTypeCheck = (async () => {
    let type = null;
    try {
      const res = await fetch(apiBaseUrl() + "/api/v1/personal/scanner/ping", {
        method: "POST",
        headers: { Authorization: "Bearer " + config.ingestToken, "Content-Type": "application/json" },
        body: JSON.stringify({ version: appVersion() }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.ok === true) type = "personal";
      else if (res.status === 404 && body && /isn't an Honest Archive Personal account/i.test(String(body.detail || ""))) type = "shop";
    } catch {}
    if (type && !knownAccountType()) {
      config.accountType = type;
      saveConfig(config);
      pushState();
    }
    return knownAccountType();
  })();
  try { return await accountTypeCheck; } finally { accountTypeCheck = null; }
}

/** What the window's header calls the account. Personal: the archive's own name
 *  ("Walter Henderson's Archive"), never the old "your archive" placeholder. */
function accountName() {
  const name = config.shopName || "";
  if (config.accountType === "personal" && (!name || /^your archive$/i.test(name))) return config.email || "";
  return name;
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
  if (!config.ingestToken) return;
  if (!knownAccountType()) await resolveAccountType();
  if (config.accountType === "personal") return;
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

/**
 * A server address as typed ("localhost:8000", "honestarchive.example.com/") made
 * into one the app can use: http:// added for this computer (localhost, 127.x,
 * [::1]), https:// for anything else, trailing slashes dropped. The sign-in screen
 * and "Change address" both use this, so an address that works in one works in
 * the other. Returns { addr, schemeAdded } or { error }.
 */
function normalizeAddress(raw) {
  let addr = String(raw || "").trim();
  if (!addr) return { error: "Type the server address first." };
  const schemeAdded = !/^https?:\/\//i.test(addr);
  if (schemeAdded) addr = (/^(localhost(?=[:/]|$)|127\.|\[::1\])/i.test(addr) ? "http://" : "https://") + addr;
  try {
    const u = new URL(addr);
    if (!u.hostname) throw new Error("no host");
    addr = (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return { error: "That doesn't look like a web address — it should look like https://example.com." };
  }
  return { addr, schemeAdded };
}

// ---- Backend calls ---------------------------------------------------------
async function apiLogin(apiBase, email, password) {
  let base = DEFAULT_API_BASE;
  let schemeAdded = false;
  if (String(apiBase || "").trim()) {
    const n = normalizeAddress(apiBase);
    if (n.error) throw new Error(n.error);
    base = n.addr;
    schemeAdded = n.schemeAdded;
  }
  // Typed without http(s)://: say which address was actually tried, and what a
  // full one looks like — not just "check the internet connection".
  const unreachable = () => new Error(schemeAdded
    ? `Can't reach Honest Archive at ${base} (“${String(apiBase).trim()}” with ${base.startsWith("https:") ? "https://" : "http://"} added). Check the server address — it should look like https://example.com — and the internet connection.`
    : `Can't reach Honest Archive at ${base}. Check the server address and the internet connection.`);
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
    shopName: stBody.shop_name
      || (personal && body.user && body.user.full_name ? `${body.user.full_name}'s Archive` : ""),
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
// A page is ready once its size AND modified time have both stayed the same for
// this long (a Wi-Fi / network-folder scan can pause for a few seconds mid-write)
// and, for a PDF, it ends with the %%EOF marker every finished PDF ends with.
const STABLE_MS = 5000;
// A PDF that never gets its %%EOF (a scanner that writes odd PDFs) is sent anyway
// once it hasn't changed for this long — Honest Archive then decides.
const PDF_NO_EOF_MS = 120000;
// Files people drop in the scanner folder that Honest Archive can't read. Only
// these are moved to failed/ with a note — anything else (a scanner's own
// temporary file, say) is left alone.
const UNSUPPORTED = [".heic", ".heif", ".webp", ".gif", ".avif", ".dng",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pages", ".numbers", ".key",
  ".rtf", ".odt", ".zip", ".mov", ".mp4", ".m4v"];
const FAILED_EXTS = [...SUPPORTED, ...UNSUPPORTED];
const FEED_QUIET_MS = 65000;             // matches the server's 60s settle (+ a little)
const PING_MS = 5 * 60 * 1000;
const AUTO_RETRY_MS = 60 * 60 * 1000;
const BACKOFF_MS = [30e3, 60e3, 120e3, 240e3, 480e3, 600e3];
const UPLOAD_TIMEOUT_MS = 120000;
const PING_TIMEOUT_MS = 15000;

const P = {
  seen: new Map(),        // full path -> {size, mtime, since} (since: first look at this size+mtime)
  feeds: new Map(),       // feed key -> {desc, total, sent, lastNewAt}
  groupBackoff: new Map(),// feed key -> {attempts, nextAt}  (server hiccups for one feed)
  block: null,            // {kind, attempts, nextAt, since}  (can't reach / sign-in refused)
  trouble: null,          // what was last logged about the connection, so it's said ONCE
  lastReject: "",         // plain-words reason for the newest file moved to failed/
  waiting: 0,
  failed: 0,              // unique pages in failed/
  retryable: 0,           // ...of which aren't unreadable (the website's "retry can help")
  addressFailed: 0,       // ...of which failed because of the server address (fixed by Change, not Retry)
  unsupported: 0,         // pages in failed/ that are a kind of file Honest Archive can't read (.HEIC…)
  oneByOne: new Set(),    // feed keys whose pages go up singly (a multi-page request was refused whole)
  finished: new Set(),    // feed keys already reported as sent this session (more pages = "the rest of")
  addressLogged: new Set(),// feed keys already reported as failing because of the server address
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
  for (const f of files) {
    const data = fs.readFileSync(f.full);
    // The file changed between "it's finished" and reading it (the scanner
    // started writing again): don't send half a page — look again next time.
    if (data.length !== f.size || (f.needEof && !hasPdfEof(data))) {
      throw new Error("still being written: " + f.name);
    }
    form.append("files", new Blob([data]), f.name);
  }
  form.append("batch_key", key);
  form.append("complete", complete ? "true" : "false");
  const res = await personalFetch("/api/v1/personal/scans", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.ingestToken },
    body: form,
  }, UPLOAD_TIMEOUT_MS);
  return res.json().catch(() => ({}));
}

/** A finished PDF ends with "%%EOF" (plus maybe a line ending) in its last bytes. */
function hasPdfEof(buf) {
  const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString("latin1");
  return tail.includes("%%EOF");
}

/** Read the last 1KB of a file and check it for %%EOF. */
function pdfFileComplete(full, size) {
  let fd;
  try {
    fd = fs.openSync(full, "r");
    const len = Math.min(1024, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
    return hasPdfEof(buf);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** True when the file on disk is no longer the one we read (it grew or was
 *  rewritten), i.e. it was still being written when it was sent. */
function changedSinceRead(f) {
  try {
    const st = fs.statSync(f.full);
    return st.size !== f.size || st.mtimeMs !== f.mtime;
  } catch {
    return false;
  }
}

/** What to say about a kind of file Honest Archive can't read. */
function unsupportedReason(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".heic" || ext === ".heif") return "iPhone photos (.HEIC) can't be read yet — save it as JPG or PDF.";
  return `Honest Archive can't read ${ext ? ext.slice(1).toUpperCase() + " files" : "this kind of file"} — save it as PDF or JPG.`;
}

// What a person is told about a page Honest Archive couldn't use. The server's
// own wording goes in the .error.txt as detail; this is the headline.
const NOT_READABLE = "This page can't be read — scan it again.";
const TOO_BIG = "This page is too big to send — scan it again at a lower resolution.";
// The Activity line (said once per feed). The window's status line says only
// that the address looks wrong; the box under it carries the one instruction.
const ADDRESS_WRONG = "Honest Archive didn't recognize this upload — the server address looks wrong. Press “Change address”, fix it and press “Save and check”; the pages are sent again as soon as it's right.";
// The same problem as the website shows it (the person reading it isn't at the
// scanner computer, so "above" means nothing there).
const ADDRESS_WRONG_SITE = "The server address on the scanner computer looks wrong — fix it in the Scan Client there (press “Change address”).";
// ...and as the headline of the .error.txt note in failed/ (a text file has no "above").
const ADDRESS_WRONG_FILE = "Honest Archive didn't recognize this upload — the server address in the Scan Client looks wrong.";

/** The "Couldn't send:" headline written into a failed/ note. */
function noteHeadline(reason, kind, n) {
  return kind === "address" ? ADDRESS_WRONG_FILE : pluralReason(reason, n);
}

/** Kinds of failure a retry can't help. */
function notRetryable(kind) {
  return kind === "unreadable" || kind === "unsupported";
}

function plainSkipReason(serverReason) {
  return /MB|too big|too large/i.test(serverReason || "") ? TOO_BIG : NOT_READABLE;
}

/** The headline for n pages: "This page can't…" vs "These pages can't…". */
function pluralReason(reason, n) {
  if (n <= 1) return reason;
  if (reason === NOT_READABLE) return "These pages can't be read — scan them again.";
  if (reason === TOO_BIG) return "These pages are too big to send — scan them again at a lower resolution.";
  return reason;
}

/** "2–3", "2, 4 and 7", "2–3 and 6" for sorted unique page numbers. */
function pageRanges(nums) {
  const runs = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  const parts = runs.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`));
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
}

/**
 * Which papers these failed pages belong to, in words a person can act on:
 * "Pages 2–3 of the scan from Nov 4, 4:40 PM", "“receipt photo.jpg”".
 * Returns { text, papers } (papers = how many separate scans/files), or null.
 */
function describeFailedPages(names) {
  const feeds = new Map();
  const loose = [];
  for (const raw of names) {
    const name = originalName(raw);
    const b = batchKeyFor(name);
    if (!b) { if (!loose.includes(name)) loose.push(name); continue; }
    if (!feeds.has(b.key)) feeds.set(b.key, { key: b.key, first: name, seqs: new Set() });
    feeds.get(b.key).seqs.add(b.seq);
  }
  const parts = [];
  for (const f of [...feeds.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const seqs = [...f.seqs].sort((a, b) => a - b);
    parts.push(`${seqs.length === 1 ? "page" : "pages"} ${pageRanges(seqs)} of the ${describeFeed(f.key, f.first)}`);
  }
  for (const n of loose) parts.push(`“${n}”`);
  if (!parts.length) return null;
  const MAX = 2;
  let text;
  if (parts.length <= MAX) text = parts.join(" and ");
  else text = parts.slice(0, MAX).join(", ") + ` and ${plural(parts.length - MAX, "more paper")}`;
  return { text: text.charAt(0).toUpperCase() + text.slice(1), papers: parts.length };
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
function personalInbox(root, exts) {
  exts = exts || SUPPORTED;
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
      if (!exts.includes(path.extname(name).toLowerCase())) continue;
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
      .filter((n) => !n.startsWith(".") && !n.endsWith(".error.txt") && FAILED_EXTS.includes(path.extname(n).toLowerCase()));
  } catch {
    return [];
  }
}

/** "Scan…_001_1730812345678.pdf" (a second copy uniqueDest made) -> "Scan…_001.pdf". */
function originalName(name) {
  return name.replace(/_\d{13}(\.[^.]+)$/, "$1");
}

/** Pages in failed/, each counted once, how many of them aren't unreadable, and
 *  how many of those are waiting on the server address. */
function refreshFailedCounts(root) {
  const names = failedFiles(root);
  const stuck = new Set();
  const address = new Set();
  const unsupported = new Set();
  for (const r of failedRecords(root)) {
    if (!r.retryable) r.files.forEach((f) => stuck.add(f));
    else if (r.kind === "address") r.files.forEach((f) => address.add(f));
    if (r.kind === "unsupported") r.files.forEach((f) => unsupported.add(f));
  }
  const all = new Set(names.map(originalName));
  const retry = new Set(names.filter((n) => !stuck.has(n)).map(originalName));
  const addr = new Set(names.filter((n) => !stuck.has(n) && address.has(n)).map(originalName));
  P.failed = all.size;
  P.retryable = retry.size;
  P.addressFailed = addr.size;
  P.unsupported = new Set(names.filter((n) => unsupported.has(n)).map(originalName)).size;
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
  const sizes = [];
  for (const f of files) {
    try {
      if (!fs.existsSync(f.full)) continue;
      const dest = uniqueDest(failedDir, f.name);
      fs.renameSync(f.full, dest);
      moved.push(path.basename(dest));
      // What the file looked like when it was judged: if it changes afterwards
      // (the scanner was still writing it), it's sent again by itself.
      const st = fs.statSync(dest);
      sizes.push(`${path.basename(dest)}=${st.size}@${Math.round(st.mtimeMs)}`);
    } catch {}
    P.seen.delete(f.full);
  }
  if (!moved.length) return;
  const safeLabel = String(label).replace(/[^\w.\- ]+/g, "_").slice(0, 80);
  let errPath = path.join(failedDir, safeLabel + ".error.txt");
  // More pages of the same feed failing the same way (pages become ready one poll
  // at a time) join the feed's existing record, so a 30-page feed sent to a wrong
  // address is one record, not 30.
  let allFiles = moved;
  let allSizes = sizes;
  let details = detail ? [detail] : [];
  if (fs.existsSync(errPath)) {
    let prev = "";
    try { prev = fs.readFileSync(errPath, "utf-8"); } catch {}
    const pk = /^Kind: (\w+)/m.exec(prev);
    const pr = /^Couldn't send: (.*)$/m.exec(prev);
    const pf = /^Files: (.*)$/m.exec(prev);
    const pd = /^Honest Archive said: (.*)$/m.exec(prev);
    const ps = /^Sizes: (.*)$/m.exec(prev);
    const sameReason = pr && [reason, pluralReason(reason, 2), noteHeadline(reason, kind, 1), noteHeadline(reason, kind, 2)]
      .includes(pr[1].trim());
    if (pk && pk[1] === kind && sameReason && pf) {
      const old = pf[1].split(",").map((x) => x.trim()).filter(Boolean);
      allFiles = [...old, ...moved.filter((m) => !old.includes(m))];
      if (ps) allSizes = [...ps[1].split(",").map((x) => x.trim()).filter(Boolean), ...sizes];
      if (pd && pd[1].trim() && !details.includes(pd[1].trim())) details = [pd[1].trim(), ...details];
    } else {
      errPath = path.join(failedDir, `${safeLabel}_${Date.now()}.error.txt`);
    }
  }
  writeRecord(errPath, { headline: noteHeadline(reason, kind, allFiles.length), files: allFiles,
                         sizes: allSizes, kind, details });
  stats.failed += moved.length;
  P.lastReject = reason;
}

/** Write a failed/ note. */
function writeRecord(errPath, { headline, when, files, sizes, kind, details }) {
  try {
    fs.writeFileSync(errPath, [
      "Couldn't send: " + headline,
      "When: " + (when || new Date().toLocaleString()),
      "Files: " + files.join(", "),
      "Kind: " + kind,
      "Retryable: " + (notRetryable(kind) ? "no" : "yes"),
      ...(sizes && sizes.length ? ["Sizes: " + sizes.join(", ")] : []),
      ...(details && details.length ? ["Honest Archive said: " + details.join("; ")] : []),
      "",
      kind === "unreadable"
        ? "Retrying won't help — Honest Archive can't use this file. Scan the paper again, then press “Clear these” in the Scan Client (or delete the file here)."
        : kind === "unsupported"
          ? "Honest Archive can't read this kind of file yet. Save it as JPG or PDF and put that copy in the scanner folder, then press “Clear these” in the Scan Client (or delete the file here)."
          : kind === "address"
            ? "Fix the server address in the Scan Client window (press “Change address”). These pages are sent again automatically once it's right."
            : "Fix the file (or scan it again) and press “Retry failed scans” in the Scan Client.",
      "",
    ].join("\n"));
  } catch {}
}

/**
 * A page judged unreadable that kept changing afterwards was still being written
 * when it was sent (a network scan that paused mid-page). The finished file may be
 * fine: put it back in the scanner folder so it's sent again, and drop it from
 * its note. Returns the names put back.
 */
function resendGrownPages(root) {
  const failedDir = path.join(root, "failed");
  const back = [];
  for (const r of failedRecords(root)) {
    if (r.kind !== "unreadable" || !r.sizes.size) continue;
    const keep = [];
    for (const f of r.files) {
      const was = r.sizes.get(f);
      const from = path.join(failedDir, f);
      let st = null;
      try { st = fs.statSync(from); } catch {}
      const grew = was && st && (st.size !== was.size || Math.round(st.mtimeMs) !== was.mtime);
      if (!grew) { keep.push(f); continue; }
      let to = path.join(root, originalName(f));
      if (fs.existsSync(to)) to = path.join(root, f);
      try {
        if (fs.existsSync(to)) { keep.push(f); continue; }
        fs.renameSync(from, to);
        back.push(originalName(f));
      } catch { keep.push(f); }
    }
    if (keep.length === r.files.length) continue;
    if (!keep.length) {
      try { fs.unlinkSync(r.record); } catch {}
    } else {
      let text = "";
      try { text = fs.readFileSync(r.record, "utf-8"); } catch {}
      const when = (/^When: (.*)$/m.exec(text) || [])[1];
      const said = (/^Honest Archive said: (.*)$/m.exec(text) || [])[1];
      writeRecord(r.record, {
        headline: pluralReason(NOT_READABLE, keep.length), when, files: keep, kind: r.kind,
        sizes: keep.filter((f) => r.sizes.has(f)).map((f) => `${f}=${r.sizes.get(f).size}@${r.sizes.get(f).mtime}`),
        details: said ? [said] : [],
      });
    }
  }
  return back;
}

/** Error records in failed/ and the files each one covers. Older versions wrote
 *  records without a Files: line — work the files out from the record's name. */
function failedRecords(root) {
  const failedDir = path.join(root, "failed");
  let names = [];
  try { names = fs.readdirSync(failedDir); } catch { return []; }
  const pages = names.filter((n) => FAILED_EXTS.includes(path.extname(n).toLowerCase()));
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
      ? !["rejected", "unreadable", "address", "unsupported"].includes(kind)
      : /HTTP (5\d\d|429|408)\b|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|socket|network|timed? ?out|aborted|terminated/i.test(text);
    const retryable = !notRetryable(kind) && !/^Retryable: no/m.test(text);
    const reasonLine = /^Couldn't send: (.*)$/m.exec(text);
    const sizes = new Map();
    const sl = /^Sizes: (.*)$/m.exec(text);
    if (sl) {
      for (const part of sl[1].split(",")) {
        const m = /^(.+)=(\d+)@(\d+)$/.exec(part.trim());
        if (m) sizes.set(m[1], { size: +m[2], mtime: +m[3] });
      }
    }
    out.push({ record: path.join(failedDir, n), files, network, retryable, kind, sizes,
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
    // Pages waiting on the server address stay too: sent to the same address
    // they'd just fail again. Fixing the address (Save and check) sends them.
    const stuck = new Set();
    for (const r of records) if (!r.retryable || r.kind === "address") r.files.forEach((f) => stuck.add(f));
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
    P.addressLogged.clear();
    P.groupBackoff.clear();
    if (P.block) P.block.nextAt = 0;
  }
  return moved;
}

/** What's wrong, in plain words. The website puts its own "N pages couldn't be
 *  sent." in front of the check-in message, so the ping sends only the reason;
 *  the window (withCount) says the count itself — and, when Honest Archive can't
 *  be reached, still says what's waiting and which pages failed. */
function personalProblem(withCount) {
  if (!scanning) return "The Scan Client is paused — press Start watching on the scanner computer.";
  if (P.block && P.block.kind === "account") return P.block.message;
  if (P.trouble === "offline" || P.trouble === "server") {
    if (!withCount) {
      return P.trouble === "offline"
        ? "The scanner computer can't reach Honest Archive — it will keep trying."
        : "Honest Archive had trouble receiving scans — the Scan Client keeps trying.";
    }
    const n = P.waiting;
    const safe = n ? ` ${plural(n, "page")} ${n === 1 ? "is" : "are"} waiting safely in the folder.` : "";
    const head = P.trouble === "offline"
      ? `Can't reach Honest Archive at ${apiBaseUrl()} — will keep trying.`
      : "Honest Archive is having trouble right now — will keep trying.";
    const failed = failedProblem(true);
    return head + safe + (failed ? " " + failed : "");
  }
  return failedProblem(withCount);
}

/** The failed/ part of personalProblem, or null when nothing has failed. */
function failedProblem(withCount) {
  if (!(P.failed > 0)) return null;
  const root = config.watchDir || "";
  const records = failedRecords(root);
  let retryPart = "";
  if (P.retryable > 0) {
    // The newest reason among pages a retry can help (survives a restart).
    let newest = null;
    for (const r of records) {
      if (!r.retryable || !r.reason) continue;
      try {
        const t = fs.statSync(r.record).mtimeMs;
        if (!newest || t > newest.t) newest = { t, reason: r.reason, kind: r.kind };
      } catch {}
    }
    let retryReason = newest ? newest.reason : (P.lastReject || "");
    // The note's headline is written for a text file; the window and the
    // website each have their own wording for a wrong address.
    const address = (newest && newest.kind === "address") || retryReason === ADDRESS_WRONG_FILE || retryReason === ADDRESS_WRONG;
    if (address) {
      // Window: just what's wrong — the box below names the button, once.
      retryPart = withCount
        ? `${plural(P.retryable, "page")} couldn't be sent — the server address looks wrong.`
        : ADDRESS_WRONG_SITE;
    } else {
      if (!retryReason) retryReason = "Press “Retry failed scans” on the scanner computer.";
      retryPart = (withCount ? `${plural(P.retryable, "page")} couldn't be sent. ` : "") + retryReason;
    }
  }
  // Pages a retry can't help: say WHICH papers to scan again, and which files
  // are a kind Honest Archive can't read (an iPhone .HEIC photo).
  let stuckPart = "";
  if (P.failed > P.retryable) {
    const inFailed = new Set(failedFiles(root));
    const unreadable = new Set();
    const unsupported = new Map();  // reason -> [names]
    for (const r of records) {
      if (r.retryable) continue;
      for (const f of r.files) {
        if (!inFailed.has(f)) continue;
        if (r.kind === "unsupported") {
          const why = unsupportedReason(f);
          if (!unsupported.has(why)) unsupported.set(why, []);
          if (!unsupported.get(why).includes(originalName(f))) unsupported.get(why).push(originalName(f));
        } else {
          unreadable.add(f);
        }
      }
    }
    const parts = [];
    if (unreadable.size) {
      const d = describeFailedPages([...unreadable]);
      parts.push(d
        ? `${d.text} can't be read — scan ${d.papers === 1 ? "that paper" : "those papers"} again.`
        : (unreadable.size === 1 ? NOT_READABLE : "These pages can't be read — scan them again."));
    }
    for (const [why, names] of unsupported) {
      const list = names.length <= 2 ? names.map((x) => `“${x}”`).join(" and ")
        : `“${names[0]}” and ${plural(names.length - 1, "more file")}`;
      parts.push(`${list}: ${names.length === 1 ? why : why.replace("save it as", "save them as")}`);
    }
    if (!parts.length) {
      parts.push(P.failed - P.retryable === 1 ? NOT_READABLE : "These pages can't be read — scan them again.");
    }
    stuckPart = parts.join(" ");
  }
  return [retryPart, stuckPart].filter(Boolean).join(" ") || null;
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
  if (kind !== "address") {
    // A page that changed after it was read was still being written: what Honest
    // Archive saw was half a page. Don't call it unreadable — send it again once
    // it's finished.
    const still = bad.filter(changedSinceRead);
    for (const f of still) P.seen.delete(f.full);
    bad = bad.filter((f) => !still.includes(f));
    if (!bad.length) return;
  }
  const label = g.scanner ? g.key : bad[0].name;
  recordRejected(root, label, bad, reason, kind, detail);
  if (kind === "address") {
    // Wrong address: every page of the feed fails the same way as it becomes
    // ready. Say it once per feed; later pages quietly join the same record.
    if (!P.addressLogged.has(label)) {
      P.addressLogged.add(label);
      const what = g.scanner ? `the ${describeFeed(g.key, bad[0].name)}` : `“${bad[0].name}”`;
      log(`Couldn't send ${what}: ${reason} Until then its pages wait in the “failed” folder.`, "error");
    }
  } else {
    const n = bad.length;
    const what = g.scanner
      ? `${plural(n, "page")} of the ${describeFeed(g.key, bad[0].name)} (${bad.map((f) => f.name).join(", ")})`
      : `“${bad[0].name}”`;
    const it = n === 1 ? "It's" : "They're";
    const where = kind === "unreadable"
      ? `${it} in the “failed” folder — retrying won't help.`
      : `${it} in the “failed” folder.`;
    log(`Couldn't send ${what}: ${pluralReason(reason, n)} ${where}`, "error");
  }
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

  // A page judged unreadable that kept growing in failed/ was still being written
  // when it was sent: put it back so the finished page is sent.
  const grown = resendGrownPages(root);
  if (grown.length) {
    const d = describeFailedPages(grown);
    log(`${d ? d.text : plural(grown.length, "page")} ${grown.length === 1 ? "was" : "were"} still being saved when ${grown.length === 1 ? "it was" : "they were"} sent — sending the finished ${grown.length === 1 ? "page" : "pages"} again.`, "info");
  }

  const files = personalInbox(root);
  const strays = personalInbox(root, UNSUPPORTED);
  const present = new Set([...files, ...strays].map((f) => f.full));
  for (const k of P.seen.keys()) if (!present.has(k)) P.seen.delete(k);

  /** Ready = size AND modified time unchanged for STABLE_MS (seen across looks,
   *  and by the clock), and for a PDF its %%EOF has arrived. */
  const markReady = (f) => {
    const prev = P.seen.get(f.full);
    const same = Boolean(prev && prev.size === f.size && prev.mtime === f.mtime);
    const since = same ? prev.since : now;
    P.seen.set(f.full, { size: f.size, mtime: f.mtime, since });
    f.ready = same && now - since >= STABLE_MS && now - f.mtime >= STABLE_MS;
    // A PDF must also be checked for its %%EOF again when it's read to send.
    f.needEof = path.extname(f.name).toLowerCase() === ".pdf";
    if (f.ready && f.needEof && !pdfFileComplete(f.full, f.size)) {
      // Still being written (a network scan that paused mid-page) — wait for the
      // end of the file; only a PDF that never gets one is sent as it is.
      f.ready = now - since >= PDF_NO_EOF_MS;
      f.needEof = false;
    }
  };

  // Files Honest Archive can't read (an iPhone .HEIC photo): say so once, plainly,
  // and move them to failed/ — they'd otherwise sit here forever, unmentioned.
  for (const f of strays) {
    markReady(f);
    if (!f.ready) continue;
    const why = unsupportedReason(f.name);
    recordRejected(root, f.name, [f], why, "unsupported");
    log(`“${f.name}”: ${why} It's in the “failed” folder.`, "error");
    refreshFailedCounts(root);
    pingSoon();
    pushState();
  }

  // Group into feeds; a page is ready once the scanner has finished writing it.
  const groups = new Map();
  for (const f of files) {
    markReady(f);
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
            // A file vanished, couldn't be read, or was still being written — wait
            // for it to settle again and look next poll.
            for (const f of chunk) P.seen.delete(f.full);
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
          log(`Sent “${chunk[0].name}” — it'll be filed shortly. You'll see it under Scans in Honest Archive.`, "ok");
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
      log(`${cap} (${plural(feed.sent, "page")}) sent — it'll be filed shortly. You'll see it under Scans in Honest Archive.`, "ok");
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
    title: knownAccountType() === "shop"
      ? "Choose the folder to watch for invoices"
      : "Choose the folder your scanner saves to",
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
  const norm = normalizeAddress(raw);
  if (norm.error) return { ok: false, message: norm.error, state: currentState() };
  const addr = norm.addr;
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
    // Said as part of the one "Connected" line below, not as a line of its own.
    if (changed) message = `Server address changed to ${addr}. Connected — Honest Archive answered there.`;
  }
  if (ok) {
    // Everything that was waiting on the address goes now.
    P.block = null;
    P.groupBackoff.clear();
    // The message below is the one "Connected" line: clear the trouble quietly
    // rather than letting noteConnected() log "Connected … again" as well.
    // (Shops never set P.trouble, so this changes nothing for them.)
    P.trouble = null;
    if (config.accountType === "personal" && config.watchDir) {
      const before = personalInbox(config.watchDir).length;
      const n = retryFailed(config.watchDir, "address");
      refreshFailedCounts(config.watchDir);
      // The pages just moved back are waiting again, along with any that were
      // waiting in the folder while Honest Archive couldn't be reached.
      P.waiting = personalInbox(config.watchDir).length;
      const parts = [];
      if (n) parts.push(`${plural(n, "page")} again that ${n === 1 ? "was" : "were"} waiting on the address`);
      if (before) parts.push(`${plural(before, "waiting page")}${n ? "" : " from the folder"}`);
      if (parts.length) message += ` Sending ${parts.join(" and ")}.`;
    } else {
      await refreshCategories();
    }
  }
  log(message, ok ? "ok" : "error");
  pushState();
  return { ok, message, state: currentState() };
});

ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));
/** Pages Honest Archive can't read, after the paper has been scanned again: move
 *  them (and their notes) to failed/cleared/ so the warning goes away here and,
 *  with the next check-in, on the website. Nothing is deleted. */
ipcMain.handle("clear-failed", async () => {
  if (config.accountType !== "personal" || !config.watchDir) return currentState();
  const root = config.watchDir;
  const failedDir = path.join(root, "failed");
  const clearedDir = path.join(failedDir, "cleared");
  let n = 0;
  for (const r of failedRecords(root)) {
    if (r.retryable) continue;
    try { fs.mkdirSync(clearedDir, { recursive: true }); } catch {}
    for (const f of r.files) {
      const from = path.join(failedDir, f);
      try {
        if (!fs.existsSync(from)) continue;
        fs.renameSync(from, uniqueDest(clearedDir, f));
        n += 1;
      } catch {}
    }
    try { fs.renameSync(r.record, uniqueDest(clearedDir, path.basename(r.record))); } catch {}
  }
  refreshFailedCounts(root);
  if (n) log(`Cleared ${plural(n, "page")} Honest Archive couldn't read — moved to failed/cleared in case you need ${n === 1 ? "it" : "them"}.`, "ok");
  else log("There were no unreadable pages to clear.", "info");
  // Tell the website now, so its warning goes away without waiting 5 minutes.
  await pingPersonal();
  pushState();
  return currentState();
});

ipcMain.handle("open-failed-folder", async () => {
  if (!config.watchDir) return currentState();
  const dir = path.join(config.watchDir, "failed");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const err = await shell.openPath(dir);
  if (err) log(`Couldn't open the failed folder: ${err}`, "error");
  return currentState();
});

ipcMain.handle("retry-failed", () => {
  if (config.accountType !== "personal" || !config.watchDir) return currentState();
  const n = retryFailed(config.watchDir, "all");
  refreshFailedCounts(config.watchDir);
  if (n) {
    log(`Moved ${plural(n, "page")} back — sending ${n === 1 ? "it" : "them"} again.`, "ok");
  } else if (P.addressFailed > 0) {
    log(`Nothing to retry yet — ${plural(P.addressFailed, "page")} ${P.addressFailed === 1 ? "is" : "are"} waiting on the server address. `
      + "Press “Change address”, fix it and press “Save and check”; they're sent again as soon as it's right.", "info");
  } else if (P.failed > 0) {
    // Only pages a retry can't help: say what each needs (scan it again / save
    // it as JPG or PDF), then "Clear these".
    log("Nothing to retry. " + (failedProblem(false) || NOT_READABLE)
      + ` Once that's done, press “Clear these”.`, "info");
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
    // Resume watching automatically if it was configured before — once the
    // account type is known (an old config is checked with the server first;
    // if it can't be reached, watching starts the way it always did).
    if (config.ingestToken && config.watchDir) {
      resolveAccountType().finally(() => startWatching());
    } else if (config.ingestToken) {
      resolveAccountType();
    }
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
