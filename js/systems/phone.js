// ============================================================
// phone.js — the phone is the hub. Minimal HUD, everything else
// lives in here. Home grid of apps (driven by config.apps), with
// working Tasks / Status / Settings and teasers for the rest.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { renderTasksApp } from "./objectives.js";
import { renderMusicApp } from "./music.js";
import { renderBandApp } from "./band.js";
import { activeConditions } from "./conditions.js";
import { exportSave, importSave, saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";

const APP_META = {
  tasks:    { label: "Tasks",   glyph: "✓",  accent: "#ffd23f" },
  status:   { label: "Status",  glyph: "♥",  accent: "#ff3b6b" },
  settings: { label: "Settings",glyph: "⚙",  accent: "#aaa" },
  music:    { label: "Sound",   glyph: "♪",  accent: "#7CFC9B" },
  band:     { label: "Band",    glyph: "♬",  accent: "#ff8a3d" },
  maps:     { label: "Maps",    glyph: "⌖",  accent: "#4fc3f7" },
  bank:     { label: "Bank",    glyph: "$",  accent: "#7CFC9B" },
  contacts: { label: "People",  glyph: "☻",  accent: "#b388ff" },
  streamr:  { label: "Streamr", glyph: "▷",  accent: "#ff8a3d" }
};

let phoneEl, screenEl, openState = false, currentApp = "home";

export function initPhone() {
  phoneEl = document.getElementById("phone");
  screenEl = document.getElementById("phone-screen");

  document.getElementById("phone-button")?.addEventListener("click", togglePhone);
  document.getElementById("phone-close")?.addEventListener("click", closePhone);
  document.getElementById("phone-home-btn")?.addEventListener("click", () => openApp("home"));
  phoneEl?.addEventListener("click", (e) => { if (e.target === phoneEl) closePhone(); });

  on("renderAll", () => { if (openState && currentApp !== "home" && currentApp !== "music") renderApp(currentApp); });
}

export function togglePhone() { openState ? closePhone() : openPhone(); }

export function openPhone() {
  openState = true;
  phoneEl.classList.remove("hidden");
  requestAnimationFrame(() => phoneEl.classList.add("open"));
  document.body.classList.add("modal-open");
  openApp("home");
  emit("phone:opened");
}

export function closePhone() {
  openState = false;
  phoneEl.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => phoneEl.classList.add("hidden"), 250);
  emit("phone:closed");
}

function openApp(app) {
  currentApp = app;
  phoneEl.classList.toggle("landscape", app === "music");
  renderApp(app);
  emit("phone:appChanged", { app });
  if (app !== "home") emit("phone:appOpened", { app });
}

function renderApp(app) {
  if (app === "home") return renderHome();
  const enabled = DATA.config.apps[app];
  if (!enabled && app !== "tasks" && app !== "status" && app !== "settings") return renderStub(app);

  if (app === "tasks") return renderTasksApp(screenEl);
  if (app === "status") return renderStatus();
  if (app === "settings") return renderSettings();
  if (app === "music") return renderMusicApp(screenEl);
  if (app === "band") return renderBandApp(screenEl);
  return renderStub(app);
}

function renderHome() {
  const s = getState();
  const order = ["tasks", "status", "band", "music", "maps", "streamr", "bank", "contacts", "settings"];
  const grid = order.map((id) => {
    const m = APP_META[id];
    const enabled = DATA.config.apps[id];
    return `
      <button class="app-icon ${enabled ? "" : "app-soon"}" data-app="${id}">
        <span class="app-glyph" style="--accent:${m.accent}">${m.glyph}</span>
        <span class="app-name">${m.label}</span>
        ${enabled ? "" : `<span class="app-soon-tag">soon</span>`}
      </button>`;
  }).join("");

  screenEl.innerHTML = `
    <div class="phone-status-bar"><span>${s.player.name}</span><span>▮▮▮ 13%</span></div>
    <div class="app-grid">${grid}</div>
  `;
  screenEl.querySelectorAll(".app-icon").forEach((b) =>
    b.addEventListener("click", () => openApp(b.dataset.app)));
}

