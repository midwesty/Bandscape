// ============================================================
// dialogue.js — generic, data-driven NPC conversations (Step 24.5).
// All content lives in data/dialogue.json -> trees[<npcId>]; this engine
// holds NO per-NPC logic, so a future builder can add/edit/remove lines,
// conditions, choices, and relationship effects without touching code.
//
// Tree: { speaker, start, entry?:[{node,when}], nodes:{ id:{ text, effects[], choices[] } } }
// choice: { text, when?, effects?, goto?|end? }   when: minRapport/maxRapport,
// flag/flagNot, minReleases/minFame/minFans, slot, town.   effects: rapport{amount},
// flagSet{flag,value}, toast{text,kind}. Auto + choice rapport are capped to one
// gain per in-game day per NPC (no grinding).
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, setFlag, getRapport, addRapport, addContact, townBuzz } from "../engine/state.js";
import { currentSlot } from "./calendar.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let overlay = null, tree = null, npc = null;

function fill(t) { const s = getState(); return String(t || "").replace(/\{name\}/g, tree && tree.speaker || "").replace(/\{playerName\}/g, (s.player && s.player.name) || "you"); }
function cond(w) {
  if (!w) return true;
  const s = getState(), rap = getRapport(npc);
  if (w.minRapport != null && rap < w.minRapport) return false;
  if (w.maxRapport != null && rap > w.maxRapport) return false;
  if (w.flag && !(s.flags && s.flags[w.flag])) return false;
  if (w.flagNot && (s.flags && s.flags[w.flagNot])) return false;
  if (w.minReleases != null && (s.releases || []).length < w.minReleases) return false;
  if (w.minFame != null && (s.stats.fame || 0) < w.minFame) return false;
  if (w.minFans != null && (s.stats.fans || 0) < w.minFans) return false;
  if (w.minShows != null && (s.stats.showsPlayed || 0) < w.minShows) return false;
  if (w.minBuzz != null) { const nt = ((DATA.npcs && DATA.npcs.npcs) || []).find((x) => x.id === npc); if (townBuzz(nt && nt.town) < w.minBuzz) return false; }
  if (w.slot && currentSlot() !== w.slot) return false;
  if (w.town && s.location !== w.town) return false;
  return true;
}
function entryNode(t) {
  if (Array.isArray(t.entry)) for (const e of t.entry) if (cond(e.when)) return e.node;
  return t.start || Object.keys(t.nodes || {})[0];
}
function greetedToday() { const s = getState(); return (s.rapportDay && s.rapportDay[npc]) === ((s.time && s.time.day) || 1); }
function grantRapport(amount) {  // once per in-game day per NPC
  if (greetedToday()) return;
  const s = getState(); addRapport(npc, amount || 0); s.rapportDay = s.rapportDay || {}; s.rapportDay[npc] = (s.time && s.time.day) || 1;
}
function applyEffects(effects) {
  if (!Array.isArray(effects)) return;
  for (const e of effects) {
    if (e.type === "flagSet") setFlag(e.flag, e.value !== undefined ? e.value : true);
    else if (e.type === "rapport") { if (e.bypassDaily) addRapport(npc, e.amount || 0); else grantRapport(e.amount || 0); }
    else if (e.type === "toast") toast(fill(e.text), e.kind || "info");
  }
}
function persist() { const s = getState(); try { saveToSlot(s.meta.slot, s); } catch (e) {} }
function rapPips(r) { const f = Math.max(0, Math.min(5, Math.round(r / 20))); return "\u2665".repeat(f) + "\u2661".repeat(5 - f); }

export function openDialogue(npcId, fallback) {
  const t = DATA.dialogue && DATA.dialogue.trees && DATA.dialogue.trees[npcId];
  if (!t) { if (fallback && fallback.flavor) toast(fallback.flavor, "info"); return; }
  tree = t; npc = npcId;
  addContact({ id: npcId, name: t.speaker || npcId });
  overlay = overlay || document.getElementById("dialogue");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  showNode(entryNode(t));
}
export function closeDialogue() {
  if (!overlay) return;
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}
function showNode(id) {
  const node = tree.nodes && tree.nodes[id];
  if (!node) { closeDialogue(); return; }
  applyEffects(node.effects); persist();
  const choices = (node.choices || []).filter((c) => cond(c.when));
  overlay.innerHTML = `
    <div class="dlg-modal">
      <div class="dlg-head"><span class="dlg-who">${esc(tree.speaker || npc)}</span><span class="dlg-rap" title="rapport">${rapPips(getRapport(npc))}</span><button class="dlg-x" id="dlg-x">\u2715</button></div>
      <p class="dlg-text">${esc(fill(node.text))}</p>
      <div class="dlg-choices">${choices.length ? choices.map((c, i) => `<button class="dlg-choice" data-i="${i}">${esc(fill(c.text))}</button>`).join("") : `<button class="dlg-choice" data-end="1">(end)</button>`}</div>
    </div>`;
  overlay.querySelector("#dlg-x").addEventListener("click", closeDialogue);
  overlay.querySelectorAll(".dlg-choice").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.end) { closeDialogue(); return; }
    const c = choices[+b.dataset.i]; applyEffects(c.effects); persist();
    if (c.goto && tree.nodes[c.goto]) { showNode(c.goto); return; }
    closeDialogue();
  }));
}
