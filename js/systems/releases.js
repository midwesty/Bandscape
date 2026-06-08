// ============================================================
// releases.js — Releases + Streamr app (Step 14).
//
// Turn finished DAW songs into RELEASES under a band. Each release
// accrues STREAMS daily (scaled by song quality, the band's fame,
// your fame if you're in it, and a recency-decay curve), which
// convert into the band's FANS and into royalty money. The Streamr
// phone app lists releases and hosts the new-release builder
// (pick band → pick songs → title → optional cover art).
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, bandById, playerFame } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { songQuality } from "./shows.js";

let appEl = null, view = "list", draft = null, lastRenderedView = null;

const CFG = () => Object.assign({ base: 60, fameFactor: 0.015, playerFameFactor: 0.01, decayDays: 12, floor: 0.04, fanConversion: 0.02, payoutPerStream: 0.05, launchBurst: 0.5 }, DATA.config.streams || {});
const songsAll = () => getState().songs || [];
const songById = (id) => songsAll().find((s) => s.id === id) || null;
const bandsAll = () => getState().bands || [];
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const relType = (n) => (n >= 5 ? "album" : n >= 2 ? "EP" : "single");
const fmt = (n) => (n || 0).toLocaleString();

// ---- cover art: downscale to keep saves small ----
function fileToCover(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 256; let w = img.width, h = img.height; const sc = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * sc); h = Math.round(h * sc);
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        try { res(c.toDataURL("image/jpeg", 0.72)); } catch (e) { res(null); }
      };
      img.onerror = () => res(null); img.src = r.result;
    };
    r.onerror = () => res(null); r.readAsDataURL(file);
  });
}

// ============================ DAILY ACCRUAL ============================
function accrue() {
  const s = getState(); const rel = s.releases || []; if (!rel.length) return;
  const cfg = CFG(); let tStreams = 0, tFans = 0;
  s._streamBank = s._streamBank || 0;
  for (const r of rel) {
    const band = bandById(r.bandId) || {};
    const age = (s.time?.day || 1) - r.releasedDay;
    const dayMult = Math.max(cfg.floor, Math.exp(-Math.max(0, age - 1) / cfg.decayDays));
    const fameMult = 1 + (band.fame || 0) * cfg.fameFactor + (band.playerIn ? playerFame() * cfg.playerFameFactor : 0);
    const ds = Math.max(0, Math.round(cfg.base * (r.quality / 100) * fameMult * dayMult * (0.75 + Math.random() * 0.5)));
    const fans = Math.round(ds * cfg.fanConversion);
    r.streams += ds; r.lastStreams = ds; r.fans += fans; r.revenue = (r.revenue || 0) + ds * cfg.payoutPerStream;
    if (band.id) { band.fans = (band.fans || 0) + fans; band.fame = (band.fame || 0) + Math.max(0, Math.round(fans * 0.2)); }
    tStreams += ds; tFans += fans; s._streamBank += ds * cfg.payoutPerStream;
  }
  const dollars = Math.floor(s._streamBank); if (dollars > 0) { addStat("money", dollars); s._streamBank -= dollars; }
  persist();
  if (tStreams > 0) toast(`Your releases pulled ${fmt(tStreams)} streams overnight (+${tFans} fans, +$${dollars}).`, "good");
}
on("day:advanced", accrue);

// ============================ STREAMR APP ============================
export function renderStreamsApp(container) {
  appEl = container;
  const same = view === lastRenderedView;          // same page -> keep scroll; new page -> top
  const prev = same ? (appEl.scrollTop || 0) : 0;
  if (view === "new") renderBuilder(); else renderList();
  lastRenderedView = view;
  appEl.scrollTop = prev;
}
function refresh() { if (appEl) renderStreamsApp(appEl); emit("renderAll"); }

function renderList() {
  const rel = getState().releases || [];
  const total = rel.reduce((a, r) => a + (r.streams || 0), 0);
  const rows = rel.map((r) => {
    const band = bandById(r.bandId);
    const cover = r.cover ? `<img class="rel-cover" src="${r.cover}" alt="">` : `<div class="rel-cover ph">▷</div>`;
    return `<div class="rel-row">
      ${cover}
      <div class="rel-info">
        <strong>${esc(r.title)}</strong>
        <small>${esc(band?.name || "—")} · ${r.type} · Q${r.quality}</small>
        <div class="rel-stats"><span>▷ ${fmt(r.streams)}</span><span>♥ ${fmt(r.fans)}</span><span>$${Math.round(r.revenue || 0)}</span>${r.lastStreams ? `<span class="rel-trend">+${fmt(r.lastStreams)}/day</span>` : ""}</div>
      </div>
    </div>`;
  }).join("");
  appEl.innerHTML = `
    <h2 class="app-title">STREAMR</h2>
    <div class="rel-top"><div class="rel-total"><span>Total streams</span><strong>${fmt(total)}</strong></div>
      <button class="btn" id="rel-new">+ New Release</button></div>
    ${rel.length ? `<div class="rel-list">${rows}</div>` : `<div class="stub"><div class="stub-glyph">▷</div><p>No releases yet.</p><p class="muted">Finish a song in the DAW, then drop it here under one of your bands and watch the streams roll in.</p></div>`}`;
  appEl.querySelector("#rel-new").addEventListener("click", () => { draft = { bandId: bandsAll()[0]?.id || null, songIds: [], title: "", cover: null }; view = "new"; renderStreamsApp(appEl); });
}

