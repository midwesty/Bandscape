// ============================================================
// inventory.js — items: use, stack, split, transfer, drop.
//
// Containers: "inventory" (your pockets), "fridge", "storage".
// Each is an array of stacks { item, qty }. Capacities + items
// come from JSON (config.inventory + items.json), so everything
// is editable without code.
//
// UI: tap a slot to select it, then act via the bottom bar
// (Use / Split / Move / Drop) — reliable on touch AND mouse.
// You can also DRAG a stack onto the other pane to transfer it.
// Dropping puts the item on the floor as a pick-up-able object
// (handled by stage.js via the bus).
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, setFlag } from "../engine/state.js";
import { addCondition, removeCondition } from "./conditions.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { applyArt } from "../ui/placeholder.js";
import { toast } from "../ui/toast.js";

let overlay = null;
let mode = "pockets";      // "pockets" | "container"
let otherKey = null;        // the open container key in container mode
let selected = null;        // { key, index }
let isOpen = false;

const CONTAINER_NAMES = { inventory: "Pockets", fridge: "Fridge", storage: "Storage Crate" };

// ---- data helpers ----
function itemDef(id) { return DATA.items.items[id] || null; }
function containerRef(key) {
  const s = getState();
  if (key === "inventory") return s.inventory;
  s.containers = s.containers || { fridge: [], storage: [] };
  s.containers[key] = s.containers[key] || [];
  return s.containers[key];
}
function capacity(key) {
  const cfg = DATA.config.inventory || {};
  if (key === "inventory") return cfg.pocketSlots || 12;
  if (key === "fridge") return cfg.fridgeSlots || 24;
  return cfg.storageSlots || 24;
}

// ---- core operations ----
export function giveItem(key, itemId, qty) {
  const def = itemDef(itemId);
  if (!def) return qty;
  const arr = containerRef(key), cap = capacity(key), max = def.stackMax || 1;
  let remaining = qty;
  for (const st of arr) { if (remaining <= 0) break; if (st.item === itemId && st.qty < max) { const add = Math.min(max - st.qty, remaining); st.qty += add; remaining -= add; } }
  while (remaining > 0 && arr.length < cap) { const add = Math.min(max, remaining); arr.push({ item: itemId, qty: add }); remaining -= add; }
  return remaining; // leftover that didn't fit
}

function applyEffects(effects) {
  const s = getState();
  for (const e of (effects || [])) {
    switch (e.type) {
      case "statAdd": addStat(e.stat, e.value); break;
      case "conditionAdd": addCondition(e.conditionId); break;
      case "conditionRemove": removeCondition(e.conditionId); break;
      case "addiction": s.addictions = s.addictions || {}; s.addictions[e.substance] = (s.addictions[e.substance] || 0) + (e.value || 0); break;
      case "flagSet": setFlag(e.flag, e.value); break;
      case "oneOf": { const opts = e.effects || []; if (opts.length) applyEffects(opts[Math.floor(Math.random() * opts.length)]); break; }
    }
  }
}

function useStack(key, index) {
  const arr = containerRef(key), st = arr[index];
  if (!st) return;
  const def = itemDef(st.item);
  if (!def) return;
  if (!def.onUse || !def.onUse.length) { toast(`${def.name}: not much to do with that right now.`, "info"); return; }
  applyEffects(def.onUse);
  toast(`Used ${def.name}.`, "good");
  st.qty -= 1;
  if (st.qty <= 0) { arr.splice(index, 1); selected = null; }
  emit("item:used", { item: st.item });
  commit();
}

function splitStack(key, index) {
  const arr = containerRef(key), st = arr[index];
  if (!st || st.qty < 2) { toast("Need at least 2 to split.", "warn"); return; }
  if (arr.length >= capacity(key)) { toast("No free slot to split into.", "warn"); return; }
  const half = Math.floor(st.qty / 2);
  st.qty -= half;
  arr.push({ item: st.item, qty: half });
  commit();
}

