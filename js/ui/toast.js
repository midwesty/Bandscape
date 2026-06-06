// ============================================================
// toast.js — the message LOG (top-right feed).
//
// Everything in the game funnels through toast(msg, kind). Instead
// of a popup over the map, entries stack in a right-side feed under
// the cash readout: newest on top, older ones dim, capped to a few.
// The feed ignores pointer events, so taps pass through to the room.
// This is also the foundation for dialogue / prompts later.
// ============================================================

let host = null;
const MAX = 6;

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = document.getElementById("log");
  if (!host) {
    host = document.createElement("div");
    host.id = "log";
    document.body.appendChild(host);
  }
  return host;
}

export function toast(msg, kind = "info") {
  const h = ensureHost();
  const el = document.createElement("div");
  el.className = `log-entry log-${kind}`;
  el.textContent = msg;
  h.prepend(el);

  while (h.children.length > MAX) h.lastChild.remove();

  requestAnimationFrame(() => {
    el.classList.add("show");
    [...h.children].forEach((c, i) => { c.style.opacity = String(Math.max(0.32, 1 - i * 0.14)); });
  });
}

// Convenience alias for narrative/prompt lines (same feed, for now).
export function logLine(msg, kind = "info") { toast(msg, kind); }
