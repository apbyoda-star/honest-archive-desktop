const $ = (id) => document.getElementById(id);

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
      `<span>${state.shopName || state.email || ""}</span> · <a id="logoutLink">Sign out</a>`;
    const l = $("logoutLink");
    if (l) l.onclick = async () => render(await window.ha.logout());
    show("main");
  } else {
    acct.innerHTML = "";
    show("login");
    if (!$("apiBase").value) $("apiBase").value = state.apiBase || "";
  }

  // Configure
  $("watchDir").textContent = state.watchDir || "No folder chosen yet";
  $("dirSub").textContent = state.watchDir
    ? "Directory configured for scans"
    : "Choose the folder your scanner saves to";

  renderFolders(state);

  const canWatch = Boolean(state.watchDir);
  const toggle = $("toggleBtn");
  toggle.disabled = !canWatch;
  toggle.textContent = state.scanning ? "Stop watching" : "Start watching";

  $("dot").className = "dot " + (state.scanning ? "watching" : "idle");
  $("statusText").textContent = state.scanning
    ? "Watching for new invoices…"
    : canWatch ? "Idle — press Start" : "Choose a folder to begin";

  // Stats
  $("sUploaded").textContent = state.stats.uploaded;
  $("sFailed").textContent = state.stats.failed;
  $("sLast").textContent = state.stats.lastUpload || "—";
}

function addLog({ line, level, time }) {
  const body = $("logBody");
  const el = document.createElement("div");
  el.className = "log-line " + (level || "info");
  el.innerHTML = `<span class="t">${time}</span>${line}`;
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
    err.textContent = e.message || "Login failed.";
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
};
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });

$("pickBtn").onclick = async () => render(await window.ha.pickFolder());
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
