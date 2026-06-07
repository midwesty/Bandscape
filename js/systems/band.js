// ============================================================
// band.js — recruiting, band roster, and rehearsing (Step 7).
//
// Recruit musicians inside The Dive (tap them to talk). You need a
// demo — at least one saved song — before anyone takes you
// seriously. Your first recruit prompts you to name the band.
// The BAND phone app holds the roster + chemistry and lets you
// REHEARSE (costs energy + time, builds chemistry — which Step 8
// shows will turn into money/fame). Emits band:recruited,
// band:rehearsed.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, setFlag } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { advanceMinutes } from "./time.js";
import { songQuality } from "./shows.js";

const NPC_COLOR = { npc_brian: "#ff8a3d", npc_lex: "#4fc3f7", npc_ruby: "#ff3b6b", npc_jo: "#b388ff" };
const BAND_NAMES = ["The Damp Sells", "Parking Lot Gods", "Wet Sprocket Jr.", "The Landlords", "Crab Rangoon", "Future Tenants", "The Damage Deposit", "Couch Surfers"];

let overlay = null, viewing = null;

const npcDef = (id) => (DATA.npcs.npcs || []).find((n) => n.id === id) || null;
const band = () => { const s = getState(); s.band = s.band || { name: null, members: [], chemistry: 0 }; if (s.band.chemistry == null) s.band.chemistry = 0; return s.band; };
const isMember = (id) => band().members.some((m) => m.id === id);
const hasDemo = () => (getState().songs || []).length > 0;
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const color = (id) => NPC_COLOR[id] || "#7CFC9B";

function conditionsMet(npc) {
  const rc = npc.recruitConditions || {};
  if (rc.flag && !getState().flags?.[rc.flag]) return false;
  if (rc.minFame && (getState().stats.fame || 0) < rc.minFame) return false;
  return true;
}

// ---- recruit modal ----
export function openRecruit(npcId) {
  const npc = npcDef(npcId); if (!npc) return;
  setFlag("met_" + npcId.replace("npc_", ""), true);          // meeting them
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
  const mem = isMember(viewing);
  const ok = !mem && hasDemo() && conditionsMet(npc);
  let actionHTML, note = "";
  if (mem) actionHTML = `<button class="btn" disabled>✓ In your band</button>`;
  else {
    actionHTML = `<button class="btn bd-recruit" id="bd-invite" ${ok ? "" : "disabled"}>Invite to band</button>`;
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
  const npc = npcDef(npcId); const b = band();
  if (isMember(npcId)) return;
  b.members.push({ id: npcId, name: npc.name, archetype: npc.archetype, skill: npc.skill, reliability: npc.reliability });
  if (!b.name) {
    const suggested = BAND_NAMES[Math.floor(Math.random() * BAND_NAMES.length)];
    b.name = ((prompt("You've got a band! Name it:", suggested) || suggested).trim()) || suggested;
  }
  persist();
  emit("band:recruited", { id: npcId });
  emit("renderAll");
  toast(`${npc.name} joined ${b.name}. (${b.members.length} member${b.members.length > 1 ? "s" : ""})`, "good");
  renderRecruit();
}

// ---- BAND phone app ----
export function renderBandApp(container) {
  const b = band();
  if (!b.members.length) {
    container.innerHTML = `<h2 class="app-title">BAND</h2><div class="stub"><div class="stub-glyph">🎸</div>
      <p>No band yet.</p><p class="muted">Head into The Dive on your block and recruit some musicians. You'll need a saved song to impress them.</p></div>`;
    return;
  }
  const maxChem = DATA.config.band?.maxChemistry || 100;
  container.innerHTML = `
    <div class="band-head">
      <div><div class="band-name">${esc(b.name || "Untitled Band")}</div><div class="muted">${b.members.length} member${b.members.length > 1 ? "s" : ""}</div></div>
      <button class="btn band-mini" id="band-rename">Rename</button>
    </div>
    <div class="bd-stat"><span>Chemistry</span><div class="bd-bar"><div style="width:${Math.round((b.chemistry || 0) / maxChem * 100)}%;background:#ffd23f"></div></div></div>
    <div class="band-roster">
      ${b.members.map((m) => `<div class="band-member"><div class="bd-portrait sm" style="background:${color(m.id)}">${esc(m.name[0])}</div>
        <div><strong>${esc(m.name)}</strong><small>${esc(m.archetype)} · skill ${Math.round((m.skill || 0) * 100)}</small></div></div>`).join("")}
    </div>
    ${b.pressKit ? `<div class="band-pk">Press kit · lead single: <strong>${esc(b.pressKit.songName)}</strong></div>` : ""}
    <div class="band-actions"><button class="btn band-mini" id="band-pk">${b.pressKit ? "Reassemble" : "Assemble Press Kit"}</button></div>
    <button class="btn band-rehearse" id="band-rehearse">REHEARSE</button>
    <p class="muted band-foot">Rehearsing builds chemistry — costs energy and a couple hours. A <em>press kit</em> (your best song as a lead single) lets you book shows at The Dive.</p>`;
  container.querySelector("#band-rehearse").addEventListener("click", rehearse);
  container.querySelector("#band-rename").addEventListener("click", () => {
    const nm = (prompt("Rename your band:", b.name || "") || "").trim();
    if (nm) { b.name = nm; persist(); emit("renderAll"); }
  });
  container.querySelector("#band-pk").addEventListener("click", assemblePressKit);
}
function assemblePressKit() {
  const s = getState(); const songs = s.songs || [];
  if (!songs.length) { toast("Record and save a song first — that's your demo.", "warn"); return; }
  const best = songs.slice().sort((a, b) => songQuality(b) - songQuality(a))[0];
  band().pressKit = { songId: best.id, songName: best.name, quality: songQuality(best), madeAt: Date.now() };
  persist();
  emit("presskit:assembled", { song: best.name });
  emit("renderAll");
  toast(`Press kit ready. Lead single: "${best.name}".`, "good");
}

function neededCategories(b) {
  const tags = new Set();
  for (const m of b.members) {
    const npc = npcDef(m.id); const reqs = npc?.requires?.practice || [];
    reqs.forEach((t) => tags.add(t));
  }
  return tags;
}
function haveAnyCategory(cats) {
  if (!cats.size) return false;
  const items = DATA.items.items;
  return (getState().inventory || []).some((st) => { const it = items[st.item]; return it && (cats.has(it.category) || (it.tags || []).some((t) => cats.has(t))); });
}
function rehearse() {
  const s = getState(); const b = band();
  if (!b.members.length) { toast("No band to rehearse with.", "warn"); return; }
  const cfg = DATA.config.band?.rehearse || { minutes: 120, energyCost: 15, chemistryGain: 8, chemistryBonus: 4, moodGain: 2 };
  if ((s.stats.energy ?? 0) < cfg.energyCost) { toast("You're too tired to rehearse. Get some rest.", "warn"); return; }
  const bonus = haveAnyCategory(neededCategories(b)) ? (cfg.chemistryBonus || 0) : 0;
  const gain = (cfg.chemistryGain || 8) + bonus;
  const maxChem = DATA.config.band?.maxChemistry || 100;
  b.chemistry = Math.min(maxChem, (b.chemistry || 0) + gain);
  addStat("energy", -(cfg.energyCost || 15));
  addStat("mood", cfg.moodGain || 2);
  advanceMinutes(cfg.minutes || 120);
  persist();
  emit("band:rehearsed", { chemistry: b.chemistry });
  emit("renderAll");
  toast(`Rehearsed. Chemistry +${gain}${bonus ? " (bandmates fed!)" : ""}.`, "good");
}