function renderBuilder() {
  const songs = songsAll(); const bands = bandsAll();
  const band = bandById(draft.bandId);
  const released = new Set();
  (getState().releases || []).forEach((r) => (r.songIds || []).forEach((id) => released.add(id)));
  const songRows = songs.length ? songs.map((sg) => {
    if (released.has(sg.id)) {
      return `<label class="rel-song released"><span>${esc(sg.name || "Untitled")}</span><span class="rel-q">Released</span></label>`;
    }
    const on = draft.songIds.includes(sg.id);
    return `<label class="rel-song ${on ? "on" : ""}"><input type="checkbox" data-song="${sg.id}" ${on ? "checked" : ""}><span>${esc(sg.name || "Untitled")}</span><span class="rel-q">Q${songQuality(sg, band)}</span></label>`;
  }).join("") : `<p class="muted" style="padding:8px">No finished songs yet — arrange one in the DAW first.</p>`;
  const canRelease = draft.bandId && draft.songIds.length && (draft.title || "").trim();
  appEl.innerHTML = `
    <div class="pr-bar"><button class="btn pr-mini" id="rel-back">‹ Back</button><span class="pr-name">New Release</span></div>
    ${bands.length ? `<label class="rel-field">Band <select id="rel-band">${bands.map((b) => `<option value="${b.id}" ${b.id === draft.bandId ? "selected" : ""}>${esc(b.name || "Unnamed")}</option>`).join("")}</select></label>`
      : `<p class="muted" style="padding:8px">Form a band first (BAND app).</p>`}
    <label class="rel-field">Title <input id="rel-title" placeholder="Name your release" value="${esc(draft.title)}"></label>
    <div class="rel-cover-pick">
      ${draft.cover ? `<img class="rel-cover lg" src="${draft.cover}">` : `<div class="rel-cover lg ph">▷</div>`}
      <label class="btn rel-coverbtn">${draft.cover ? "Change cover" : "Add cover art"}<input type="file" id="rel-cover" accept="image/*" hidden></label>
    </div>
    <div class="rel-type-line">${draft.songIds.length ? `${relType(draft.songIds.length)} · ${draft.songIds.length} track${draft.songIds.length > 1 ? "s" : ""}` : "Pick at least one track"}</div>
    <div class="rel-songlist">${songRows}</div>
    <button class="btn rel-release ${canRelease ? "" : "dim"}" id="rel-go" ${canRelease ? "" : "disabled"}>Release</button>`;
  appEl.querySelector("#rel-back").addEventListener("click", () => { view = "list"; renderStreamsApp(appEl); });
  const bandSel = appEl.querySelector("#rel-band"); if (bandSel) bandSel.addEventListener("change", () => { draft.bandId = bandSel.value; renderStreamsApp(appEl); });
  const title = appEl.querySelector("#rel-title"); title.addEventListener("input", () => { draft.title = title.value; const go = appEl.querySelector("#rel-go"); const ok = draft.bandId && draft.songIds.length && title.value.trim(); if (go) { go.disabled = !ok; go.classList.toggle("dim", !ok); } });
  appEl.querySelectorAll("[data-song]").forEach((cb) => cb.addEventListener("change", () => {
    const id = cb.dataset.song;
    if (cb.checked) { if (!draft.songIds.includes(id)) draft.songIds.push(id); } else draft.songIds = draft.songIds.filter((x) => x !== id);
    renderStreamsApp(appEl);
  }));
  const cover = appEl.querySelector("#rel-cover");
  if (cover) cover.addEventListener("change", async () => { const f = cover.files?.[0]; if (!f) return; const d = await fileToCover(f); if (d) { draft.cover = d; renderStreamsApp(appEl); } else toast("Couldn't read that image.", "warn"); });
  const go = appEl.querySelector("#rel-go"); if (go) go.addEventListener("click", createRelease);
}

function createRelease() {
  const _used = new Set();
  (getState().releases || []).forEach((r) => (r.songIds || []).forEach((id) => _used.add(id)));
  draft.songIds = (draft.songIds || []).filter((id) => !_used.has(id));
  if (!draft.songIds.length) { toast("Those tracks are already released — pick a fresh recording.", "warn"); return; }
  const s = getState(); const band = bandById(draft.bandId);
  const songs = draft.songIds.map(songById).filter(Boolean);
  if (!band || !songs.length || !(draft.title || "").trim()) return;
  const q = Math.round(songs.reduce((a, sg) => a + songQuality(sg, band), 0) / songs.length);
  const cfg = CFG();
  const rel = { id: "rel_" + Date.now().toString(36), title: draft.title.trim(), bandId: draft.bandId, type: relType(songs.length), songIds: [...draft.songIds], cover: draft.cover || null, releasedDay: s.time?.day || 1, streams: 0, lastStreams: 0, fans: 0, revenue: 0, quality: q, genre: band.genre || null };
  // launch-day burst so a release feels immediately alive
  const fameMult = 1 + (band.fame || 0) * cfg.fameFactor + (band.playerIn ? playerFame() * cfg.playerFameFactor : 0);
  const burst = Math.max(1, Math.round(cfg.base * (q / 100) * fameMult * cfg.launchBurst));
  const fans = Math.round(burst * cfg.fanConversion);
  rel.streams = burst; rel.lastStreams = burst; rel.fans = fans; rel.revenue = burst * cfg.payoutPerStream;
  band.fans = (band.fans || 0) + fans;
  s.releases = s.releases || []; s.releases.unshift(rel);
  persist(); emit("release:created", { title: rel.title, bandId: band.id });
  draft = null; view = "list"; refresh();
  toast(`Released "${rel.title}" (${rel.type}) by ${band.name}. ${fmt(burst)} streams on day one!`, "good");
}
