const $ = (id) => document.getElementById(id);

/** Errors thrown in the main process reach us as "Error invoking remote method
 *  'login': Error: <what we said>". Only the last part is meant for people. */
function friendlyError(e, fallback) {
  const msg = String((e && e.message) || e || "")
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/, "")
    .trim();
  return msg || fallback || "Something went wrong.";
}

function show(view) {
  $("login").classList.toggle("hidden", view !== "login");
  $("main").classList.toggle("hidden", view !== "main");
}

/**
 * What each subfolder will actually do with a scan.
 *
 * Without this the only way to find out a folder is misspelled — or that the
 * category was never created — is to scan documents into it and go looking in the
 * web app. For private paperwork that is exactly the wrong time to find out.
 */
function renderFolders(state) {
  const wrap = $("folderStatusWrap");
  const list = $("folderStatus");
  if (!wrap || !list) return;
  const folders = state.folders || [];
  const personal = state.accountType === "personal";
  if ($("personalHelp")) $("personalHelp").hidden = !personal;
  if ($("shopFolderHelp")) $("shopFolderHelp").hidden = personal;
  if ($("shopReqs")) $("shopReqs").hidden = personal;
  if (!state.watchDir) { wrap.hidden = true; return; }
  wrap.hidden = false;

  if (folders.length === 0) {
    list.innerHTML =
      '<li class="fs-none">No subfolders yet — everything here files as an ordinary parts invoice.</li>';
    return;
  }
  list.innerHTML = folders
    .map((f) => {
      const name = escapeHtml(f.name);
      if (!f.matched) {
        return `<li class="fs-bad"><b>${name}</b> — no matching category. Scans here are held for review.</li>`;
      }
      if (f.private) {
        return `<li class="fs-private"><b>${name}</b> — files as <b>${escapeHtml(f.label)}</b> · private</li>`;
      }
      return `<li class="fs-ok"><b>${name}</b> — files as <b>${escapeHtml(f.label)}</b></li>`;
    })
    .join("");
}

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function render(state) {
  // Account area
  const acct = $("account");
  if (state.signedIn) {
    acct.innerHTML =
      `<span>${escapeHtml(state.shopName || state.email || "")}</span> · <a id="logoutLink">Sign out</a>`;
    const l = $("logoutLink");
    if (l) l.onclick = async () => render(await window.ha.logout());
    show("main");
  } else {
    acct.innerHTML = "";
    show("login");
    if (!$("apiBase").value) $("apiBase").value = state.apiBase || "";
  }

  // Server address (Personal): visible and changeable while signed in.
  const card = $("serverCard");
  if (card) {
    card.hidden = !(state.signedIn && state.accountType === "personal");
    $("serverAddr").textContent = state.apiBase || "";
  }

  // Configure
  $("watchDir").textContent = state.watchDir || "No folder chosen yet";
  $("dirSub").textContent = state.watchDir
    ? (state.accountType === "personal" ? "Your scanner's folder is set" : "Directory configured for scans")
    : "Choose the folder your scanner saves to";

  renderFolders(state);

  const canWatch = Boolean(state.watchDir);
  const toggle = $("toggleBtn");
  toggle.disabled = !canWatch;
  toggle.textContent = state.scanning ? "Stop watching" : "Start watching";

  $("dot").className = "dot " + (state.scanning ? "watching" : "idle");
  $("statusText").textContent = state.scanning
    ? (state.accountType === "personal" ? "Watching for new scans…" : "Watching for new invoices…")
    : canWatch ? "Idle — press Start" : "Choose a folder to begin";

  // Honest Archive Personal: an attention state when pages are stuck.
  const p = state.personal;
  const retry = $("retryBtn");
  // Only when a retry can help: a page Honest Archive couldn't read would just
  // fail again, and so would a page sent to the same wrong server address — those
  // get "Change address" instead (fixing it sends them again by itself).
  const addressFailed = p ? (p.addressFailed || 0) : 0;
  if (retry) retry.hidden = !(p && p.retryable - addressFailed > 0);
  const fa = $("failedActions");
  if (fa) {
    const stuck = p ? p.failed - p.retryable : 0;            // a retry can't help these
    const unsupported = p ? Math.min(p.unsupported || 0, stuck) : 0; // .HEIC and the like
    const unreadable = stuck - unsupported;                      // bad scans
    fa.hidden = !(p && p.failed > 0);
    $("clearFailedBtn").hidden = !(stuck > 0);
    const ca = $("changeAddrBtn");
    if (ca) ca.hidden = !(addressFailed > 0 && state.accountType === "personal");
    const hints = [];
    if (addressFailed > 0) {
      hints.push(`${addressFailed === 1 ? "1 page is" : addressFailed + " pages are"} waiting on the server address — press “Change address”, fix it and press “Save and check”; they're sent again as soon as it's right.`);
    }
    // The status line above names the pages; this says what to press afterwards.
    if (unreadable > 0 && unsupported > 0) {
      hints.push("Once you've scanned the unreadable papers again and saved the other files as JPG or PDF, press “Clear these” — they're moved to failed/cleared, nothing is deleted.");
    } else if (unreadable > 0) {
      hints.push("Once you've scanned the unreadable papers again, press “Clear these” — they're moved to failed/cleared, nothing is deleted.");
    } else if (unsupported > 0) {
      hints.push(`Once you've saved ${unsupported === 1 ? "it" : "them"} as JPG or PDF into this folder, press “Clear these” — the original is moved to failed/cleared, nothing is deleted.`);
    }
    $("failedHint").textContent = hints.length
      ? hints.join(" ")
      : "The pages that couldn't be sent are in the “failed” folder.";
  }
  if (p && state.scanning) {
    const waiting = p.waiting > 0
      ? ` ${p.waiting} page${p.waiting === 1 ? " is" : "s are"} waiting safely in the folder.` : "";
    if (p.trouble === "account") {
      $("dot").className = "dot attention";
      $("statusText").textContent = p.problem || "Honest Archive didn't accept this computer's sign-in.";
    } else if (p.trouble) {
      // Can't reach it (or it's having trouble): say the address and what's
      // waiting — and, from the main process, which pages failed, if any.
      $("dot").className = p.failed > 0 ? "dot attention" : "dot offline";
      $("statusText").textContent = p.problem || ((p.trouble === "offline"
        ? `Can't reach Honest Archive at ${state.apiBase} — will keep trying.`
        : "Honest Archive is having trouble — will keep trying.") + waiting);
    } else if (p.failed > 0) {
      $("dot").className = "dot attention";
      $("statusText").textContent = p.problem || `${p.failed} page${p.failed === 1 ? "" : "s"} couldn't be sent.`;
    }
  }

  // Stats
  $("sUploaded").textContent = state.stats.uploaded;
  $("sFailed").textContent = state.stats.failed;
  // Red only when something actually failed (Personal); shops keep their look.
  $("sFailed").classList.toggle("fail",
    state.accountType === "personal" ? Number(state.stats.failed) > 0 : true);
  $("sLast").textContent = state.stats.lastUpload || "—";
  const note = $("statsNote");
  if (note) {
    note.textContent = state.accountType === "personal"
      ? "Uploaded counts this session; Failed is what's in the failed folder now. Full history lives in the Honest Archive web app."
      : "Counts are for this session. Full history lives in the Honest Archive web app.";
  }
}

