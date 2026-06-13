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
import { getState, addStat, bandById, playerFame, splitRoyalty, ensureContracts, creditName, creditAffiliation, autoCredits, playerArtistName, PLAYER_ARTIST } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { songQuality } from "./shows.js";
import { countItem, takeItem } from "./inventory.js";
import { burnTape } from "./tape.js";

let appEl = null, view = "list", draft = null, lastRenderedView = null;
let pickerOpen = false, pickerQ = "";

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
function distributeCreditFame(r, ds) {
  const credits = r.credits || []; if (!credits.length) return;
  const totalPct = credits.reduce((a, c) => a + (Number(c.pct) || 0), 0) || 1;
  const ff = (DATA.config.credits && DATA.config.credits.fameFactor) || 0.02;
  for (const c of credits) {
    const fame = Math.round(ds * ff * (Number(c.pct) || 0) / totalPct);
    if (fame <= 0) continue;
    if (c.id === PLAYER_ARTIST) addStat("fame", fame);
    else { const mm = (getState().musicians || []).find((x) => x.id === c.id); if (mm) mm.fame = (mm.fame || 0) + fame; }
  }
}
function accrue() {
  const s = getState(); const rel = s.releases || []; if (!rel.length) return;
  ensureContracts();
  const cfg = CFG(); let tStreams = 0, tFans = 0;
  let dollars = 0;
  for (const r of rel) {
    const band = bandById(r.bandId) || {};
    const age = (s.time?.day || 1) - r.releasedDay;
    const dayMult = Math.max(cfg.floor, Math.exp(-Math.max(0, age - 1) / cfg.decayDays));
    const fameMult = 1 + (band.fame || 0) * cfg.fameFactor + (band.playerIn ? playerFame() * cfg.playerFameFactor : 0);
    const ds = Math.max(0, Math.round(cfg.base * (r.quality / 100) * fameMult * dayMult * (0.75 + Math.random() * 0.5)));
    const fans = Math.round(ds * cfg.fanConversion);
    r.streams += ds; r.lastStreams = ds; r.fans += fans; r.revenue = (r.revenue || 0) + ds * cfg.payoutPerStream;
    if (band.id) { band.fans = (band.fans || 0) + fans; band.fame = (band.fame || 0) + Math.max(0, Math.round(fans * 0.2)); }
    tStreams += ds; tFans += fans;
    if (band.id && ds > 0) {
      // royalty: accumulate fractional dollars, split by the release's credits when whole
      r._royaltyAccum = (r._royaltyAccum || 0) + ds * cfg.payoutPerStream;
      const whole = Math.floor(r._royaltyAccum);
      if (whole > 0) { r._royaltyAccum -= whole; splitRoyalty(r.bandId, r.credits, whole, `Streaming: ${r.title || "release"}`); dollars += whole; }
      distributeCreditFame(r, ds);
    }
  }
  persist();
  if (tStreams > 0) toast(`Your releases pulled ${fmt(tStreams)} streams overnight (+${tFans} fans, +$${dollars} in royalties, split per credits).`, "good");
}
on("day:advanced", accrue);

