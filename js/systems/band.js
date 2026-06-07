// ============================================================
// band.js — Band Management 2.0 (Step 10).
//
// Multiple bands (you must be in Band #1, a forgiving starter crew).
// Recruit musicians into the ACTIVE band, assign/reassign their
// instrument, kick members, and form new bands. Each NPC member
// has HAPPINESS that moves at events — rehearsals and shows raise
// it, missed commitments and neglect lower it, and (outside your
// loyal Band #1) unhappy members can QUIT. Press kit, rehearsing,
// and show-booking all operate on the active band.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, setFlag, activeBand, bandById, roleFromArchetype } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { advanceMinutes } from "./time.js";
import { songQuality } from "./shows.js";
import { findReady, nextCommitment, complete, openScheduler, slotLabel } from "./calendar.js";

const NPC_COLOR = { npc_brian: "#ff8a3d", npc_lex: "#4fc3f7", npc_ruby: "#ff3b6b", npc_jo: "#b388ff" };
const BAND_NAMES = ["The Damp Sells", "Parking Lot Gods", "Wet Sprocket Jr.", "The Landlords", "Crab Rangoon", "Future Tenants", "The Damage Deposit", "Couch Surfers", "Night Shift", "The Security Deposit"];
const ROLES = ["guitar", "bass", "drums", "piano", "vocals"];
const ROLE_LABEL = { guitar: "Guitar", bass: "Bass", drums: "Drums", piano: "Keys", vocals: "Vocals" };

let overlay = null, viewing = null;

const npcDef = (id) => (DATA.npcs.npcs || []).find((n) => n.id === id) || null;
const bands = () => getState().bands || [];
const H = () => Object.assign({ start: 70, rehearse: 6, rehearseBonus: 4, show: 4, showQualityDiv: 20, missShow: 18, missReh: 12, idleDecay: 2, idleDecayLoyal: 1, quitThreshold: 15, quitChance: 0.5 }, DATA.config.band?.happiness || {});
const isMemberAnywhere = (id) => bands().some((b) => b.members.some((m) => m.id === id));
const bandOf = (id) => bands().find((b) => b.members.some((m) => m.id === id)) || null;
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const color = (id) => NPC_COLOR[id] || "#7CFC9B";
const hapColor = (h) => (h >= 60 ? "#7CFC9B" : h >= 30 ? "#ffd23f" : "#ff3b6b");

function conditionsMet(npc) {
  const rc = npc.recruitConditions || {};
  if (rc.flag && !getState().flags?.[rc.flag]) return false;
  if (rc.minFame && (getState().stats.fame || 0) < rc.minFame) return false;
  return true;
}
const hasDemo = () => (getState().songs || []).length > 0;