function addLog({ line, level, time }) {
  const body = $("logBody");
  const el = document.createElement("div");
  el.className = "log-line " + (level || "info");
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = time || "";
  el.appendChild(t);
  el.appendChild(document.createTextNode(String(line == null ? "" : line)));
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  while (body.childElementCount > 200) body.removeChild(body.firstChild);
}

// ---- events ----
$("loginBtn").onclick = async () => {
  const btn = $("loginBtn");
  const err = $("loginError");
  err.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const state = await window.ha.login({
      apiBase: $("apiBase").value.trim(),
      email: $("email").value.trim(),
      password: $("password").value,
    });
    render(state);
  } catch (e) {
    err.textContent = friendlyError(e, "Sign-in failed.");
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
};
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });

// Server address: Change -> edit -> Save and check.
function serverMsg(text, ok) {
  const m = $("serverMsg");
  m.hidden = !text;
  m.textContent = text || "";
  m.className = "server-msg" + (ok === true ? " good" : ok === false ? " bad" : "");
}
function serverEditing(on) {
  $("serverEdit").hidden = !on;
  $("serverChange").hidden = on;
  if (on) {
    $("serverInput").value = $("serverAddr").textContent;
    $("serverInput").focus();
    $("serverInput").select();
  }
}
$("serverChange").onclick = () => { serverMsg(""); serverEditing(true); };
// The address is only saved when the check passes, so Cancel just closes the
// editor — the address shown is still the one in use.
$("serverCancel").onclick = () => { serverMsg(""); serverEditing(false); };
$("serverSave").onclick = async () => {
  const btn = $("serverSave");
  btn.disabled = true;
  btn.textContent = "Checking…";
  serverMsg("");
  try {
    const r = await window.ha.setServer($("serverInput").value);
    render(r.state);
    serverMsg(r.message, r.ok);
    if (r.ok) serverEditing(false);
  } catch (e) {
    serverMsg(friendlyError(e, "Couldn't save the address."), false);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save and check";
  }
};
$("serverInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("serverSave").click();
  if (e.key === "Escape") $("serverCancel").click();
});

$("pickBtn").onclick = async () => render(await window.ha.pickFolder());
$("retryBtn").onclick = async () => {
  const btn = $("retryBtn");
  btn.disabled = true;
  try { render(await window.ha.retryFailed()); } finally { btn.disabled = false; }
};
$("clearFailedBtn").onclick = async () => {
  const btn = $("clearFailedBtn");
  btn.disabled = true;
  try { render(await window.ha.clearFailed()); } finally { btn.disabled = false; }
};
// Failed pages waiting on a wrong address: open the address editor (it's what
// the failed pages need) and bring it into view.
$("changeAddrBtn").onclick = () => {
  serverMsg("");
  serverEditing(true);
  const card = $("serverCard");
  if (card && card.scrollIntoView) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
};
$("openFailedBtn").onclick = async () => render(await window.ha.openFailedFolder());
$("toggleBtn").onclick = async () => {
  const st = await window.ha.getState();
  render(st.scanning ? await window.ha.stopWatch() : await window.ha.startWatch());
};

document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    const tab = t.dataset.tab;
    $("tab-configure").classList.toggle("hidden", tab !== "configure");
    $("tab-stats").classList.toggle("hidden", tab !== "stats");
  };
});

window.ha.onState(render);
window.ha.onStatus(addLog);
window.ha.getState().then(render);

// Manual refresh: someone will make a folder while the app is open, and polling for
// it would be noise.
const _rf = $("refreshFoldersBtn");
if (_rf) _rf.onclick = async () => render(await window.ha.refreshCategories());
