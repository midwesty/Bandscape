// ============================================================
// toast.js — quick transient messages (item used, objective done…)
// ============================================================

let host = null;

function ensureHost() {
  if (host) return host;
  host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    document.body.appendChild(host);
  }
  return host;
}

export function toast(msg, kind = "info", ms = 2600) {
  const h = ensureHost();
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  h.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  }, ms);
}