function renderStub(app) {
  const m = APP_META[app] || { label: app, glyph: "?" };
  screenEl.innerHTML = `
    <h2 class="app-title">${m.label.toUpperCase()}</h2>
    <div class="stub">
      <div class="stub-glyph">${m.glyph}</div>
      <p>This unlocks in a later build.</p>
      <p class="muted">${stubTease(app)}</p>
    </div>`;
}
function stubTease(app) {
  return ({
    music: "Play & record loops on your phone.",
    maps: "Get around town: venues, the pawn shop, the corner store.",
    bank: "Track your cash, your debt, and your bad decisions.",
    contacts: "Musicians you've met and can recruit.",
    streamr: "Upload your tracks. Earn royalties. Maybe."
  })[app] || "Coming soon.";
}

function renderStatus() {
  const s = getState();
  const rows = DATA.stats.stats.filter((d) => d.kind !== "resource").map((d) => {
    const val = Math.round(s.stats[d.id] ?? 0);
    const pct = Math.max(0, Math.min(100, (val / (d.max || 100)) * 100));
    return `
      <div class="stat-row">
        <span class="stat-name">${d.label}</span>
        <div class="stat-track"><div class="stat-fill" style="width:${pct}%;background:${d.color}"></div></div>
        <span class="stat-val">${val}</span>
      </div>`;
  }).join("");

  const conds = activeConditions();
  const condHtml = conds.length
    ? conds.map((c) => `<span class="cond cond-${c.def.kind}">${c.def.name}</span>`).join("")
    : `<span class="muted">No active conditions.</span>`;

  const res = DATA.stats.stats.filter((d) => d.kind === "resource")
    .map((d) => `<div class="res"><span>${d.label}</span><strong>${d.prefix || ""}${Math.floor(s.stats[d.id] ?? 0)}</strong></div>`).join("");

  screenEl.innerHTML = `
    <h2 class="app-title">STATUS</h2>
    <div class="res-row">${res}</div>
    ${rows}
    <h3 class="sub">Conditions</h3>
    <div class="cond-wrap">${condHtml}</div>
    <h3 class="sub">Debt</h3>
    <div class="res"><span>Pawn shop (Sal)</span><strong style="color:#ff3b6b">$${s.debt.pawn}</strong></div>
  `;
}

function renderSettings() {
  const s = getState();
  screenEl.innerHTML = `
    <h2 class="app-title">SETTINGS</h2>
    <div class="set-block">
      <div class="set-label">Save</div>
      <button class="btn" id="set-save">Save Now (Slot ${s.meta.slot})</button>
      <button class="btn" id="set-export">Export Save (file)</button>
      <label class="btn btn-file">Import Save<input type="file" id="set-import" accept="application/json" hidden></label>
    </div>
    <div class="set-block">
      <div class="set-label">Game</div>
      <button class="btn btn-danger" id="set-new">New Game</button>
    </div>
    <div class="set-meta muted">
      ${DATA.config.version}<br>
      Last saved: ${s.meta.lastSaved ? new Date(s.meta.lastSaved).toLocaleString() : "never"}
    </div>`;

  document.getElementById("set-save").addEventListener("click", () => {
    saveToSlot(s.meta.slot, s); toast("Saved.", "good");
  });
  document.getElementById("set-export").addEventListener("click", () => {
    exportSave(s); emit("save:exported"); toast("Save exported.", "good");
  });
  document.getElementById("set-import").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { const data = await importSave(f); emit("save:imported", { data }); }
    catch { toast("That file didn't read as a save.", "warn"); }
  });
  document.getElementById("set-new").addEventListener("click", () => {
    if (confirm("Start a new game? Save first if you care about this one.")) emit("game:requestNew");
  });
}