// ============================ STREAMR APP ============================
export function renderStreamsApp(container) {
  appEl = container;
  const same = view === lastRenderedView;          // same page -> keep scroll; new page -> top
  const prev = same ? (appEl.scrollTop || 0) : 0;
  if (view === "new") renderBuilder(); else if (view === "credits") renderCredits(); else renderList();
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
        ${(r.credits && r.credits.length) ? `<div class="rel-credits">${r.credits.map((c) => `${esc(creditName(c.id))} <span class="rel-cr-role">${esc(c.role)} ${c.pct}%</span>`).join(" · ")}</div>` : ""}
        <button class="lib-mini rel-burn" data-burnrel="${r.id}">▣ Burn to tape</button>
      </div>
    </div>`;
  }).join("");
  appEl.innerHTML = `
    <h2 class="app-title">STREAMR</h2>
    <div class="rel-top"><div class="rel-total"><span>Total streams</span><strong>${fmt(total)}</strong></div>
      <button class="btn" id="rel-new">+ New Release</button></div>
    ${rel.length ? `<div class="rel-list">${rows}</div>` : `<div class="stub"><div class="stub-glyph">▷</div><p>No releases yet.</p><p class="muted">Finish a song in the DAW, then drop it here under one of your bands and watch the streams roll in.</p></div>`}`;
  appEl.querySelector("#rel-new").addEventListener("click", () => { draft = { bandId: bandsAll()[0]?.id || null, songIds: [], title: "", cover: null }; view = "new"; renderStreamsApp(appEl); });
  appEl.querySelectorAll("[data-burnrel]").forEach((b) => b.addEventListener("click", async () => {
    if (countItem("blank_tape") < 1) { toast("You need a blank tape — grab one at the pawn shop.", "warn"); return; }
    const res = await burnTape("release", b.dataset.burnrel);
    if (!res.ok) { toast(res.err || "Couldn't burn that.", "bad"); return; }
    takeItem("blank_tape", 1);
    try { saveToSlot(getState().meta.slot, getState()); } catch {}
    toast(`Burned "${res.title}" to tape. ${countItem("blank_tape")} left.`, "good");
  }));
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
    <button class="btn rel-release ${canRelease ? "" : "dim"}" id="rel-go" ${canRelease ? "" : "disabled"}>Next: Credits ›</button>`;
  appEl.querySelector("#rel-back").addEventListener("click", () => { view = "list"; renderStreamsApp(appEl); });
  const bandSel = appEl.querySelector("#rel-band"); if (bandSel) bandSel.addEventListener("change", () => { draft.bandId = bandSel.value; draft.credits = null; renderStreamsApp(appEl); });
  const title = appEl.querySelector("#rel-title"); title.addEventListener("input", () => { draft.title = title.value; const go = appEl.querySelector("#rel-go"); const ok = draft.bandId && draft.songIds.length && title.value.trim(); if (go) { go.disabled = !ok; go.classList.toggle("dim", !ok); } });
  appEl.querySelectorAll("[data-song]").forEach((cb) => cb.addEventListener("change", () => {
    const id = cb.dataset.song;
    if (cb.checked) { if (!draft.songIds.includes(id)) draft.songIds.push(id); } else draft.songIds = draft.songIds.filter((x) => x !== id);
    renderStreamsApp(appEl);
  }));
  const cover = appEl.querySelector("#rel-cover");
  if (cover) cover.addEventListener("change", async () => { const f = cover.files?.[0]; if (!f) return; const d = await fileToCover(f); if (d) { draft.cover = d; renderStreamsApp(appEl); } else toast("Couldn't read that image.", "warn"); });
  const go = appEl.querySelector("#rel-go"); if (go) go.addEventListener("click", goToCredits);
}

function goToCredits() {
  const used = new Set();
  (getState().releases || []).forEach((r) => (r.songIds || []).forEach((id) => used.add(id)));
  draft.songIds = (draft.songIds || []).filter((id) => !used.has(id));
  if (!draft.bandId || !draft.songIds.length || !(draft.title || "").trim()) { toast("Pick a band, at least one fresh track, and a title first.", "warn"); return; }
  if (!draft.credits) draft.credits = autoCredits(draft.bandId, draft.songIds);
  pickerOpen = false; pickerQ = "";
  view = "credits"; renderStreamsApp(appEl);
}

const ROLES = () => (DATA.config.credits && DATA.config.credits.roles) || ["Performer", "Songwriter", "Producer"];