function moveStack(fromKey, fromIndex, toKey) {
  if (fromKey === toKey) return;
  const from = containerRef(fromKey), st = from[fromIndex];
  if (!st) return;
  const leftover = giveItem(toKey, st.item, st.qty);
  const moved = st.qty - leftover;
  if (moved <= 0) { toast(`No room in the ${CONTAINER_NAMES[toKey]}.`, "warn"); return; }
  st.qty = leftover;
  if (st.qty <= 0) { from.splice(fromIndex, 1); selected = null; }
  emit("item:moved", { item: st.item, from: fromKey, to: toKey });
  if (leftover > 0) toast(`Only some fit in the ${CONTAINER_NAMES[toKey]}.`, "warn");
  commit();
}

function dropStack(key, index) {
  const arr = containerRef(key), st = arr[index];
  if (!st) return;
  const def = itemDef(st.item) || {};
  emit("room:dropItem", { item: st.item, qty: st.qty, name: def.name || st.item, icon: def.icon });
  arr.splice(index, 1);
  selected = null;
  emit("item:dropped", { item: st.item });
  toast(`Dropped ${def.name || st.item} on the floor.`, "info");
  commit();
}

function commit() {
  const s = getState();
  saveToSlot(s.meta.slot, s);
  emit("renderAll");        // refresh HUD (stats may have changed)
  if (isOpen) render();
}

// ---- UI ----
export function initInventory() {
  overlay = document.getElementById("inventory");
  document.getElementById("bag-button")?.addEventListener("click", () => (isOpen ? closeInventory() : openInventory()));
  overlay?.addEventListener("click", (e) => { if (e.target === overlay) closeInventory(); });
}

export function openInventory() {
  mode = "pockets"; otherKey = null; selected = null;
  show(); emit("inventory:opened", { view: "pockets" });
}
export function openContainerView(key) {
  mode = "container"; otherKey = key; selected = null;
  show();
  emit("inventory:opened", { view: "container" });
  emit("container:opened", { id: key });
}
export function closeInventory() {
  isOpen = false;
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}

function show() {
  isOpen = true;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  render();
}

function render() {
  if (!overlay) return;
  const panes = mode === "container" ? [otherKey, "inventory"] : ["inventory"];
  overlay.innerHTML = `
    <div class="inv-modal">
      <div class="inv-head">
        <span class="inv-title">${mode === "container" ? CONTAINER_NAMES[otherKey] : "POCKETS"}</span>
        <button class="phone-nav" id="inv-close">✕</button>
      </div>
      <div class="inv-body">${panes.map(paneHTML).join("")}</div>
      <div class="inv-actions" id="inv-actions">${actionBarHTML()}</div>
      <div class="inv-hint">tap an item to select · drag a stack to the other side to move it</div>
    </div>`;

  overlay.querySelector("#inv-close").addEventListener("click", closeInventory);
  bindSlots();
  bindActions();
}

function paneHTML(key) {
  const arr = containerRef(key), cap = capacity(key);
  const slots = [];
  for (let i = 0; i < cap; i++) {
    const st = arr[i];
    if (st) {
      const def = itemDef(st.item) || { name: st.item };
      const sel = selected && selected.key === key && selected.index === i ? "sel" : "";
      slots.push(`
        <div class="inv-slot ${sel}" data-key="${key}" data-index="${i}">
          <img class="inv-icon" data-icon="${def.icon || ""}" data-label="${def.name}">
          ${st.qty > 1 ? `<span class="inv-qty">${st.qty}</span>` : ""}
          <span class="inv-name">${def.name}</span>
        </div>`);
    } else {
      slots.push(`<div class="inv-slot inv-empty"></div>`);
    }
  }
  return `
    <div class="inv-pane" data-container="${key}">
      <div class="inv-pane-title">${CONTAINER_NAMES[key]} <span class="muted">${arr.length}/${cap}</span></div>
      <div class="inv-grid">${slots.join("")}</div>
    </div>`;
}

