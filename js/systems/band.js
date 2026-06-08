// ============================================================
// band.js — Band Management 3.0.
//
// Membership is normalized: a persistent MUSICIAN pool (everyone
// you've met) where each musician references a band via bandId,
// and the player belongs to any number of bands via per-band
// playerIn. The BAND app has two views: BAND (manage one band)
// and MUSICIANS (manage everyone — assign, set instrument, bench,
// release, retire). Each band has its own fans/fame/genre; an
// individual's fame SWAYS a band's renown when they join.
// ============================================================

import { DATA } from "../engine/data.js";
import {
  getState, addStat, setFlag, activeBand, bandById, roleFromArchetype,
  ensureMusicianModel, allMusicians, musicianById, bandMembers, performingMembers,
  freeAgents, retiredMusicians, musicianOVR, assignMusician, setMusicianStatus,
  musicianFromNpc, playerFame
} from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { advanceMinutes } from "./time.js";
import { songQuality } from "./shows.js";
import { findReady, nextCommitment, complete, openScheduler, slotLabel } from "./calendar.js";
import { writeSession } from "./songwriter.js";

const NPC_COLOR = { npc_brian: "#ff8a3d", npc_lex: "#4fc3f7", npc_ruby: "#ff3b6b", npc_jo: "#b388ff" };
const BAND_NAMES = ["The Damp Sells", "Parking Lot Gods", "Wet Sprocket Jr.", "The Landlords", "Crab Rangoon", "Future Tenants", "The Damage Deposit", "Couch Surfers", "Night Shift", "The Security Deposit"];
const ROLES = ["guitar", "bass", "drums", "piano", "vocals"];
const ROLE_LABEL = { guitar: "Guitar", bass: "Bass", drums: "Drums", piano: "Keys", vocals: "Vocals" };
const STATUS = {
  active: { label: "Active", color: "#7CFC9B" },
  benched: { label: "Benched", color: "#ffd23f" },
  free_agent: { label: "Free agent", color: "#4fc3f7" },
  retired: { label: "Retired", color: "#8b8595" },
  unavailable: { label: "Out", color: "#ff3b6b" }
};

let overlay = null, viewing = null;          // recruit modal
let appContainer = null, appView = "band";    // BAND app
let pickerOpen = false, mQuery = "", mFilter = "all", mExpanded = null;

const npcDef = (id) => (DATA.npcs.npcs || []).find((n) => n.id === id) || null;
const bands = () => getState().bands || [];
const H = () => Object.assign({ start: 70, rehearse: 6, rehearseBonus: 4, show: 4, showQualityDiv: 20, missShow: 18, missReh: 12, idleDecay: 2, idleDecayLoyal: 1, quitThreshold: 15, quitChance: 0.5 }, DATA.config.band?.happiness || {});
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const color = (id) => NPC_COLOR[id] || "#7CFC9B";
const hapColor = (h) => (h >= 60 ? "#7CFC9B" : h >= 30 ? "#ffd23f" : "#ff3b6b");
function refresh() { if (appContainer) renderBandApp(appContainer); emit("renderAll"); }
function applyJoinSway(band, m) {
  const sway = DATA.config.band?.joinSway ?? 0.3;
  const add = Math.round(((m.isPlayer ? playerFame() : (m.fame || 0))) * sway);
  if (add > 0) band.fame = (band.fame || 0) + add;
  return add;
}

// ============================ RECRUIT MODAL (at The Dive) ============================
export function openRecruit(npcId) {
  const npc = npcDef(npcId); if (!npc) return;
  setFlag("met_" + npcId.replace("npc_", ""), true);
  if (npc.recruitConditions?.flag) setFlag(npc.recruitConditions.flag, true);
  overlay = overlay || document.getElementById("recruit");
  viewing = npcId;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  renderRecruit();
}
export function closeRecruit() {
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}
function conditionsMet(npc) {
  const rc = npc.recruitConditions || {};
  if (rc.flag && !getState().flags?.[rc.flag]) return false;
  if (rc.minFame && (getState().stats.fame || 0) < rc.minFame) return false;
  return true;
}
const hasDemo = () => (getState().songs || []).length > 0;
function bar(label, v, col) { return `<div class="bd-stat"><span>${label}</span><div class="bd-bar"><div style="width:${Math.round(v * 100)}%;background:${col}"></div></div></div>`; }

