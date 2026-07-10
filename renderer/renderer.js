const $ = (id) => document.getElementById(id);

function show(view) {
  $("login").classList.toggle("hidden", view !== "login");
  $("main").classList.toggle("hidden", view !== "main");
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