function renderCredits() {
  const roles = ROLES();
  const credits = draft.credits || [];
  const total = credits.reduce((a, c) => a + (Number(c.pct) || 0), 0);
  const rows = credits.map((c, i) => `
    <div class="cr-row">
      <div class="cr-who"><span class="cr-name">${esc(creditName(c.id))}</span><span class="cr-aff">${esc(creditAffiliation(c.id))}</span></div>
      <div class="cr-controls">
        <select class="cr-role" data-i="${i}">${roles.map((r) => `<option ${r === c.role ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>
        <span class="cr-pct"><input class="cr-pctin" type="number" min="0" max="100" inputmode="numeric" data-i="${i}" value="${c.pct}"><span class="cr-pct-sym">%</span></span>
        <button class="cr-rm" data-rm="${i}" title="Remove">✕</button>
      </div>
    </div>`).join("") || `<div class="set-note">No credits yet — add someone below.</div>`;
  appEl.innerHTML = `
    <div class="pr-bar"><button class="btn pr-mini" id="cr-back">‹ Back</button><span class="pr-name">Credits &amp; Splits</span></div>
    <p class="rel-type-line">Who gets paid &amp; famed when "${esc(draft.title || "this release")}" is streamed or played live. Splits should total 100%.</p>
    <div class="cr-list">${rows}</div>
    <div class="cr-total ${total === 100 ? "ok" : "off"}">Total split: <strong>${total}%</strong>${total !== 100 ? " — aim for 100%" : " ✓"}</div>
    <button class="btn cr-add" id="cr-add">${pickerOpen ? "Close picker" : "+ Add credit"}</button>
    <div id="cr-picker">${pickerOpen ? pickerHTML() : ""}</div>
    <button class="btn rel-release" id="cr-release">Release “${esc(draft.title || "")}”</button>`;
  bindCredits();
}

function candidates() {
  const s = getState();
  const list = [{ id: PLAYER_ARTIST, name: playerArtistName(), aff: "You" }];
  for (const b of (s.bands || [])) list.push({ id: b.id, name: b.name || "Unnamed band", aff: "Band" });
  for (const m of (s.musicians || [])) list.push({ id: m.id, name: m.name || "Unknown", aff: creditAffiliation(m.id) });
  return list;
}
function filteredCands() {
  const credited = new Set((draft.credits || []).map((c) => c.id));
  const q = pickerQ.trim().toLowerCase();
  return candidates().filter((x) => !credited.has(x.id) && (!q || `${x.name} ${x.aff}`.toLowerCase().includes(q)));
}
function candsHTML(cands) {
  return cands.length ? cands.map((x) => `<button class="cr-cand" data-add="${x.id}"><span>${esc(x.name)}</span><span class="cr-aff">${esc(x.aff)}</span></button>`).join("") : `<div class="set-note">No matches.</div>`;
}
function pickerHTML() {
  return `<div class="cr-picker-card">
    <input id="cr-search" class="bank-search" type="text" placeholder="Search people or bands…" value="${esc(pickerQ)}" autocapitalize="off">
    <div class="cr-cands" id="cr-cands">${candsHTML(filteredCands())}</div>
  </div>`;
}
function roleFor(id) {
  if (id === PLAYER_ARTIST) return "Producer";
  if (bandById(id)) return "Performer";
  return "Featured";
}
function updateTotal() {
  const total = (draft.credits || []).reduce((a, c) => a + (Number(c.pct) || 0), 0);
  const tEl = appEl.querySelector(".cr-total");
  if (tEl) { tEl.className = `cr-total ${total === 100 ? "ok" : "off"}`; tEl.innerHTML = `Total split: <strong>${total}%</strong>${total !== 100 ? " — aim for 100%" : " ✓"}`; }
}

function bindCredits() {
  appEl.querySelector("#cr-back").addEventListener("click", () => { pickerOpen = false; view = "new"; renderStreamsApp(appEl); });
  appEl.querySelector("#cr-release").addEventListener("click", createRelease);
  appEl.querySelector("#cr-add").addEventListener("click", () => { pickerOpen = !pickerOpen; pickerQ = ""; renderStreamsApp(appEl); });
  appEl.querySelectorAll(".cr-role").forEach((sel) => sel.addEventListener("change", () => {
    const i = +sel.dataset.i; if (draft.credits[i]) draft.credits[i].role = sel.value;
  }));
  appEl.querySelectorAll(".cr-pctin").forEach((inp) => inp.addEventListener("input", () => {
    const i = +inp.dataset.i; const v = Math.max(0, Math.min(100, Math.floor(Number(inp.value) || 0)));
    if (draft.credits[i]) draft.credits[i].pct = v;
    updateTotal();
  }));
  appEl.querySelectorAll(".cr-rm").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.rm; draft.credits.splice(i, 1); renderStreamsApp(appEl);
  }));
  const search = appEl.querySelector("#cr-search");
  if (search) search.addEventListener("input", () => {
    pickerQ = search.value;
    const el = appEl.querySelector("#cr-cands"); if (el) el.innerHTML = candsHTML(filteredCands());
  });
  appEl.querySelectorAll(".cr-cand").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.add;
    if (!(draft.credits || []).some((c) => c.id === id)) draft.credits.push({ id, role: roleFor(id), pct: 0 });
    pickerOpen = false; pickerQ = ""; renderStreamsApp(appEl);
  }));
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
  const rel = { id: "rel_" + Date.now().toString(36), title: draft.title.trim(), bandId: draft.bandId, type: relType(songs.length), songIds: [...draft.songIds], cover: draft.cover || null, credits: (draft.credits && draft.credits.length) ? draft.credits.map((c) => ({ ...c })) : autoCredits(draft.bandId, draft.songIds), releasedDay: s.time?.day || 1, streams: 0, lastStreams: 0, fans: 0, revenue: 0, quality: q, genre: band.genre || null };
  // launch-day burst so a release feels immediately alive
  const fameMult = 1 + (band.fame || 0) * cfg.fameFactor + (band.playerIn ? playerFame() * cfg.playerFameFactor : 0);
  const burst = Math.max(1, Math.round(cfg.base * (q / 100) * fameMult * cfg.launchBurst));
  const fans = Math.round(burst * cfg.fanConversion);
  rel.streams = burst; rel.lastStreams = burst; rel.fans = fans; rel.revenue = burst * cfg.payoutPerStream;
  band.fans = (band.fans || 0) + fans;
  s.releases = s.releases || []; s.releases.unshift(rel);
  persist(); emit("release:created", { title: rel.title, bandId: band.id });
  draft = null; pickerOpen = false; view = "list"; refresh();
  toast(`Released "${rel.title}" (${rel.type}) by ${band.name}. ${fmt(burst)} streams on day one!`, "good");
}