function renderRecruit() {
  const npc = npcDef(viewing); if (!npc) return;
  const m = musicianById(viewing);
  const ab = activeBand();
  let actionHTML, note = "";
  if (m && m.bandId === ab?.id) {
    actionHTML = `<button class="btn" disabled>✓ Already in ${esc(ab.name || "this band")}</button>`;
  } else if (m && m.bandId) {
    const from = bandById(m.bandId);
    actionHTML = `<button class="btn bd-recruit" id="bd-join">Move to ${esc(ab?.name || "this band")}</button>`;
    note = `Currently in ${esc(from?.name || "another band")}. Moving frees up their old spot.`;
  } else if (m) {
    actionHTML = `<button class="btn bd-recruit" id="bd-join">Add to ${esc(ab?.name || "this band")}</button>`;
    note = "A free agent you already know. Add them straight from here or the Musicians page.";
  } else {
    const ok = hasDemo() && conditionsMet(npc);
    actionHTML = `<button class="btn bd-recruit" id="bd-join" ${ok ? "" : "disabled"}>Recruit to ${esc(ab?.name || "your band")}</button>`;
    if (!hasDemo()) note = "They want to hear something first. Record &amp; save a song, then come back.";
    else if (!conditionsMet(npc)) note = "They're not interested yet.";
  }
  overlay.innerHTML = `
    <div class="bd-modal">
      <div class="bd-head">
        <div class="bd-portrait" style="background:${color(viewing)}">${esc(npc.name[0])}</div>
        <div><div class="bd-name">${esc(npc.name)}</div><div class="bd-arch">${esc(npc.archetype)} · ${esc(npc.genre)}</div></div>
        <button class="phone-nav" id="bd-close">✕</button>
      </div>
      <div class="bd-body">
        ${bar("Skill", npc.skill || 0, "#7CFC9B")}
        ${bar("Reliability", npc.reliability || 0, "#4fc3f7")}
        ${(npc.vices || []).length ? `<p class="bd-vices">Into: ${npc.vices.map(esc).join(", ")}</p>` : ""}
        <div class="bd-action">${actionHTML}</div>
        ${note ? `<p class="shop-note">${note}</p>` : ""}
      </div>
    </div>`;
  overlay.querySelector("#bd-close").addEventListener("click", closeRecruit);
  const j = overlay.querySelector("#bd-join");
  if (j) j.addEventListener("click", () => recruit(viewing));
}
function recruit(npcId) {
  const npc = npcDef(npcId); const b = activeBand(); if (!b) return;
  let m = musicianById(npcId);
  if (!m) { m = musicianFromNpc(npc, b.id, "active"); getState().musicians.push(m); }
  else { assignMusician(npcId, b.id); }
  const swayed = applyJoinSway(b, m);
  if (!b.name) { const sug = BAND_NAMES[Math.floor(Math.random() * BAND_NAMES.length)]; b.name = ((prompt("You've got a band! Name it:", sug) || sug).trim()) || sug; }
  persist(); emit("band:recruited", { id: npcId, bandId: b.id }); refresh();
  toast(`${npc.name} joined ${b.name}.${swayed > 0 ? ` Their name pulls weight (+${swayed} buzz).` : ""}`, "good");
  renderRecruit();
}

// ============================ BAND APP (entry) ============================
export function renderBandApp(container) {
  appContainer = container;
  ensureMusicianModel();
  const tabs = `<div class="app-tabs">
    <button class="app-tab ${appView === "band" ? "active" : ""}" data-view="band">BAND</button>
    <button class="app-tab ${appView === "musicians" ? "active" : ""}" data-view="musicians">MUSICIANS</button>
  </div>`;
  container.innerHTML = `<h2 class="app-title">BAND</h2>${tabs}<div id="band-view"></div>`;
  container.querySelectorAll(".app-tab").forEach((t) => t.addEventListener("click", () => { appView = t.dataset.view; pickerOpen = false; mExpanded = null; renderBandApp(container); }));
  const view = container.querySelector("#band-view");
  if (appView === "musicians") renderMusicians(view); else renderBand(view);
}