// ============================ RECRUIT MODAL ============================
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
function bar(label, v, col) {
  return `<div class="bd-stat"><span>${label}</span><div class="bd-bar"><div style="width:${Math.round(v * 100)}%;background:${col}"></div></div></div>`;
}
function renderRecruit() {
  const npc = npcDef(viewing); if (!npc) return;
  const existing = bandOf(viewing);
  const ab = activeBand();
  const ok = !existing && hasDemo() && conditionsMet(npc);
  let actionHTML, note = "";
  if (existing) actionHTML = `<button class="btn" disabled>✓ In ${esc(existing.name || "your band")}</button>`;
  else {
    actionHTML = `<button class="btn bd-recruit" id="bd-invite" ${ok ? "" : "disabled"}>Invite to ${esc(ab?.name || "your band")}</button>`;
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
  const inv = overlay.querySelector("#bd-invite");
  if (inv) inv.addEventListener("click", () => recruit(viewing));
}
function recruit(npcId) {
  const npc = npcDef(npcId); const b = activeBand();
  if (!b || isMemberAnywhere(npcId)) return;
  b.members.push({ id: npcId, name: npc.name, archetype: npc.archetype, skill: npc.skill, reliability: npc.reliability, role: roleFromArchetype(npc.archetype), happiness: H().start });
  if (!b.name) {
    const suggested = BAND_NAMES[Math.floor(Math.random() * BAND_NAMES.length)];
    b.name = ((prompt("You've got a band! Name it:", suggested) || suggested).trim()) || suggested;
  }
  persist();
  emit("band:recruited", { id: npcId, bandId: b.id });
  emit("renderAll");
  toast(`${npc.name} joined ${b.name}. (${b.members.length} member${b.members.length > 1 ? "s" : ""})`, "good");
  renderRecruit();
}

// ============================ BAND APP ============================
export function renderBandApp(container) {
  const b = activeBand();
  const list = bands();
  const switcher = `
    <div class="band-switch">
      ${list.length > 1 ? `<select id="band-pick">${list.map((x) => `<option value="${x.id}" ${x.id === b.id ? "selected" : ""}>${esc(x.name || "Unnamed")}${x.playerIn ? " ★" : ""}</option>`).join("")}</select>` : ""}
      <button class="btn band-mini" id="band-new">+ New Band</button>
    </div>`;

  if (!b.members.length && !b.name) {
    container.innerHTML = `<h2 class="app-title">BAND</h2>${switcher}
      <div class="stub"><div class="stub-glyph">🎸</div><p>No band yet.</p>
      <p class="muted">Head into The Dive and recruit musicians into this band. You'll need a saved song to impress them.</p></div>`;
    bindSwitcher(container);
    return;
  }

  const maxChem = DATA.config.band?.maxChemistry || 100;
  const rehReady = findReady("rehearse", b.id);
  const nextReh = nextCommitment("rehearse", b.id);
  const nextShow = nextCommitment("show", b.id);
  const canBook = !!(b.pressKit && getState().flags?.venue_discovered);
  let schedNote = rehReady ? "Your band's here — start the rehearsal."
    : nextReh ? `Next rehearsal: Day ${nextReh.day}, ${slotLabel(nextReh.slot)}.`
    : "Schedule a rehearsal — only slots where your band is free will appear.";
  if (nextShow) schedNote += ` · Next show: Day ${nextShow.day}, ${slotLabel(nextShow.slot)}.`;
  else if (!b.pressKit) schedNote += " Assemble a press kit to book shows.";

  const youRow = b.playerIn ? `<div class="band-member you"><div class="bd-portrait sm" style="background:#ffd23f">★</div>
      <div><strong>You</strong><small>bandleader</small></div></div>` : "";
  const memberRows = b.members.map((m) => `
    <div class="band-member">
      <div class="bd-portrait sm" style="background:${color(m.id)}">${esc(m.name[0])}</div>
      <div class="bm-info"><strong>${esc(m.name)}</strong>
        <div class="bm-hap"><div class="bm-hap-bar"><div style="width:${Math.round(m.happiness ?? 70)}%;background:${hapColor(m.happiness ?? 70)}"></div></div></div>
      </div>
      <select class="bm-role" data-role-npc="${m.id}">${ROLES.map((r) => `<option value="${r}" ${m.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>
      <button class="bm-kick" data-remove="${m.id}" title="Remove from band">✕</button>
    </div>`).join("");

  container.innerHTML = `
    <h2 class="app-title">BAND</h2>
    ${switcher}
    <div class="band-head">
      <div><div class="band-name">${esc(b.name || "Untitled Band")}</div>
        <div class="muted">${b.members.length + (b.playerIn ? 1 : 0)} member${(b.members.length + (b.playerIn ? 1 : 0)) > 1 ? "s" : ""}${b.playerIn ? " · you're in" : " · NPC band"}</div></div>
      <button class="btn band-mini" id="band-rename">Rename</button>
    </div>
    <div class="bd-stat"><span>Chemistry</span><div class="bd-bar"><div style="width:${Math.round((b.chemistry || 0) / maxChem * 100)}%;background:#ffd23f"></div></div></div>
    <div class="band-roster">${youRow}${memberRows || (b.playerIn ? "" : `<p class="muted" style="padding:8px">No members yet — recruit some at The Dive.</p>`)}</div>
    ${b.pressKit ? `<div class="band-pk">Press kit · lead single: <strong>${esc(b.pressKit.songName)}</strong></div>` : ""}
    <div class="band-actions">
      <button class="btn band-mini" id="band-pk">${b.pressKit ? "Reassemble Kit" : "Assemble Press Kit"}</button>
      ${canBook ? `<button class="btn band-mini" id="band-book">Book a Show</button>` : ""}
    </div>
    ${rehReady ? `<button class="btn band-rehearse" id="band-rehearse">▶ START REHEARSAL (now)</button>`
               : `<button class="btn band-rehearse" id="band-sched">Schedule Rehearsal</button>`}
    <p class="muted band-foot">${schedNote}</p>`;

  bindSwitcher(container);
  container.querySelector("#band-rename").addEventListener("click", () => {
    const nm = (prompt("Rename this band:", b.name || "") || "").trim();
    if (nm) { b.name = nm; persist(); emit("renderAll"); }
  });
  const reh = container.querySelector("#band-rehearse"); if (reh) reh.addEventListener("click", rehearse);
  const sch = container.querySelector("#band-sched"); if (sch) sch.addEventListener("click", () => openScheduler("rehearse"));
  const bk = container.querySelector("#band-book"); if (bk) bk.addEventListener("click", () => openScheduler("show"));
  container.querySelector("#band-pk").addEventListener("click", assemblePressKit);
  container.querySelectorAll(".bm-role").forEach((sel) => sel.addEventListener("change", () => setRole(sel.dataset.roleNpc, sel.value)));
  container.querySelectorAll(".bm-kick").forEach((btn) => btn.addEventListener("click", () => removeMember(btn.dataset.remove)));
}

function bindSwitcher(container) {
  const pick = container.querySelector("#band-pick");
  if (pick) pick.addEventListener("change", () => { getState().activeBandId = pick.value; persist(); emit("renderAll"); });
  container.querySelector("#band-new").addEventListener("click", formBand);
}
function formBand() {
  const nm = (prompt("Name your new band:", BAND_NAMES[Math.floor(Math.random() * BAND_NAMES.length)]) || "").trim();
  if (!nm) return;
  const id = "band_" + (Date.now().toString(36));
  getState().bands.push({ id, name: nm, members: [], chemistry: 0, pressKit: null, showsPlayed: 0, playerIn: false });
  getState().activeBandId = id;
  persist(); emit("renderAll");
  toast(`Formed ${nm}. Recruit members at The Dive.`, "good");
}
function setRole(npcId, role) {
  const b = activeBand(); const m = b.members.find((x) => x.id === npcId);
  if (m) { m.role = role; persist(); emit("renderAll"); }
}
function removeMember(npcId) {
  const b = activeBand(); const m = b.members.find((x) => x.id === npcId);
  if (!m) return;
  b.members = b.members.filter((x) => x.id !== npcId);
  persist(); emit("renderAll");
  toast(`${m.name} left ${b.name || "the band"}.`, "info");
}
function assemblePressKit() {
  const s = getState(); const songs = s.songs || []; const b = activeBand();
  if (!songs.length) { toast("Record and save a song first — that's your demo.", "warn"); return; }
  const best = songs.slice().sort((x, y) => songQuality(y, b) - songQuality(x, b))[0];
  b.pressKit = { songId: best.id, songName: best.name, quality: songQuality(best, b), madeAt: Date.now() };
  persist(); emit("presskit:assembled", { song: best.name }); emit("renderAll");
  toast(`Press kit ready. Lead single: "${best.name}".`, "good");
}

function neededCategories(b) {
  const tags = new Set();
  for (const m of b.members) { const npc = npcDef(m.id); (npc?.requires?.practice || []).forEach((t) => tags.add(t)); }
  return tags;
}
function haveAnyCategory(cats) {
  if (!cats.size) return false;
  const items = DATA.items.items;
  return (getState().inventory || []).some((st) => { const it = items[st.item]; return it && (cats.has(it.category) || (it.tags || []).some((t) => cats.has(t))); });
}
function rehearse() {
  const s = getState(); const b = activeBand();
  if (!b.members.length) { toast("No band to rehearse with.", "warn"); return; }
  const ready = findReady("rehearse", b.id);
  if (!ready) { toast("Schedule a rehearsal first, then show up during its slot.", "warn"); return; }
  const cfg = DATA.config.band?.rehearse || { minutes: 120, energyCost: 15, chemistryGain: 8, chemistryBonus: 4, moodGain: 2 };
  if ((s.stats.energy ?? 0) < cfg.energyCost) { toast("You're too tired to rehearse. Get some rest.", "warn"); return; }
  complete(ready.id);
  const fed = haveAnyCategory(neededCategories(b));
  const bonus = fed ? (cfg.chemistryBonus || 0) : 0;
  const gain = (cfg.chemistryGain || 8) + bonus;
  const maxChem = DATA.config.band?.maxChemistry || 100;
  b.chemistry = Math.min(maxChem, (b.chemistry || 0) + gain);
  addStat("energy", -(cfg.energyCost || 15));
  addStat("mood", cfg.moodGain || 2);
  adjustHappiness(b, H().rehearse + (fed ? H().rehearseBonus : 0));
  advanceMinutes(cfg.minutes || 120);
  persist();
  emit("band:rehearsed", { chemistry: b.chemistry, bandId: b.id });
  emit("renderAll");
  toast(`Rehearsed. Chemistry +${gain}${fed ? " (bandmates fed!)" : ""}.`, "good");
}

// ============================ HAPPINESS (event-driven) ============================
function adjustHappiness(band, delta) {
  if (!band) return;
  for (const m of band.members) m.happiness = Math.max(0, Math.min(100, (m.happiness ?? 70) + delta));
}
on("show:played", ({ bandId, quality }) => {
  const b = bandById(bandId); if (!b) return;
  adjustHappiness(b, H().show + Math.round((quality || 0) / (H().showQualityDiv || 20)));
  persist();
});
on("commitment:missed", ({ bandId, type }) => {
  const b = bandById(bandId); if (!b) return;
  adjustHappiness(b, -(type === "show" ? H().missShow : H().missReh));
  persist();
});
on("day:advanced", () => {
  activeBand();                       // ensure legacy saves migrate before decay
  const h = H(); const quits = [];
  for (const b of bands()) {
    const loyal = b.id === "band_1";
    const decay = loyal ? h.idleDecayLoyal : h.idleDecay;
    for (const m of b.members) m.happiness = Math.max(0, Math.min(100, (m.happiness ?? 70) - decay));
    if (!loyal) {
      for (const m of [...b.members]) {
        if ((m.happiness ?? 70) <= h.quitThreshold && Math.random() < h.quitChance) {
          b.members = b.members.filter((x) => x.id !== m.id);
          quits.push({ name: m.name, band: b.name });
        }
      }
    }
  }
  persist();
  if (quits.length) { emit("renderAll"); quits.forEach((q) => toast(`${q.name} quit ${q.band || "the band"} — you neglected them.`, "warn")); }
});