function actionBarHTML() {
  if (!selected) return `<span class="muted">No item selected.</span>`;
  const arr = containerRef(selected.key), st = arr[selected.index];
  if (!st) return `<span class="muted">No item selected.</span>`;
  const def = itemDef(st.item) || {};
  const canUse = def.onUse && def.onUse.length;
  const moveTo = mode === "container" ? (selected.key === "inventory" ? otherKey : "inventory") : null;
  return `
    <div class="inv-sel-info"><strong>${def.name}</strong><small>${def.desc || ""}</small></div>
    <div class="inv-btns">
      ${canUse ? `<button class="btn inv-act" data-act="use">Use</button>` : ""}
      ${st.qty > 1 ? `<button class="btn inv-act" data-act="split">Split</button>` : ""}
      ${moveTo ? `<button class="btn inv-act" data-act="move">→ ${CONTAINER_NAMES[moveTo]}</button>` : ""}
      <button class="btn inv-act" data-act="drop">Drop</button>
    </div>`;
}

function bindActions() {
  overlay.querySelectorAll(".inv-act").forEach((b) => b.addEventListener("click", () => {
    if (!selected) return;
    const { key, index } = selected;
    const act = b.dataset.act;
    if (act === "use") useStack(key, index);
    else if (act === "split") splitStack(key, index);
    else if (act === "drop") dropStack(key, index);
    else if (act === "move") moveStack(key, index, key === "inventory" ? otherKey : "inventory");
  }));
}

// ---- slot interaction: unified tap (select) + drag (transfer) ----
let press = null, ghost = null, dragging = false;

function bindSlots() {
  overlay.querySelectorAll(".inv-slot:not(.inv-empty) .inv-icon").forEach((img) =>
    applyArt(img, img.dataset.icon, img.dataset.label));

  overlay.querySelectorAll(".inv-slot:not(.inv-empty)").forEach((slot) => {
    slot.addEventListener("pointerdown", onSlotDown);
  });
}

function onSlotDown(e) {
  const slot = e.currentTarget;
  press = { key: slot.dataset.key, index: parseInt(slot.dataset.index, 10), x: e.clientX, y: e.clientY, slot };
  dragging = false;
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}
function cleanup() {
  document.removeEventListener("pointermove", onMove);
  document.removeEventListener("pointerup", onUp);
  document.removeEventListener("pointercancel", onCancel);
  if (ghost) { ghost.remove(); ghost = null; }
}
function onMove(e) {
  if (!press) return;
  if (!dragging) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8) return;
    dragging = true;
    const img = press.slot.querySelector(".inv-icon");
    ghost = document.createElement("img");
    ghost.src = img.src;
    ghost.className = "inv-ghost";
    document.body.appendChild(ghost);
  }
  if (ghost) { ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px"; }
}
function onUp(e) {
  if (!press) { cleanup(); return; }
  const wasDragging = dragging, p = press;
  cleanup();
  if (wasDragging) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pane = el && el.closest("[data-container]");
    if (pane && pane.dataset.container !== p.key) moveStack(p.key, p.index, pane.dataset.container);
  } else {
    selected = { key: p.key, index: p.index };
    render();
  }
  press = null; dragging = false;
}
function onCancel() {
  cleanup();
  press = null; dragging = false;
}

// ---- Step 18.1: count / consume a specific item (used by cassettes) ----
export function countItem(itemId, key = "inventory") {
  return containerRef(key).reduce((a, st) => a + (st.item === itemId ? st.qty : 0), 0);
}
export function takeItem(itemId, qty = 1, key = "inventory") {
  const arr = containerRef(key); let need = qty;
  for (let i = arr.length - 1; i >= 0 && need > 0; i--) {
    if (arr[i].item === itemId) { const t = Math.min(arr[i].qty, need); arr[i].qty -= t; need -= t; if (arr[i].qty <= 0) arr.splice(i, 1); }
  }
  return qty - need; // number actually taken
}