// ---------------------------- BAND VIEW ----------------------------
function picker(b) {
  const list = bands();
  const rows = list.filter((x) => (x.name || "Unnamed").toLowerCase().includes(mQuery.toLowerCase()))
    .map((x) => `<button class="pick-row ${x.id === b.id ? "active" : ""}" data-pick="${x.id}">
      <span>${esc(x.name || "Unnamed")}${x.playerIn ? " ★" : ""}</span>
      <small>${bandMembers(x.id).length + (x.playerIn ? 1 : 0)} mbr · ${x.fans || 0} fans</small></button>`).join("");
  return `<div class="band-picker">
    <button class="picker-head" id="picker-toggle"><span>Managing: <strong>${esc(b.name || "Unnamed")}</strong></span><span>${pickerOpen ? "▴" : "▾"}</span></button>
    ${pickerOpen ? `<div class="picker-panel">
      <input id="picker-q" class="browse-q" placeholder="Search bands…" value="${esc(mQuery)}">
      <div class="picker-list">${rows || `<p class="muted" style="padding:8px">No match.</p>`}</div>
      <button class="btn band-mini" id="band-new">+ Form New Band</button>
    </div>` : ""}
  </div>`;
}
function bindPicker(view, b) {
  const tg = view.querySelector("#picker-toggle"); if (tg) tg.addEventListener("click", () => { pickerOpen = !pickerOpen; renderBandApp(appContainer); });
  const q = view.querySelector("#picker-q");
  if (q) q.addEventListener("input", () => { mQuery = q.value; renderBandApp(appContainer); requestAnimationFrame(() => { const n = appContainer.querySelector("#picker-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); });
  view.querySelectorAll("[data-pick]").forEach((r) => r.addEventListener("click", () => { getState().activeBandId = r.dataset.pick; pickerOpen = false; mQuery = ""; persist(); renderBandApp(appContainer); }));
  const nb = view.querySelector("#band-new"); if (nb) nb.addEventListener("click", formBand);
}
function renderBand(view) {
  const b = activeBand();
  const mem = bandMembers(b.id);
  const maxChem = DATA.config.band?.maxChemistry || 100;
  const rehReady = findReady("rehearse", b.id);
  const nextReh = nextCommitment("rehearse", b.id);
  const nextShow = nextCommitment("show", b.id);
  const headcount = mem.length + (b.playerIn ? 1 : 0);

  const youRow = b.playerIn ? `<div class="band-member you"><div class="bd-portrait sm" style="background:#ffd23f">★</div>
      <div class="bm-info"><strong>You</strong><small>bandleader · fame ${playerFame()}</small></div>
      <button class="bm-kick" id="player-leave" title="Leave this band">Leave</button></div>` : "";
  const memberRows = mem.map((m) => `
    <div class="band-member">
      <div class="bd-portrait sm" style="background:${color(m.id)}">${esc(m.name[0])}</div>
      <div class="bm-info"><strong>${esc(m.name)}</strong> <span class="ovr">${musicianOVR(m)}</span>
        ${m.status === "benched" ? `<small style="color:${STATUS.benched.color}">benched</small>` : `<small>${ROLE_LABEL[m.role] || m.role} · fame ${m.fame || 0}</small>`}
        <div class="bm-hap"><div class="bm-hap-bar"><div style="width:${Math.round(m.happiness ?? 70)}%;background:${hapColor(m.happiness ?? 70)}"></div></div></div>
      </div>
      <select class="bm-role" data-role-npc="${m.id}">${ROLES.map((r) => `<option value="${r}" ${m.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>
      <button class="bm-kick" data-remove="${m.id}" title="Remove from band">✕</button>
    </div>`).join("");

  const canBook = !!(b.pressKit && getState().flags?.venue_discovered) && (mem.length || b.playerIn);
  let schedNote = rehReady ? "Your band's here — start the rehearsal."
    : nextReh ? `Next rehearsal: Day ${nextReh.day}, ${slotLabel(nextReh.slot)}.`
    : "Schedule a rehearsal — only slots where your band is free will appear.";
  if (nextShow) schedNote += ` · Next show: Day ${nextShow.day}, ${slotLabel(nextShow.slot)}.`;

  view.innerHTML = `
    ${picker(b)}
    <div class="band-head">
      <div><div class="band-name">${esc(b.name || "Untitled Band")}</div>
        <div class="muted">${headcount} member${headcount === 1 ? "" : "s"}${b.playerIn ? " · you're in" : " · NPC band"} · ${esc(b.genre || "no genre")}</div></div>
      <button class="btn band-mini" id="band-rename">Edit</button>
    </div>
    <div class="band-idstats">
      <div><span>Fans</span><strong>${b.fans || 0}</strong></div>
      <div><span>Renown</span><strong>${b.fame || 0}</strong></div>
      <div><span>Shows</span><strong>${b.showsPlayed || 0}</strong></div>
    </div>
    <div class="bd-stat"><span>Chemistry</span><div class="bd-bar"><div style="width:${Math.round((b.chemistry || 0) / maxChem * 100)}%;background:#ffd23f"></div></div></div>
    <div class="band-roster">${youRow}${memberRows || (b.playerIn ? "" : `<p class="muted" style="padding:8px">No members — recruit at The Dive, or assign someone on the Musicians page.</p>`)}</div>
    ${!b.playerIn ? `<button class="btn band-mini" id="player-join">Join this band (you)</button>` : ""}
    ${b.pressKit ? `<div class="band-pk">Press kit · lead single: <strong>${esc(b.pressKit.songName)}</strong></div>` : ""}
    <div class="band-actions">
      <button class="btn band-mini" id="band-pk">${b.pressKit ? "Reassemble Kit" : "Assemble Press Kit"}</button>
      ${canBook ? `<button class="btn band-mini" id="band-book">Book a Show</button>` : ""}
      ${(mem.length || b.playerIn) ? `<button class="btn band-mini" id="band-write" ${(!b.playerIn && b.pendingWrite) ? "disabled" : ""}>${b.playerIn ? "Write a Song" : (b.pendingWrite ? "Writing demos…" : "Delegate Songwriting")}</button>` : ""}
    </div>
    ${(mem.length || b.playerIn) ? (rehReady ? `<button class="btn band-rehearse" id="band-rehearse">▶ START REHEARSAL (now)</button>`
               : `<button class="btn band-rehearse" id="band-sched">Schedule Rehearsal</button>`) : ""}
    <p class="muted band-foot">${schedNote}</p>`;

  bindPicker(view, b);
  view.querySelector("#band-rename").addEventListener("click", () => editBand(b));
  const reh = view.querySelector("#band-rehearse"); if (reh) reh.addEventListener("click", rehearse);
  const sch = view.querySelector("#band-sched"); if (sch) sch.addEventListener("click", () => openScheduler("rehearse"));
  const bk = view.querySelector("#band-book"); if (bk) bk.addEventListener("click", () => openScheduler("show"));
  view.querySelector("#band-pk").addEventListener("click", assemblePressKit);
  const wr = view.querySelector("#band-write"); if (wr) wr.addEventListener("click", () => writeAction(b));
  const pj = view.querySelector("#player-join"); if (pj) pj.addEventListener("click", () => playerJoin(b, true));
  const pl = view.querySelector("#player-leave"); if (pl) pl.addEventListener("click", () => playerJoin(b, false));
  view.querySelectorAll(".bm-role").forEach((sel) => sel.addEventListener("change", () => setRole(sel.dataset.roleNpc, sel.value)));
  view.querySelectorAll(".bm-kick[data-remove]").forEach((btn) => btn.addEventListener("click", () => releaseMember(btn.dataset.remove)));
}
function editBand(b) {
  const nm = (prompt("Band name:", b.name || "") || "").trim(); if (nm) b.name = nm;
  const g = (prompt("Genre (optional):", b.genre || "") || "").trim(); b.genre = g || b.genre || null;
  persist(); refresh();
}
function playerJoin(b, join) {
  b.playerIn = join;
  if (join) { const add = applyJoinSway(b, { isPlayer: true }); toast(`You joined ${b.name || "the band"}.${add > 0 ? ` Your name brings +${add} buzz.` : ""}`, "good"); }
  else toast(`You stepped back from ${b.name || "the band"}.`, "info");
  persist(); refresh();
}
function formBand() {
  const nm = (prompt("Name your new band:", BAND_NAMES[Math.floor(Math.random() * BAND_NAMES.length)]) || "").trim();
  if (!nm) return;
  const id = "band_" + Date.now().toString(36);
  getState().bands.push({ id, name: nm, genre: null, playerIn: false, chemistry: 0, fans: 0, fame: 0, pressKit: null, showsPlayed: 0 });
  getState().activeBandId = id; pickerOpen = false; mQuery = "";
  persist(); renderBandApp(appContainer);
  toast(`Formed ${nm}. Add members from the Musicians page or recruit at The Dive.`, "good");
}
function setRole(npcId, role) { const m = musicianById(npcId); if (m) { m.role = role; persist(); refresh(); } }
function releaseMember(npcId) {
  const m = musicianById(npcId); if (!m) return;
  const from = bandById(m.bandId);
  setMusicianStatus(npcId, "free_agent");
  persist(); refresh();
  toast(`${m.name} left ${from?.name || "the band"} — now a free agent.`, "info");
}
function writeAction(b) { if (b.playerIn) runWriteNow(b); else delegateWrite(b); }
function runWriteNow(b) {
  const s = getState(); const cfg = DATA.config.band?.write || { minutes: 120, energyCost: 18, moodGain: 3 };
  if ((s.stats.energy ?? 0) < cfg.energyCost) { toast("Too wiped to write. Get some rest first.", "warn"); return; }
  const loops = writeSession(b);
  if (!loops.length) { toast("No one to write with.", "warn"); return; }
  s.patterns = s.patterns || []; s.patterns.push(...loops);
  addStat("energy", -(cfg.energyCost || 18)); addStat("mood", cfg.moodGain || 3);
  advanceMinutes(cfg.minutes || 120);
  persist(); emit("pattern:recorded", { name: loops[0].name }); refresh();
  toast(`Wrote ${loops.length} loop${loops.length > 1 ? "s" : ""} — open the SOUND library to hear & edit.`, "good");
}
function delegateWrite(b) {
  if (b.pendingWrite) { toast(`${b.name || "They"}'re already working on demos.`, "info"); return; }
  b.pendingWrite = { since: getState().time?.day || 1 };
  persist(); refresh();
  toast(`${b.name || "The band"} will work on demos — check the SOUND library tomorrow.`, "good");
}
function assemblePressKit() {
  const s = getState(); const songs = s.songs || []; const b = activeBand();
  if (!songs.length) { toast("Record and save a song first — that's your demo.", "warn"); return; }
  const best = songs.slice().sort((x, y) => songQuality(y, b) - songQuality(x, b))[0];
  b.pressKit = { songId: best.id, songName: best.name, quality: songQuality(best, b), madeAt: Date.now() };
  persist(); emit("presskit:assembled", { song: best.name }); refresh();
  toast(`Press kit ready. Lead single: "${best.name}".`, "good");
}

// ---------------------------- MUSICIANS VIEW ----------------------------
function renderMusicians(view) {
  const all = allMusicians();
  const filters = [["all", "All"], ["band", "In a band"], ["free_agent", "Free agents"], ["retired", "Retired"]];
  const matchFilter = (m) => mFilter === "all" ? m.status !== "retired"
    : mFilter === "band" ? !!m.bandId
    : mFilter === "free_agent" ? m.status === "free_agent"
    : m.status === "retired";
  const list = all.filter((m) => matchFilter(m) && (m.name || "").toLowerCase().includes(mQuery.toLowerCase()));

  view.innerHTML = `
    <input id="m-q" class="browse-q" placeholder="Search musicians…" value="${esc(mQuery)}">
    <div class="browse-filters">${filters.map(([f, lbl]) => `<button class="browse-filter ${mFilter === f ? "active" : ""}" data-mf="${f}">${lbl}</button>`).join("")}</div>
    <div class="m-list">${list.length ? list.map((m) => musicianRow(m)).join("") : `<p class="muted" style="padding:10px">No musicians here yet. Meet some at The Dive.</p>`}</div>`;

  const q = view.querySelector("#m-q");
  q.addEventListener("input", () => { mQuery = q.value; renderMusicians(view); requestAnimationFrame(() => { const n = view.querySelector("#m-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); });
  view.querySelectorAll("[data-mf]").forEach((b) => b.addEventListener("click", () => { mFilter = b.dataset.mf; mExpanded = null; renderMusicians(view); }));
  view.querySelectorAll(".m-row-head").forEach((h) => h.addEventListener("click", () => { const id = h.dataset.m; mExpanded = mExpanded === id ? null : id; renderMusicians(view); }));
  bindMusicianActions(view);
}
function musicianRow(m) {
  const st = STATUS[m.status] || STATUS.active;
  const band = m.bandId ? bandById(m.bandId) : null;
  const where = band ? esc(band.name || "Unnamed") : st.label;
  const expanded = mExpanded === m.id;
  const head = `<button class="m-row-head" data-m="${m.id}">
    <div class="bd-portrait sm" style="background:${color(m.id)}">${esc(m.name[0])}</div>
    <div class="bm-info"><strong>${esc(m.name)}</strong> <span class="ovr">${musicianOVR(m)}</span>
      <small>${esc(where)} · ${ROLE_LABEL[m.role] || m.role} · fame ${m.fame || 0}</small>
      <div class="bm-hap"><div class="bm-hap-bar"><div style="width:${Math.round(m.happiness ?? 70)}%;background:${hapColor(m.happiness ?? 70)}"></div></div></div>
    </div>
    <span class="m-badge" style="border-color:${st.color};color:${st.color}">${st.label}</span>
  </button>`;
  if (!expanded) return `<div class="m-row">${head}</div>`;
  const bandOpts = `<option value="">— Free agent —</option>` + bands().map((b) => `<option value="${b.id}" ${b.id === m.bandId ? "selected" : ""}>${esc(b.name || "Unnamed")}</option>`).join("");
  const actions = m.status === "retired"
    ? `<button class="btn band-mini" data-act="unretire" data-m="${m.id}">Un-retire (→ free agent)</button>`
    : `<div class="m-controls">
        <label>Band <select class="m-band" data-m="${m.id}">${bandOpts}</select></label>
        <label>Plays <select class="m-inst" data-m="${m.id}">${ROLES.map((r) => `<option value="${r}" ${m.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select></label>
      </div>
      <div class="m-buttons">
        ${m.bandId ? `<button class="btn band-mini" data-act="${m.status === "benched" ? "activate" : "bench"}" data-m="${m.id}">${m.status === "benched" ? "Activate" : "Bench"}</button>` : ""}
        ${m.bandId ? `<button class="btn band-mini" data-act="release" data-m="${m.id}">Release</button>` : ""}
        <button class="btn band-mini danger" data-act="retire" data-m="${m.id}">Retire</button>
      </div>`;
  const stats = m.stats || {};
  const statLine = `<div class="m-statline">MUS ${stats.musicianship || 0} · STG ${stats.stagePresence || 0} · SNG ${stats.songwriting || 0} · REL ${stats.reliability || 0}${m.potential ? ` · POT ${m.potential}` : ""}</div>`;
  return `<div class="m-row open">${head}<div class="m-actions">${statLine}${actions}</div></div>`;
}
function bindMusicianActions(view) {
  view.querySelectorAll(".m-band").forEach((sel) => sel.addEventListener("change", () => {
    const id = sel.dataset.m, val = sel.value, m = musicianById(id);
    if (!val) { setMusicianStatus(id, "free_agent"); toast(`${m.name} is now a free agent.`, "info"); }
    else { assignMusician(id, val); const sway = applyJoinSway(bandById(val), m); toast(`${m.name} → ${bandById(val).name || "band"}.${sway > 0 ? ` +${sway} buzz.` : ""}`, "good"); }
    persist(); refresh();
  }));
  view.querySelectorAll(".m-inst").forEach((sel) => sel.addEventListener("change", () => { const m = musicianById(sel.dataset.m); if (m) { m.role = sel.value; persist(); refresh(); } }));
  view.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => {
    const id = btn.dataset.m, m = musicianById(id); if (!m) return;
    const act = btn.dataset.act;
    if (act === "bench") setMusicianStatus(id, "benched");
    else if (act === "activate") setMusicianStatus(id, "active");
    else if (act === "release") { setMusicianStatus(id, "free_agent"); toast(`${m.name} released.`, "info"); }
    else if (act === "retire") { setMusicianStatus(id, "retired"); toast(`${m.name} retired.`, "info"); }
    else if (act === "unretire") { setMusicianStatus(id, "free_agent"); toast(`${m.name} is back — free agent.`, "good"); }
    persist(); refresh();
  }));
}

// ============================ REHEARSE ============================
function neededCategories(b) {
  const tags = new Set();
  for (const m of bandMembers(b.id)) { const npc = npcDef(m.id); (npc?.requires?.practice || []).forEach((t) => tags.add(t)); }
  return tags;
}
function haveAnyCategory(cats) {
  if (!cats.size) return false;
  const items = DATA.items.items;
  return (getState().inventory || []).some((st) => { const it = items[st.item]; return it && (cats.has(it.category) || (it.tags || []).some((t) => cats.has(t))); });
}
function rehearse() {
  const s = getState(); const b = activeBand();
  if (!bandMembers(b.id).length && !b.playerIn) { toast("No band to rehearse with.", "warn"); return; }
  const ready = findReady("rehearse", b.id);
  if (!ready) { toast("Schedule a rehearsal first, then show up during its slot.", "warn"); return; }
  const cfg = DATA.config.band?.rehearse || { minutes: 120, energyCost: 15, chemistryGain: 8, chemistryBonus: 4, moodGain: 2 };
  if ((s.stats.energy ?? 0) < cfg.energyCost) { toast("You're too tired to rehearse. Get some rest.", "warn"); return; }
  complete(ready.id);
  const fed = haveAnyCategory(neededCategories(b));
  const gain = (cfg.chemistryGain || 8) + (fed ? (cfg.chemistryBonus || 0) : 0);
  const maxChem = DATA.config.band?.maxChemistry || 100;
  b.chemistry = Math.min(maxChem, (b.chemistry || 0) + gain);
  addStat("energy", -(cfg.energyCost || 15));
  addStat("mood", cfg.moodGain || 2);
  adjustHappiness(b, H().rehearse + (fed ? H().rehearseBonus : 0));
  advanceMinutes(cfg.minutes || 120);
  persist(); emit("band:rehearsed", { chemistry: b.chemistry, bandId: b.id }); refresh();
  toast(`Rehearsed. Chemistry +${gain}${fed ? " (bandmates fed!)" : ""}.`, "good");
}

// ============================ HAPPINESS (event-driven) ============================
function adjustHappiness(band, delta) { for (const m of bandMembers(band.id)) m.happiness = Math.max(0, Math.min(100, (m.happiness ?? 70) + delta)); }
on("show:played", ({ bandId, quality }) => { const b = bandById(bandId); if (!b) return; adjustHappiness(b, H().show + Math.round((quality || 0) / (H().showQualityDiv || 20))); persist(); });
on("commitment:missed", ({ bandId, type }) => { const b = bandById(bandId); if (!b) return; adjustHappiness(b, -(type === "show" ? H().missShow : H().missReh)); persist(); });
on("day:advanced", () => {
  ensureMusicianModel();
  const h = H(); const quits = [];
  const wrote = [];
  for (const b of bands()) {
    const loyal = !!b.playerIn;
    const decay = loyal ? h.idleDecayLoyal : h.idleDecay;
    for (const m of bandMembers(b.id)) {
      m.happiness = Math.max(0, Math.min(100, (m.happiness ?? 70) - decay));
      if (!loyal && (m.happiness ?? 70) <= h.quitThreshold && Math.random() < h.quitChance) {
        setMusicianStatus(m.id, "free_agent"); quits.push({ name: m.name, band: b.name });
      }
    }
    if (b.pendingWrite && !b.playerIn) {                 // delegated NPC bands deliver overnight
      const loops = writeSession(b);
      if (loops.length) { const s = getState(); s.patterns = s.patterns || []; s.patterns.push(...loops); wrote.push({ band: b.name, n: loops.length }); }
      b.pendingWrite = null;
    }
  }
  persist();
  if (quits.length) { refresh(); quits.forEach((q) => toast(`${q.name} quit ${q.band || "the band"} — now a free agent.`, "warn")); }
  if (wrote.length) { refresh(); wrote.forEach((w) => toast(`${w.band || "Your band"} wrote ${w.n} new loop${w.n > 1 ? "s" : ""} while you were away — check the SOUND library.`, "good")); }
});
