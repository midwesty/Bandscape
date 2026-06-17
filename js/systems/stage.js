// ============================================================
// stage.js — isometric apartment renderer (Step 2.1).
//
// Furniture is now DATA THE PLAYER OWNS: it lives in the save as
// state.placedObjects[location] and can be repositioned in Arrange
// mode. This is the foundation buying-and-placing builds on later.
//
// Walk by tapping the floor (pathfinds around furniture). Tap an
// object to use it. Tap ARRANGE (bottom-left) to pick up & move
// furniture. Objects + character are drawn in code and auto-
// overridden by any PNG dropped into the matching assets/ slot.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, setFlag, activeBand, regionUnlocked, propertyStatus } from "../engine/state.js";
import { addCondition } from "./conditions.js";
import { emit, on } from "../engine/bus.js";
import { sleep } from "./time.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { openContainerView, giveItem } from "./inventory.js";
import { instrItemId, parseInstrItem } from "./gear.js";
import { openDAW } from "./daw.js";
import { openShop, busk, openVenue, openStore, openStoreCategory, openThrift } from "./shop.js";
import { openRecruit } from "./band.js";
import { openPerform } from "./shows.js";
import { playWorldSfx } from "./worldaudio.js";
import { bookedCommitments, currentDay, currentSlot } from "./calendar.js";
import { openDialogue } from "./dialogue.js";
import { useFridge, cookMeal, makeCoffee, microwaveFood, useBeerFridge } from "./kitchen.js";
import { shower, soak, primp, drinkWater, restSeat, useToilet } from "./rooms.js";

const C = {
  floorA: "#221a2b", floorB: "#1c1626", floorEdge: "#3a2f49",
  wallL: "#241d30", wallR: "#1a1422", wallTop: "#4a3d5e",
  shadow: "rgba(0,0,0,0.38)",
  pink: "#ff3b6b", yellow: "#ffd23f", green: "#7CFC9B",
  blue: "#4fc3f7", purple: "#b388ff", orange: "#ff8a3d",
  ink: "#0b0b0f", line: "#0b0b0f"
};

// ---- Step 36: data-driven city skins ----
// A scene may declare a `palette` (ground + building-body tints) and each building
// an `build` kind (its awning/accent color). Renderer falls back to defaults when
// absent, so existing scenes are visually unchanged.
let activePalette = null;
function pal(key, fb) { return (activePalette && activePalette[key]) || C[key] || fb; }
const BUILDING_KINDS = { venue: C.pink, saloon: "#c98a3d", hotel: "#7CFC9B", store: C.green, general: "#c9a23d", music: C.purple, pawn: C.yellow, bar: "#ff8a3d", diner: C.orange, records: C.pink, casino: "#ff3b6b", food: C.orange, arcade: "#3df0ff", apartment: "#9b8cff" };
function kindColor(kind) { return BUILDING_KINDS[kind] || C.blue; }

const TILE_W = 64, TILE_H = 32, WALL_H = 46, SPEED = 3.6;

let initialized = false, running = false;
let stageEl, canvas, ctx, dpr = 1;
let cssW = 0, cssH = 0, originX = 0, originY = 0;

let room = null, furniture = [], exits = [], blocked = null;
let player = { x: 4, y: 3, fx: 4, fy: 3, facing: 1 };
let movers = [], roads = [];   // ambient world life (Step 24.1) — regenerated per scene, not saved
let npcMovers = [], lastSlot = null;   // scheduled NPCs in this scene (Step 24.4)
let lastHintLoc = null;   // so the 'players around' hint fires on scene entry, not every render
let path = [], pendingInteract = null;
let hovered = null;
let arranging = false, held = null;
let imgCache = new Map();
let rafId = null, lastTs = 0;

// ---- public ----
export function renderStage() {
  stageEl = document.getElementById("stage");
  if (!stageEl) return;
  if (!initialized) initOnce();
  syncToState();
  requestRender();
}
export function travelTo(to, spawn) { travel(to, spawn); }
export function pauseStage() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = null; }

// ---- setup ----
function initOnce() {
  initialized = true;
  stageEl.innerHTML = "";
  canvas = document.createElement("canvas");
  canvas.className = "iso-canvas";
  stageEl.appendChild(canvas);
  ctx = canvas.getContext("2d");

  canvas.addEventListener("click", onClick);
  canvas.addEventListener("pointermove", onHover);
  canvas.addEventListener("pointerleave", () => { hovered = null; requestRender(); });
  window.addEventListener("keydown", onKey);
  document.getElementById("arrange-button")?.addEventListener("click", () => setArrange(!arranging));

  const ro = new ResizeObserver(() => { resize(); requestRender(); });
  ro.observe(stageEl);

  on("time:tick", () => requestRender());
  on("room:dropItem", (d) => placeFloorItem(d));
  resize();
}

function syncToState() {
  const s = getState();
  running = true;
  room = DATA.locations[s.location] || DATA.locations.apartment;
  activePalette = (room && room.palette) || null;   // Step 36: per-city skin

  // seed / migrate movable furniture into the save (per location)
  s.placedObjects = s.placedObjects || {};
  if (!s.placedObjects[s.location]) {
    s.placedObjects[s.location] = JSON.parse(JSON.stringify(room.objects || []));
  }
  furniture = s.placedObjects[s.location];
  // merge any objects added in an update (e.g. new instruments) into existing saves —
  // but never resurrect originals the player intentionally removed (picked up / sold)
  const removed = new Set((s.removedObjects && s.removedObjects[s.location]) || []);
  const haveIds = new Set(furniture.map((o) => o.id));
  for (const o of (room.objects || [])) if (!haveIds.has(o.id) && !removed.has(o.id)) furniture.push(JSON.parse(JSON.stringify(o)));
  exits = room.exits || [];
  rebuildBlocked();
  buildWorld();
  buildSceneNPCs();
  hintRecruitables();

  const saved = s.player?.tile;
  const start = saved && isFree(saved.x, saved.y) ? saved : firstFreeTile();
  player.x = player.fx = start.x;
  player.y = player.fy = start.y;
  path = []; pendingInteract = null; held = null; arranging = false;
  document.getElementById("arrange-button")?.classList.remove("active");
  resize();
}

function rebuildBlocked(except) {
  const w = room.size?.w || 8, h = room.size?.h || 6;
  blocked = Array.from({ length: h }, () => Array(w).fill(false));
  for (const o of furniture) {
    if (o === except || !o.tile || o.kind === "item") continue;
    const f = footOf(o);
    for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) { const bx = o.tile.x + dx, by = o.tile.y + dy; if (inBounds(bx, by)) blocked[by][bx] = true; }
  }
  for (const o of exits) { if (o.solid && o.tile && inBounds(o.tile.x, o.tile.y)) blocked[o.tile.y][o.tile.x] = true; }
  const _W = room && room.world; if (_W && _W.water) for (const r of _W.water) for (let yy = r.y0; yy <= r.y1; yy++) for (let xx = r.x0; xx <= r.x1; xx++) if (inBounds(xx, yy)) blocked[yy][xx] = true; // Step 40: water is non-walkable
}
function firstFreeTile() {
  const w = room.size?.w || 8, h = room.size?.h || 6;
  const c = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
  if (isFree(c.x, c.y)) return c;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isFree(x, y)) return { x, y };
  return { x: 0, y: 0 };
}

function resize() {
  if (!stageEl) return;
  const r = stageEl.getBoundingClientRect();
  cssW = r.width; cssH = r.height;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = room?.size?.w || 8, h = room?.size?.h || 6;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  originX = cssW / 2 - (cx - cy) * (TILE_W / 2);
  originY = cssH / 2 - (cx + cy) * (TILE_H / 2) - WALL_H * 0.5;
}

// ---- iso math ----
function toScreen(tx, ty) {
  return { x: originX + (tx - ty) * (TILE_W / 2), y: originY + (tx + ty) * (TILE_H / 2) };
}
function toTile(sx, sy) {
  const a = (sx - originX) / (TILE_W / 2);
  const b = (sy - originY) / (TILE_H / 2);
  return { x: Math.round((a + b) / 2), y: Math.round((b - a) / 2) };
}
function inBounds(x, y) {
  const w = room.size?.w || 8, h = room.size?.h || 6;
  return x >= 0 && y >= 0 && x < w && y < h;
}
function isFree(x, y) { return inBounds(x, y) && !blocked[y][x]; }
function coversTile(o, x, y) {              // Step 26.3.1: an object occupies every tile of its footprint
  if (!o || !o.tile) return false;
  const f = footOf(o);
  return x >= o.tile.x && x < o.tile.x + f.w && y >= o.tile.y && y < o.tile.y + f.h;
}
function footprintFree(o, ax, ay) {         // would o's whole footprint fit (free + off the player) anchored here?
  const f = footOf(o), px = Math.round(player.x), py = Math.round(player.y);
  for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) { const x = ax + dx, y = ay + dy; if (!isFree(x, y) || (x === px && y === py)) return false; }
  return true;
}
function nearestApproachTo(obj) {           // closest free tile beside ANY footprint tile
  const f = footOf(obj), seen = new Set(), cands = [];
  for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) {
    const tx = obj.tile.x + dx, ty = obj.tile.y + dy;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = tx + ox, ny = ty + oy, k = nx + "," + ny; if (seen.has(k) || !isFree(nx, ny)) continue; seen.add(k); cands.push({ x: nx, y: ny, d: Math.hypot(nx - player.x, ny - player.y) }); }
  }
  return cands.sort((a, b) => a.d - b.d)[0] || null;
}
function decorUse(o) { return (o && o.decorId && DATA.decor && DATA.decor.items && DATA.decor.items[o.decorId] && DATA.decor.items[o.decorId].use) || null; }
function speedMult() {           // Step 27.0: Caffeinated (or any condition w/ speedMult) speeds you up
  const s = getState();
  let m = 1;
  for (const c of (s && s.conditions) || []) {
    const d = DATA.conditions && DATA.conditions.conditions && DATA.conditions.conditions[c.id];
    if (d && d.speedMult) m = Math.max(m, d.speedMult);
  }
  return m;
}
function objectAt(x, y) {
  return furniture.find((o) => coversTile(o, x, y)) || exits.find((o) => coversTile(o, x, y)) || null;
}

// ---- input ----
function onClick(e) {
  const p = ptr(e);
  const t = toTile(p.x, p.y);
  if (!inBounds(t.x, t.y)) return;
  if (arranging) { handleArrangeClick(t); return; }

  const who = npcAt(t.x, t.y);
  if (who) { approachAndInteract(who); return; }
  const obj = objectAt(t.x, t.y);
  if (obj) { approachAndInteract(obj); return; }
  if (isFree(t.x, t.y)) walkTo(t.x, t.y, null);
}
function onHover(e) {
  if (arranging) return;
  const p = ptr(e);
  const t = toTile(p.x, p.y);
  const obj = objectAt(t.x, t.y);
  const npc = obj ? null : npcAt(t.x, t.y);
  const next = obj ? obj.id : null;
  if (next !== hovered) { hovered = next; requestRender(); }
  canvas.style.cursor = (obj || npc) ? "pointer" : "default";
}
function onKey(e) {
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return; // don't steal keystrokes while typing
  if (document.getElementById("game").classList.contains("hidden")) return;
  if (!document.getElementById("phone").classList.contains("hidden")) return;
  if (arranging) return;
  const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
                w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
  const mv = map[e.key];
  if (!mv) return;
  e.preventDefault();
  const nx = Math.round(player.x) + mv[0], ny = Math.round(player.y) + mv[1];
  if (isFree(nx, ny)) walkTo(nx, ny, null);
}
function ptr(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ---- arrange mode ----
function setArrange(on) {
  arranging = on;
  held = null;
  rebuildBlocked();
  path = []; pendingInteract = null;
  document.getElementById("arrange-button")?.classList.toggle("active", on);
  canvas.style.cursor = "default";
  if (on) toast("Arrange: tap furniture, then an empty tile. Tap ARRANGE to finish.", "info");
  else toast("Arrange mode off.", "info");
  requestRender();
}
function handleArrangeClick(t) {
  if (held) {
    const onPlayer = Math.round(player.x) === t.x && Math.round(player.y) === t.y;
    if (footprintFree(held, t.x, t.y)) {
      held.tile = { x: t.x, y: t.y };
      held = null;
      rebuildBlocked();
      persist();
      toast("Placed.", "good");
    } else {
      toast("Can't put it there.", "warn");
    }
    requestRender();
    return;
  }
  const f = furniture.find((o) => coversTile(o, t.x, t.y));
  if (f) {
    held = f;
    rebuildBlocked(held); // free its current tile so it can move/return
    toast("Lifted " + f.name + ". Tap where it goes.", "info");
    requestRender();
  }
}
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }

// Move to another location. Spawn is the arrival tile (falls back to a free tile).
function travel(to, spawn) {
  const s = getState();
  if (!to || !DATA.locations[to]) { toast("There's nothing that way yet.", "warn"); return; }
  if (to === "musicstore" || to === "thrift" || to === "records") { s.flags = s.flags || {}; s.flags.storeReturn = { to: s.location, spawn: (s.player && s.player.tile) ? { x: s.player.tile.x, y: s.player.tile.y } : null }; }
  s.location = to;
  const _cityHit = Object.entries((DATA.regions && DATA.regions.cities) || {}).find(([id, c]) => c.entryScene && c.entryScene.scene === to);
  if (_cityHit) s.currentCity = _cityHit[0];   // Step 39: track which city you are in (data-driven)
  if (to === "venue") { s.flags = s.flags || {}; s.flags.venue_discovered = true; }
  s.player = s.player || {};
  s.player.tile = spawn ? { x: spawn.x, y: spawn.y } : null;
  persist();
  emit("location:changed", { to });
  renderStage();
  emit("renderAll");
  toast(to === "town" ? "You step out onto the block." : "You head back inside.", "info");
}

// ---- movement / pathfinding ----
function walkTo(tx, ty, interact) {
  const start = { x: Math.round(player.x), y: Math.round(player.y) };
  const p = bfs(start, { x: tx, y: ty });
  if (!p) return;
  path = p.slice(1);
  pendingInteract = interact;
  requestRender();
}
function approachAndInteract(obj) {
  if ((obj.interact === "exit" || obj.to) && isFree(obj.tile.x, obj.tile.y)) { walkTo(obj.tile.x, obj.tile.y, obj); return; }
  const spot = nearestApproachTo(obj);
  if (!spot) { interact(obj); return; }
  walkTo(spot.x, spot.y, obj);
}
function nearestFreeNeighbor(x, y) {
  return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
    .filter(([nx, ny]) => isFree(nx, ny))
    .map(([nx, ny]) => ({ x: nx, y: ny, d: Math.hypot(nx - player.x, ny - player.y) }))
    .sort((a, b) => a.d - b.d)[0] || null;
}
function bfs(start, goal) {
  if (start.x === goal.x && start.y === goal.y) return [start];
  const w = room.size?.w || 8, h = room.size?.h || 6;
  const key = (x, y) => y * w + x;
  const q = [start], came = new Map(); came.set(key(start.x, start.y), null);
  while (q.length) {
    const cur = q.shift();
    if (cur.x === goal.x && cur.y === goal.y) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!isFree(nx, ny) || came.has(key(nx, ny))) continue;
      came.set(key(nx, ny), cur); q.push({ x: nx, y: ny });
    }
  }
  if (!came.has(key(goal.x, goal.y))) return null;
  const out = []; let c = goal;
  while (c) { out.unshift(c); c = came.get(key(c.x, c.y)); }
  return out;
}
function update(dt) {
  if (!path.length) return;
  const target = path[0];
  const dx = target.x - player.x, dy = target.y - player.y;
  const dist = Math.hypot(dx, dy);
  const step = SPEED * dt * speedMult();
  if (dist <= step) {
    player.x = target.x; player.y = target.y;
    path.shift();
    if (!path.length) {
      emit("player:moved", { tile: { x: player.x, y: player.y } });
      getState().player.tile = { x: player.x, y: player.y };
      if (pendingInteract) { const o = pendingInteract; pendingInteract = null; interact(o); }
    }
  } else {
    player.x += (dx / dist) * step; player.y += (dy / dist) * step;
    const scrDx = (dx - dy);
    if (Math.abs(scrDx) > 0.001) player.facing = scrDx >= 0 ? 1 : -1;
  }
}

// ---- travel: bus destination picker (Step 35: Maps & Cities) ----
function regionName(id) { const r = (DATA.regions && DATA.regions.regions && DATA.regions.regions[id]); return (r && r.name) || id; }
function regionPassHeld(regionId) {
  const s = getState();
  if (regionId === "midwest") return !!(s.flags && s.flags.rocktroit_unlocked); // the original one-time Midwest bus pass
  return !!(s.travelPasses && s.travelPasses[regionId]);
}
function regionPassCost(regionId) {
  const t = (DATA.config.travel) || {};
  if (regionId === "midwest") return t.busFare || 1000;
  return (t.regionPass && t.regionPass[regionId] != null) ? t.regionPass[regionId] : 2500;
}
function buyRegionPass(regionId) {
  const s = getState(); const cost = regionPassCost(regionId);
  if (cost <= 0) return true;
  if ((s.stats.money || 0) < cost) { toast(`A ${regionName(regionId)} bus pass is $${cost}. You can't afford it yet.`, "warn"); return false; }
  if (!confirm(`Buy a one-time ${regionName(regionId)} bus pass for $${cost}? After this, the bus runs free.`)) return false;
  addStat("money", -cost);
  if (regionId === "midwest") setFlag("rocktroit_unlocked", true);
  else { s.travelPasses = s.travelPasses || {}; s.travelPasses[regionId] = true; }
  toast("Bus pass bought. All aboard.", "good");
  return true;
}
function reachableCities() {
  const cities = (DATA.regions && DATA.regions.cities) || {}; const here = getState().location; const out = [];
  for (const id in cities) {
    const c = cities[id]; const es = c.entryScene;
    if (!es || !es.scene || es.scene === here) continue;   // no walkable scene, or you're already there
    if (c.built === false) continue;
    if (!regionUnlocked(c.region)) continue;   // gate by region progression; the pass is the ride cost
    out.push({ id, name: c.name, region: c.region, scene: es.scene, spawn: es.spawn });
  }
  return out;
}
let _travelScrim = null;
function closeTravelPicker() { if (_travelScrim) { _travelScrim.remove(); _travelScrim = null; } }
function doTravel(dest) {
  if (!regionPassHeld(dest.region)) { if (!buyRegionPass(dest.region)) return; }
  closeTravelPicker();
  travel(dest.scene, dest.spawn);
}
function handleBus(obj) {
  const dests = reachableCities();
  if (!dests.length) { toast("Nowhere to ride to yet — the road's quiet.", "info"); return; }
  const byRegion = {}; dests.forEach((d) => { (byRegion[d.region] = byRegion[d.region] || []).push(d); });
  const groups = Object.keys(byRegion).map((rid) => {
    const held = regionPassHeld(rid); const cost = regionPassCost(rid);
    const tag = held || cost <= 0 ? "" : ` <span class="trv-cost">pass $${cost}</span>`;
    const btns = byRegion[rid].map((d) => `<button class="btn trv-dest" data-scene="${d.scene}" data-region="${d.region}">${d.name}</button>`).join("");
    return `<div class="trv-region"><div class="trv-region-h">${regionName(rid)}${tag}</div><div class="trv-dests">${btns}</div></div>`;
  }).join("");
  closeTravelPicker();
  const scrim = document.createElement("div"); scrim.className = "modal-scrim"; scrim.id = "trv-scrim"; _travelScrim = scrim;
  scrim.innerHTML = `<div class="neg-card trv-card">
    <div class="neg-head"><span>CATCH THE BUS</span><button id="trv-x">✕</button></div>
    <p class="neg-ask">Where to? A region's first ride buys a one-time pass; after that the bus runs free.</p>
    ${groups}
  </div>`;
  document.body.appendChild(scrim);
  const close = () => closeTravelPicker();
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  scrim.querySelector("#trv-x").addEventListener("click", close);
  scrim.querySelectorAll(".trv-dest").forEach((b) => b.addEventListener("click", () => {
    const d = dests.find((x) => x.scene === b.dataset.scene); if (d) doTravel(d);
  }));
}
function hotelStay(obj) {
  const s = getState(); const price = (DATA.config.lodging && DATA.config.lodging.hotelPrice) || 60;
  if ((s.stats.money || 0) < price) { toast(`A room here runs $${price} a night. You're short.`, "warn"); return; }
  if (!confirm(`Take a room at ${obj.name || "the hotel"} for $${price}? (a decent night's rest — advances to tomorrow and saves)`)) return;
  addStat("money", -price);
  toast("Checked in. Lights out.", "good");
  sleep();   // a real night's rest (well_rested); the bare tour van will be the lousy version later
}
function dinerEat(obj) {
  const s = getState(); const price = (DATA.config.diner && DATA.config.diner.mealPrice) || 18;
  if ((s.stats.money || 0) < price) { toast(`A hot plate's $${price}. Not in the cards right now.`, "warn"); return; }
  if (!confirm(`Order a hot plate and a drink for $${price}?`)) return;
  addStat("money", -price); addStat("hunger", 45); addStat("thirst", 25); addCondition("hot_meal");
  toast("Hot meal, cold drink. Back among the living.", "good");
}

// ---- interactions ----
function interact(obj) {
  const kind = obj.interact || decorUse(obj) || (obj.to ? "exit" : null);
  switch (kind) {
    case "sleep":
      if (confirm("Crash for the night? (advances to tomorrow and saves)")) sleep();
      break;
    case "equip":
      openInstrumentMenu(obj);
      break;
    case "container":
      openContainerView(obj.containerId || "storage");
      break;
    case "fridge":
      useFridge(obj.containerId || "fridge");
      break;
    case "cook":
      cookMeal(obj.fridgeId || "fridge");
      break;
    case "coffee":
      makeCoffee();
      break;
    case "microwave":
      microwaveFood();
      break;
    case "beerfridge":
      useBeerFridge(obj.containerId || "minifridge");
      break;
    case "shower":
      shower();
      break;
    case "soak":
      soak();
      break;
    case "primp":
      primp();
      break;
    case "drink":
      drinkWater();
      break;
    case "rest":
      restSeat();
      break;
    case "toilet":
      useToilet();
      break;
    case "pickup":
      pickUpFloorItem(obj);
      break;
    case "daw":
      openDAW();
      break;
    case "shop":
      openShop(obj.shopId);
      break;
    case "busk":
      busk();
      break;
    case "enter":
      travel(obj.to, obj.spawn);
      break;
    case "storecat":
      openStoreCategory(obj.instrumentId);
      break;
    case "storeclerk":
      openStore();
      break;
    case "decorclerk":
      openThrift();
      break;
    case "storeexit": {
      const ret = (getState().flags && getState().flags.storeReturn) || { to: "town", spawn: null };
      travel(ret.to, ret.spawn);
      break;
    }
    case "talk":
      openRecruit(obj.npcId);
      break;
    case "stage":
      openPerform(obj.venueId);
      break;
    case "bus":
      handleBus(obj);
      break;
    case "hotel":
      hotelStay(obj);
      break;
    case "diner":
      dinerEat(obj);
      break;
    case "property": {
      const st = propertyStatus(obj.propertyId);
      if (st === "owned" || st === "rented") travel(obj.to, obj.spawn);
      else toast((obj.name || "This place") + " isn't yours yet - open the Properties app to rent or buy it.", "info");
      break;
    }
    case "venue":
      openVenue(obj.venueId);
      break;
    case "flavor":
      openDialogue(obj.npcId, obj);
      break;
    case "exit":
      travel(obj.to, obj.spawn);
      break;
    default:
      toast(obj.name, "info");
  }
}

// ---- dropped items on the floor ----
function spriteForType(type) {
  for (const loc in DATA.locations) {
    const objs = (DATA.locations[loc] && DATA.locations[loc].objects) || [];
    for (const o of objs) { if (o.instrumentId === type && o.sprite) return o.sprite; }
  }
  return "assets/img/objects/" + type + ".png";
}
function placeFloorItem(d) {
  const tile = { x: Math.round(player.x), y: Math.round(player.y) };
  const ip = parseInstrItem(d.item);
  if (ip) {
    furniture.push({
      id: "instr_" + Math.random().toString(36).slice(2, 8),
      instrumentId: ip.type, tier: ip.tier, name: d.name || ip.type,
      sprite: spriteForType(ip.type), interact: "equip", tile
    });
  } else {
    furniture.push({
      id: "floor_" + Math.random().toString(36).slice(2, 8),
      kind: "item", item: d.item, qty: d.qty, name: d.name, icon: d.icon,
      interact: "pickup", tile
    });
  }
  rebuildBlocked();
  persist();
  requestRender();
}

// ---- instrument: play vs pick up ----
function openInstrumentMenu(obj) {
  const s = getState();
  const name = obj.name || (DATA.instruments[obj.instrumentId] && DATA.instruments[obj.instrumentId].name) || "instrument";
  const scrim = document.createElement("div"); scrim.className = "modal-scrim"; scrim.id = "instr-scrim";
  scrim.innerHTML = `<div class="neg-card" style="max-width:300px">
    <div class="neg-head"><span>${name.toUpperCase()}</span><button id="instr-x">✕</button></div>
    <div class="neg-acts" style="flex-direction:column;gap:8px">
      <button class="btn" id="instr-play">Play in studio</button>
      <button class="btn" id="instr-pick">Pick up &amp; carry</button>
    </div></div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  scrim.querySelector("#instr-x").addEventListener("click", close);
  scrim.querySelector("#instr-play").addEventListener("click", () => {
    s.equipped = s.equipped || { instrumentId: null };
    s.equipped.instrumentId = obj.instrumentId;
    s.owned = s.owned || [];
    if (!s.owned.includes(obj.instrumentId)) s.owned.push(obj.instrumentId);
    emit("instrument:equipped", { id: obj.instrumentId });
    toast("Ready to record on the " + name + ". Open the SOUND app.", "good");
    close();
  });
  scrim.querySelector("#instr-pick").addEventListener("click", () => {
    const left = giveItem("inventory", instrItemId(obj.instrumentId, obj.tier || "starter"), 1);
    if (left > 0) { toast("Your pockets are full.", "warn"); close(); return; }
    const idx = furniture.indexOf(obj); if (idx >= 0) furniture.splice(idx, 1);
    s.removedObjects = s.removedObjects || {};
    s.removedObjects[s.location] = s.removedObjects[s.location] || [];
    if (!s.removedObjects[s.location].includes(obj.id)) s.removedObjects[s.location].push(obj.id);
    rebuildBlocked(); persist(); requestRender();
    toast("Picked up the " + name + ".", "good");
    close();
  });
}
function pickUpFloorItem(o) {
  const want = o.qty || 1;
  const leftover = giveItem("inventory", o.item, want);
  const took = want - leftover;
  if (took <= 0) { toast("Your pockets are full.", "warn"); return; }
  if (leftover > 0) { o.qty = leftover; toast("Grabbed some " + (o.name || o.item) + " — pockets full.", "warn"); }
  else {
    const idx = furniture.indexOf(o);
    if (idx >= 0) furniture.splice(idx, 1);
    toast("Picked up " + (o.name || o.item) + ".", "good");
  }
  rebuildBlocked();
  persist();
  emit("renderAll");
  requestRender();
}
function drawFloorItem(o, cx, cy) {
  ctx.fillStyle = "#2a2233"; ctx.strokeStyle = C.yellow; ctx.lineWidth = 1.5;
  roundRect(cx - 9, cy - 17, 18, 16, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.yellow; ctx.font = "700 11px 'Arial Narrow', sans-serif"; ctx.textAlign = "center";
  ctx.fillText((o.name || "?").slice(0, 1).toUpperCase(), cx, cy - 6);
  if (o.qty > 1) { ctx.fillStyle = C.green; ctx.font = "700 9px 'Arial Narrow', sans-serif"; ctx.fillText("x" + o.qty, cx, cy + 8); }
  ctx.textAlign = "left";
}

// ---- render loop ----
function requestRender() { if (rafId == null) rafId = requestAnimationFrame(frame); }
function frame(ts) {
  rafId = null;
  if (!running || !ctx) return;
  if (document.getElementById("game").classList.contains("hidden")) { running = false; return; }
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
  lastTs = ts;
  update(dt);
  if (lastSlot !== null && currentSlot() !== lastSlot) buildSceneNPCs();
  updateMovers(dt);
  draw();
  if (path.length || movers.length || npcMovers.length) requestRender();
}

function draw() {
  const w = room.size?.w || 8, h = room.size?.h || 6;
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#0c0810"; ctx.fillRect(0, 0, cssW, cssH);

  drawWalls(w, h);
  drawFloor(w, h);
  drawRoads();
  drawArrangeOverlay(w, h);

  const ents = [];
  for (const o of furniture) { const f = footOf(o); ents.push({ kind: "obj", o, depth: o.tile.x + o.tile.y + (f.w - 1) + (f.h - 1) }); }
  for (const o of exits) ents.push({ kind: "obj", o, depth: o.tile.x + o.tile.y - 0.5 });
  for (const m of movers) ents.push({ kind: "mover", m, depth: m.x + m.y + 0.35 });
  for (const m of npcMovers) ents.push({ kind: "mover", m, depth: m.x + m.y + 0.36 });
  ents.push({ kind: "player", depth: player.x + player.y + 0.4 });
  ents.sort((a, b) => a.depth - b.depth);
  for (const e of ents) e.kind === "player" ? drawPlayer() : e.kind === "mover" ? drawMover(e.m) : drawObject(e.o);

  drawDayNight();
  if (hovered && !arranging) drawLabel();
}

function inWater(x, y) {
  const W = room && room.world; if (!W || !W.water) return false;
  return W.water.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
}
function drawFloor(w, h) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = toScreen(x, y);
    if (inWater(x, y)) diamond(c.x, c.y, (x + y) % 2 ? pal("waterA", "#1c3a5e") : pal("waterB", "#16314f"), pal("waterEdge", "#2b5277"));
    else diamond(c.x, c.y, (x + y) % 2 ? pal("floorA") : pal("floorB"), pal("floorEdge"));
  }
}
function diamond(cx, cy, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - TILE_H / 2); ctx.lineTo(cx + TILE_W / 2, cy);
  ctx.lineTo(cx, cy + TILE_H / 2); ctx.lineTo(cx - TILE_W / 2, cy);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function drawArrangeOverlay(w, h) {
  if (!arranging) return;
  if (held) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (footprintFree(held, x, y)) { const c = toScreen(x, y); diamond(c.x, c.y, "rgba(124,252,155,0.16)", "rgba(124,252,155,0.5)"); }
    }
    const hf = footOf(held);
    for (let dy = 0; dy < hf.h; dy++) for (let dx = 0; dx < hf.w; dx++) { const c = toScreen(held.tile.x + dx, held.tile.y + dy); diamond(c.x, c.y, "rgba(255,210,63,0.22)", C.yellow); }
  } else {
    for (const o of furniture) { const f = footOf(o); for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) { const c = toScreen(o.tile.x + dx, o.tile.y + dy); diamond(c.x, c.y, null, "rgba(255,210,63,0.55)"); } }
  }
}
function drawWalls(w, h) {
  const top = toScreen(0, 0); top.y -= TILE_H / 2;
  const right = toScreen(w - 1, 0); right.x += TILE_W / 2;
  const left = toScreen(0, h - 1); left.x -= TILE_W / 2;
  wallQuad(top, right, C.wallR);
  wallQuad(top, left, C.wallL);
  ctx.strokeStyle = C.wallTop; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left.x, left.y - WALL_H); ctx.lineTo(top.x, top.y - WALL_H); ctx.lineTo(right.x, right.y - WALL_H);
  ctx.stroke();
}
function wallQuad(a, b, fill) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x, b.y - WALL_H); ctx.lineTo(a.x, a.y - WALL_H);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
}

// ---- entities ----
function shadow(cx, cy, rw = TILE_W * 0.34, rh = TILE_H * 0.34) {
  ctx.beginPath(); ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.shadow; ctx.fill();
}
function drawObject(o) {
  const _f = footOf(o);
  const c = toScreen(o.tile.x + (_f.w - 1) / 2, o.tile.y + (_f.h - 1) / 2);
  const lifted = held === o;
  const img = getImage(o.sprite);
  shadow(c.x, c.y);
  ctx.save();
  if (lifted) ctx.translate(0, -8);
  if (img && img._ok) {
    const dw = (o.kind === "item" ? TILE_W * 0.6 : TILE_W * 1.1 * Math.max(_f.w, _f.h)), dh = dw * (img.naturalHeight / img.naturalWidth || 1);
    ctx.drawImage(img, c.x - dw / 2, c.y - dh + TILE_H * 0.35, dw, dh);
  } else if (o.kind === "item") {
    drawFloorItem(o, c.x, c.y);
  } else {
    drawProc(o, c.x, c.y);
  }
  ctx.restore();
  if (hovered === o.id && !arranging) outlineObject(c.x, c.y);
}
function drawProc(o, cx, cy) {
  if (o.interact === "talk" || o.interact === "storeclerk" || o.interact === "decorclerk") return npcFigure(cx, cy, o);
  if (o.interact === "stage") return stageShape(cx, cy);
  if (o.build) return building(cx, cy, kindColor(o.build));   // Step 36: data-driven building art
  if (o.flavorNpc) return npcFigure(cx, cy, o);
  if (o.decorId) return drawDecor(o, cx, cy);
  if (o.door) return doorway(cx, cy, o.label || o.name);
  if (o.instrumentId) {
    switch (o.instrumentId) {
      case "guitar": return stringed(cx, cy, C.orange);
      case "bass":   return stringed(cx, cy, C.blue);
      case "piano":  return pianoShape(cx, cy);
      case "drums":  return drumsShape(cx, cy);
      case "microphone": return micShape(cx, cy);
    }
  }
  switch (o.id) {
    case "bed":    cuboid(cx, cy, 26, 13, 14, "#3a2740", "#2a1c30", "#241828");
                   ctx.fillStyle = C.yellow; ctx.fillRect(cx - 10, cy - 14, 14, 7); break;
    case "fridge": cuboid(cx, cy, 14, 7, 40, "#cfd6dd", "#9aa3ad", "#7c858f");
                   ctx.fillStyle = "#5a626b"; ctx.fillRect(cx + 6, cy - 34, 2, 18); break;
    case "crate":  cuboid(cx, cy, 13, 7, 16, "#7a5a36", "#5e4528", "#4a361f");
                   ctx.strokeStyle = "#3a2a18"; ctx.lineWidth = 2;
                   ctx.beginPath(); ctx.moveTo(cx - 10, cy - 16); ctx.lineTo(cx + 8, cy - 4); ctx.stroke(); break;
    case "laptop": cuboid(cx, cy, 18, 9, 5, "#2b2533", "#211b29", "#1a1521");
                   ctx.fillStyle = "#1a1422"; ctx.fillRect(cx - 12, cy - 24, 24, 16);
                   ctx.fillStyle = C.green; ctx.fillRect(cx - 10, cy - 22, 20, 12); break;
    case "guitar": stringed(cx, cy, C.orange); break;
    case "bass":   stringed(cx, cy, C.blue); break;
    case "piano":  pianoShape(cx, cy); break;
    case "drums":  drumsShape(cx, cy); break;
    case "mic":    micShape(cx, cy); break;
    case "door": case "out": case "exit":   doorway(cx, cy); break;
    case "pawn":    building(cx, cy, C.yellow); break;
    case "grocery": building(cx, cy, C.green); break;
    case "thrift":  building(cx, cy, C.blue); break;
    case "musicstore": building(cx, cy, C.purple || C.blue); break;
    case "venue":   building(cx, cy, C.pink); break;
    case "busk":    buskSpot(cx, cy); break;
    case "home":    homeDoor(cx, cy); break;
    case "pawn2":    building(cx, cy, C.orange); break;
    case "foundry":  building(cx, cy, C.pink); break;
    case "steelroom":building(cx, cy, C.blue); break;
    case "apex":     building(cx, cy, C.purple); break;
    case "arcade":   building(cx, cy, C.green); break;
    case "diner":    building(cx, cy, C.orange); break;
    case "records":  building(cx, cy, C.pink); break;
    case "bus":      busSign(cx, cy); break;
    case "cab1": case "cab2": case "cab3": case "cab4": cabinet(cx, cy); break;
    default:       cuboid(cx, cy, 14, 7, 18, C.purple, "#6e54a0", "#523f78");
  }
}
function footOf(o) {                            // Step 26.3: object footprint in tiles (default 1x1)
  const d = o && o.decorId && DATA.decor && DATA.decor.items && DATA.decor.items[o.decorId];
  const f = (d && d.footprint) || (o && o.footprint) || [1, 1];
  return { w: Math.max(1, f[0] | 0), h: Math.max(1, f[1] | 0) };
}
function isoBox(x, y, w, h, height, top, lft, rgt) {   // a 3D box spanning a w×h tile footprint
  const N = toScreen(x - 0.5, y - 0.5), E = toScreen(x + w - 0.5, y - 0.5),
        S = toScreen(x + w - 0.5, y + h - 0.5), W = toScreen(x - 0.5, y + h - 0.5);
  const up = (p) => ({ x: p.x, y: p.y - height });
  ctx.fillStyle = lft;
  ctx.beginPath(); ctx.moveTo(W.x, W.y); ctx.lineTo(S.x, S.y); ctx.lineTo(up(S).x, up(S).y); ctx.lineTo(up(W).x, up(W).y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = rgt;
  ctx.beginPath(); ctx.moveTo(S.x, S.y); ctx.lineTo(E.x, E.y); ctx.lineTo(up(E).x, up(E).y); ctx.lineTo(up(S).x, up(S).y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = top;
  ctx.beginPath(); ctx.moveTo(up(N).x, up(N).y); ctx.lineTo(up(E).x, up(E).y); ctx.lineTo(up(S).x, up(S).y); ctx.lineTo(up(W).x, up(W).y); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke();
}
// ---- décor: per-item recognizable iso forms (Step 26.5 glow-up) ----
// Each item declares a `shape` (form) + `color` in data/decor.json; these code
// shapes are the fallback beneath any future drop-in PNG art (useSprites flag).
function shade(hex, m) {                          // tint/shade a #rrggbb toward black/white
  if (!hex || hex[0] !== "#" || hex.length < 7) return hex || "#888";
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * m)));
  return "rgb(" + c((n >> 16) & 255) + "," + c((n >> 8) & 255) + "," + c(n & 255) + ")";
}
function body3d(o, f, h, col) {                   // solid iso box spanning the footprint
  isoBox(o.tile.x, o.tile.y, f.w, f.h, h, col, shade(col, 0.78), shade(col, 0.6));
}
function slab(o, f, top) {                        // 4 corner pts of footprint raised by `top`
  const a = toScreen(o.tile.x - 0.5, o.tile.y - 0.5);
  const b = toScreen(o.tile.x + f.w - 0.5, o.tile.y - 0.5);
  const c = toScreen(o.tile.x + f.w - 0.5, o.tile.y + f.h - 0.5);
  const d = toScreen(o.tile.x - 0.5, o.tile.y + f.h - 0.5);
  return { a, b, c, d, top };
}

function fCouch(o, cx, cy, col, f) {
  body3d(o, f, 7, col);
  cuboid(cx, cy - 7, f.w * 7 + 6, 5, 11, shade(col, 1.12), shade(col, 0.9), shade(col, 0.72));
}
function fChair(o, cx, cy, col, f) {
  cuboid(cx, cy, 12, 6, 6, col, shade(col, 0.8), shade(col, 0.62));
  cuboid(cx, cy - 6, 11, 4, 10, shade(col, 1.1), shade(col, 0.86), shade(col, 0.7));
}
function fBed(o, cx, cy, col, f) {
  body3d(o, f, 6, col);
  cuboid(cx, cy - 7, f.w * 6 + 4, 4, 8, shade(col, 0.7), shade(col, 0.55), shade(col, 0.44)); // headboard
  const pc = toScreen(o.tile.x, o.tile.y);
  ctx.fillStyle = "#f2eef8"; ctx.strokeStyle = C.line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(pc.x, pc.y - 8, 8, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}
function fLamp(o, cx, cy, col, f) {
  ctx.strokeStyle = C.line; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 26); ctx.stroke();
  ctx.fillStyle = "#cfc8d6";
  ctx.beginPath(); ctx.moveTo(cx - 9, cy - 26); ctx.lineTo(cx + 9, cy - 26);
  ctx.lineTo(cx + 6, cy - 36); ctx.lineTo(cx - 6, cy - 36); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.2; ctx.stroke();
}
function fOrb(o, cx, cy, col, f) {
  cuboid(cx, cy, 5, 3, 5, "#33303a", "#26242c", "#1c1a20");
  ctx.fillStyle = col; ctx.strokeStyle = C.line; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(cx, cy - 13, 7, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}
function fStrip(o, cx, cy, col, f) {
  ctx.fillStyle = col; ctx.strokeStyle = shade(col, 0.7); ctx.lineWidth = 2;
  ctx.fillRect(cx - 13, cy - 26, 26, 9); ctx.strokeRect(cx - 13, cy - 26, 26, 9);
  ctx.fillStyle = "#fff6d8";
  [-9, -3, 3, 9].forEach((dx) => { ctx.beginPath(); ctx.arc(cx + dx, cy - 21, 1.6, 0, Math.PI * 2); ctx.fill(); });
}
function fFridge(o, cx, cy, col, f) {
  cuboid(cx, cy, 11, 6, 30, col, shade(col, 0.8), shade(col, 0.62));
  ctx.strokeStyle = shade(col, 0.55); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx - 11, cy - 12); ctx.lineTo(cx + 11, cy - 12); ctx.stroke();
  ctx.fillStyle = "#7c858f"; ctx.fillRect(cx + 5, cy - 26, 2.5, 9); ctx.fillRect(cx + 5, cy - 9, 2.5, 6);
}
function fStove(o, cx, cy, col, f) {
  cuboid(cx, cy, 13, 7, 16, col, shade(col, 0.8), shade(col, 0.62));
  ctx.fillStyle = "#2a2730";
  [[-5, -2], [5, 2]].forEach(([dx, dy]) => { ctx.beginPath(); ctx.ellipse(cx + dx, cy - 16 + dy, 3.5, 2, 0, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = "#3a3540"; ctx.fillRect(cx - 6, cy - 10, 12, 5);
}
function fCounter(o, cx, cy, col, f) {
  body3d(o, f, 14, col);
}
function fAppliance(o, cx, cy, col, f) {
  cuboid(cx, cy, 11, 6, 11, col, shade(col, 0.8), shade(col, 0.62));
  ctx.fillStyle = "#5a7a8a"; ctx.fillRect(cx - 7, cy - 9, 9, 6);
  ctx.fillStyle = "#d8d2e0"; [cy - 8, cy - 5].forEach((yy) => { ctx.beginPath(); ctx.arc(cx + 6, yy, 1.2, 0, Math.PI * 2); ctx.fill(); });
}
function fTv(o, cx, cy, col, f) {
  cuboid(cx, cy, 4, 3, 3, "#3a3540", "#2a2730", "#1f1c24");
  ctx.fillStyle = col; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  ctx.fillRect(cx - 13, cy - 26, 26, 18); ctx.strokeRect(cx - 13, cy - 26, 26, 18);
  ctx.fillStyle = "#2d6ad6"; ctx.fillRect(cx - 11, cy - 24, 22, 14);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath(); ctx.moveTo(cx - 11, cy - 24); ctx.lineTo(cx - 2, cy - 24); ctx.lineTo(cx - 9, cy - 10); ctx.lineTo(cx - 11, cy - 10); ctx.closePath(); ctx.fill();
}
function fDeck(o, cx, cy, col, f) {
  cuboid(cx, cy, 13, 7, 6, col, shade(col, 0.8), shade(col, 0.62));
  ctx.fillStyle = "#1c1a20"; ctx.beginPath(); ctx.ellipse(cx - 4, cy - 7, 4, 2.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#d8d2e0"; ctx.beginPath(); ctx.arc(cx - 4, cy - 7, 0.8, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#5a5560"; ctx.lineWidth = 1;
  [cx + 2, cx + 5, cx + 8].forEach((xx) => { ctx.beginPath(); ctx.moveTo(xx, cy - 9); ctx.lineTo(xx, cy - 5); ctx.stroke(); });
}
function fToilet(o, cx, cy, col, f) {
  cuboid(cx - 4, cy - 3, 5, 4, 14, col, shade(col, 0.82), shade(col, 0.66));   // tank behind
  cuboid(cx, cy, 9, 6, 7, col, shade(col, 0.82), shade(col, 0.66));            // bowl
  ctx.fillStyle = "#dfe6ec"; ctx.strokeStyle = C.line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(cx, cy - 7, 6, 3.2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}
function fSink(o, cx, cy, col, f) {
  cuboid(cx, cy, 4, 3, 13, shade(col, 0.9), shade(col, 0.75), shade(col, 0.6));
  cuboid(cx, cy - 13, 9, 5, 4, col, shade(col, 0.85), shade(col, 0.7));
  ctx.fillStyle = "#bfe3ef"; ctx.beginPath(); ctx.ellipse(cx, cy - 15, 5, 2.4, 0, 0, Math.PI * 2); ctx.fill();
}
function fTub(o, cx, cy, col, f) {
  body3d(o, f, 9, col);
  const c = toScreen(o.tile.x + (f.w - 1) / 2, o.tile.y + (f.h - 1) / 2);
  ctx.fillStyle = "#bfe3ef"; ctx.beginPath(); ctx.ellipse(c.x, c.y - 9, 9 * f.w, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#cdb46a"; [[-12, 2], [12, 2]].forEach(([dx, dy]) => { ctx.beginPath(); ctx.arc(c.x + dx, c.y + dy, 2, 0, Math.PI * 2); ctx.fill(); });
}
function fShower(o, cx, cy, col, f) {
  cuboid(cx, cy, 11, 6, 26, "rgba(190,224,234,0.32)", "rgba(150,195,212,0.30)", "rgba(120,165,185,0.30)");
  ctx.fillStyle = "#9aa3ad"; ctx.beginPath(); ctx.arc(cx - 5, cy - 24, 2.5, 0, Math.PI * 2); ctx.fill();
}
function fRack(o, cx, cy, col, f) {
  ctx.strokeStyle = shade(col, 0.7); ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(cx - 11, cy - 22); ctx.lineTo(cx + 11, cy - 22); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - 11, cy); ctx.lineTo(cx - 11, cy - 22); ctx.moveTo(cx + 11, cy); ctx.lineTo(cx + 11, cy - 22); ctx.stroke();
  const cc = ["#ff6b9b", "#4fc3f7", "#7CFC9B", "#ffd23f"];
  [-8, -3, 2, 7].forEach((dx, i) => { ctx.fillStyle = cc[i % 4]; ctx.fillRect(cx + dx - 2, cy - 21, 4, 11); });
}
function fPlant(o, cx, cy, col, f) {
  cuboid(cx, cy, 6, 4, 6, "#8a5a36", "#6e472a", "#543620");
  ctx.fillStyle = col; ctx.strokeStyle = shade(col, 0.6); ctx.lineWidth = 1.2;
  [[-5, -16, -0.5], [0, -20, 0], [5, -16, 0.5]].forEach(([dx, dy, rot]) => {
    ctx.save(); ctx.translate(cx + dx, cy + dy); ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0, 0, 4, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  });
}
function fCactus(o, cx, cy, col, f) {
  cuboid(cx, cy, 6, 4, 5, "#9a6a3a", "#7c5430", "#604124");
  ctx.fillStyle = col; ctx.strokeStyle = shade(col, 0.6); ctx.lineWidth = 1.2;
  [[-4, 12], [2, 16], [6, 10]].forEach(([dx, h]) => {
    ctx.beginPath(); ctx.ellipse(cx + dx, cy - 5 - h * 0.5, 3, h * 0.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
}
function fRug(o, cx, cy, col, f) {
  for (let i = 0; i < f.w; i++) for (let j = 0; j < f.h; j++) {
    const c = toScreen(o.tile.x + i, o.tile.y + j); diamond(c.x, c.y, col, shade(col, 0.55));
  }
}
function fArt(o, cx, cy, col, f) {
  ctx.fillStyle = "#2a2433"; ctx.fillRect(cx - 11, cy - 30, 22, 24);
  ctx.fillStyle = col; ctx.fillRect(cx - 9, cy - 28, 18, 20);
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.2; ctx.strokeRect(cx - 11, cy - 30, 22, 24);
}
function fMirror(o, cx, cy, col, f) {
  ctx.fillStyle = "#9aa3ad"; ctx.fillRect(cx - 9, cy - 30, 18, 26);
  const g = ctx.createLinearGradient(cx - 8, cy - 28, cx + 8, cy - 6);
  g.addColorStop(0, "#dff0f6"); g.addColorStop(0.5, "#9fc3d6"); g.addColorStop(1, "#cfe6f0");
  ctx.fillStyle = g; ctx.fillRect(cx - 7, cy - 28, 14, 22);
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.2; ctx.strokeRect(cx - 9, cy - 30, 18, 26);
}
function fClock(o, cx, cy, col, f) {
  ctx.fillStyle = "#15131a"; ctx.beginPath(); ctx.arc(cx, cy - 20, 9, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy - 20, 9, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx, cy - 20); ctx.lineTo(cx, cy - 26); ctx.moveTo(cx, cy - 20); ctx.lineTo(cx + 5, cy - 20); ctx.stroke();
}
function fShelf(o, cx, cy, col, f) {
  body3d(o, f, 26, col);
  const cc = ["#ff6b9b", "#4fc3f7", "#7CFC9B", "#ffd23f", "#b388ff"];
  [-10, -7, -4, -1].forEach((dx, i) => { ctx.fillStyle = cc[i % 5]; ctx.fillRect(cx + dx, cy - 23, 2.2, 6); });
  ctx.strokeStyle = shade(col, 0.5); ctx.lineWidth = 1;
  [9, 17].forEach((hh) => { ctx.beginPath(); ctx.moveTo(cx - 12, cy - hh); ctx.lineTo(cx, cy - hh + 6); ctx.stroke(); });
}
function fTable(o, cx, cy, col, f) {
  const s = slab(o, f, 11);
  const corners = [s.a, s.b, s.c, s.d];
  ctx.strokeStyle = shade(col, 0.5); ctx.lineWidth = 2.5;
  corners.forEach((p) => { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - s.top); ctx.stroke(); });
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(s.a.x, s.a.y - s.top); ctx.lineTo(s.b.x, s.b.y - s.top);
  ctx.lineTo(s.c.x, s.c.y - s.top); ctx.lineTo(s.d.x, s.d.y - s.top); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = shade(col, 0.7);
  ctx.beginPath(); ctx.moveTo(s.d.x, s.d.y - s.top); ctx.lineTo(s.c.x, s.c.y - s.top);
  ctx.lineTo(s.c.x, s.c.y - s.top + 3); ctx.lineTo(s.d.x, s.d.y - s.top + 3); ctx.closePath(); ctx.fill();
}
function fCart(o, cx, cy, col, f) {
  ctx.strokeStyle = shade(col, 0.55); ctx.lineWidth = 1.8; ctx.strokeRect(cx - 8, cy - 15, 16, 11);
  ctx.beginPath(); ctx.moveTo(cx - 8, cy - 4); ctx.lineTo(cx - 6, cy); ctx.moveTo(cx + 8, cy - 4); ctx.lineTo(cx + 6, cy); ctx.stroke();
  ctx.fillStyle = C.line; [[-5, 1], [5, 1]].forEach(([dx, dy]) => { ctx.beginPath(); ctx.arc(cx + dx, cy + dy, 2, 0, Math.PI * 2); ctx.fill(); });
  ctx.strokeStyle = shade(col, 0.75); ctx.lineWidth = 0.8;
  [-4, 0, 4].forEach((dx) => { ctx.beginPath(); ctx.moveTo(cx + dx, cy - 15); ctx.lineTo(cx + dx, cy - 4); ctx.stroke(); });
}
function fBooth(o, cx, cy, col, f) {
  body3d(o, f, 6, col);
  cuboid(cx, cy - 6, f.w * 7 + 4, 4, 13, shade(col, 1.1), shade(col, 0.85), shade(col, 0.68));
}
function fCase(o, cx, cy, col, f) {
  isoBox(o.tile.x, o.tile.y, f.w, f.h, 16, "rgba(190,224,234,0.32)", "rgba(150,195,212,0.30)", "rgba(120,165,185,0.30)");
  ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.fillRect(cx - 3, cy - 12, 2, 8);
}
function fSign(o, cx, cy, col, f) {
  ctx.strokeStyle = "#3a3540"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 10); ctx.stroke();
  ctx.fillStyle = col; ctx.fillRect(cx - 11, cy - 28, 22, 18);
  ctx.strokeStyle = "#caa56b"; ctx.lineWidth = 1.5; ctx.strokeRect(cx - 11, cy - 28, 22, 18);
  ctx.strokeStyle = "rgba(230,230,230,0.7)"; ctx.lineWidth = 1;
  [-23, -19, -15].forEach((yy) => { ctx.beginPath(); ctx.moveTo(cx - 8, cy + yy); ctx.lineTo(cx + 6, cy + yy); ctx.stroke(); });
}

const DECOR_FORMS = {
  couch: fCouch, chair: fChair, bed: fBed, lamp: fLamp, orb: fOrb, strip: fStrip,
  fridge: fFridge, stove: fStove, counter: fCounter, appliance: fAppliance, tv: fTv, deck: fDeck,
  toilet: fToilet, sink: fSink, tub: fTub, shower: fShower, rack: fRack, plant: fPlant,
  cactus: fCactus, rug: fRug, art: fArt, mirror: fMirror, clock: fClock, shelf: fShelf,
  table: fTable, cart: fCart, booth: fBooth, case: fCase, sign: fSign
};

function drawDecor(o, cx, cy) {
  const def = (DATA.decor && DATA.decor.items && DATA.decor.items[o.decorId]) || {};
  const f = footOf(o);
  const col = def.color || "#9a7a4a";
  if (def.glow) {                              // real illumination: additive radial glow
    const g = def.glow, r = g.r || 30;
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.55;
    const grad = ctx.createRadialGradient(cx, cy - 16, 2, cx, cy - 16, r);
    grad.addColorStop(0, g.color); grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cy - 16, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  const fn = DECOR_FORMS[def.shape];
  if (fn) return fn(o, cx, cy, col, f);
  if (f.w > 1 || f.h > 1) return body3d(o, f, 12, col);
  cuboid(cx, cy, 13, 6, 12, col, shade(col, 0.8), shade(col, 0.62));
}

function cuboid(cx, cy, fw, fh, hgt, top, lft, rgt) {
  ctx.beginPath(); ctx.moveTo(cx - fw, cy); ctx.lineTo(cx, cy + fh);
  ctx.lineTo(cx, cy + fh - hgt); ctx.lineTo(cx - fw, cy - hgt); ctx.closePath();
  ctx.fillStyle = lft; ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx + fw, cy); ctx.lineTo(cx, cy + fh);
  ctx.lineTo(cx, cy + fh - hgt); ctx.lineTo(cx + fw, cy - hgt); ctx.closePath();
  ctx.fillStyle = rgt; ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx, cy - fh - hgt); ctx.lineTo(cx + fw, cy - hgt);
  ctx.lineTo(cx, cy + fh - hgt); ctx.lineTo(cx - fw, cy - hgt); ctx.closePath();
  ctx.fillStyle = top; ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke();
}
function billboardGuitar(cx, cy) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.32);
  ctx.fillStyle = C.orange; ctx.strokeStyle = C.line; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, -8, 11, 15, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(0, -8, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#caa56b"; ctx.fillRect(-2.5, -40, 5, 26); ctx.strokeRect(-2.5, -40, 5, 26);
  ctx.restore();
}
function stringed(cx, cy, color) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.32);
  ctx.fillStyle = color; ctx.strokeStyle = C.line; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, -8, 12, 16, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(0, -8, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#caa56b"; ctx.fillRect(-2.5, -44, 5, 30); ctx.strokeRect(-2.5, -44, 5, 30);
  ctx.restore();
}
function pianoShape(cx, cy) {
  cuboid(cx, cy, 24, 12, 12, "#1c1622", "#15101b", "#100c15");
  ctx.fillStyle = "#e8e4ec"; ctx.fillRect(cx - 18, cy - 13, 36, 5);
  ctx.fillStyle = "#0b0b0f"; for (let i = -15; i <= 15; i += 6) ctx.fillRect(cx + i, cy - 13, 2, 3);
}
function drumsShape(cx, cy) {
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  ctx.fillStyle = "#3a2d40"; ctx.beginPath(); ctx.ellipse(cx, cy - 6, 18, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#cfc9d6"; ctx.beginPath(); ctx.ellipse(cx, cy - 12, 18, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.orange; ctx.beginPath(); ctx.ellipse(cx + 15, cy - 18, 8, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = C.yellow; ctx.beginPath(); ctx.moveTo(cx - 22, cy - 26); ctx.lineTo(cx - 6, cy - 20); ctx.stroke();
}
function micShape(cx, cy) {
  ctx.strokeStyle = "#9aa3ad"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 30); ctx.stroke();
  ctx.fillStyle = "#2a2233"; ctx.beginPath(); ctx.ellipse(cx, cy, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C.pink; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy - 34, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}
function building(cx, cy, color) {
  const w = 22, h = 11, ht = 56;
  cuboid(cx, cy, w, h, ht, pal("bldgL", "#241d30"), pal("bldgR", "#181122"), pal("bldgTop", "#120d18"));
  ctx.fillStyle = color; ctx.fillRect(cx - w, cy - ht + 4, w * 2, 9);
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.strokeRect(cx - w, cy - ht + 4, w * 2, 9);
  ctx.fillStyle = "#1b2333"; ctx.strokeRect(cx - w + 6, cy - 32, 15, 12); ctx.fillRect(cx - w + 6, cy - 32, 15, 12);
  ctx.fillStyle = "#0c0810"; ctx.fillRect(cx + 2, cy - 19, 13, 19);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.strokeRect(cx + 2, cy - 19, 13, 19);
}
function buskSpot(cx, cy) {
  cuboid(cx, cy, 11, 6, 15, "#2a2233", "#1f1828", "#160f1f");
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.fillStyle = "#0c0810";
  ctx.beginPath(); ctx.arc(cx - 3, cy - 9, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "rgba(124,252,155,0.45)"; ctx.fillRect(cx + 7, cy - 9, 8, 9);
  ctx.strokeStyle = C.green; ctx.strokeRect(cx + 7, cy - 9, 8, 9);
}
function homeDoor(cx, cy) {
  cuboid(cx, cy, 16, 8, 34, "#2b2336", "#1f1829", "#160f1f");
  ctx.fillStyle = C.purple; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx - 18, cy - 34); ctx.lineTo(cx, cy - 47); ctx.lineTo(cx + 18, cy - 34); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#0c0810"; ctx.fillRect(cx - 5, cy - 17, 10, 17);
  ctx.strokeStyle = C.yellow; ctx.strokeRect(cx - 5, cy - 17, 10, 17);
}
function busSign(cx, cy) {
  cuboid(cx, cy, 6, 3, 30, "#2a2233", "#1f1828", "#160f1f");
  ctx.fillStyle = C.yellow; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  ctx.fillRect(cx - 13, cy - 30, 22, 11); ctx.strokeRect(cx - 13, cy - 30, 22, 11);
  ctx.fillStyle = C.ink; ctx.font = "bold 8px " + (C.mono || "monospace"); ctx.textAlign = "center";
  ctx.fillText("BUS", cx - 2, cy - 22); ctx.textAlign = "left";
}
function cabinet(cx, cy) {
  cuboid(cx, cy, 9, 5, 34, "#241d30", "#181122", "#120d18");
  ctx.fillStyle = "rgba(79,195,247,0.6)"; ctx.fillRect(cx - 6, cy - 30, 12, 13);
  ctx.strokeStyle = C.blue; ctx.lineWidth = 1.5; ctx.strokeRect(cx - 6, cy - 30, 12, 13);
  ctx.fillStyle = C.pink; ctx.fillRect(cx - 6, cy - 14, 12, 3);
}
function npcFigure(cx, cy, o) {
  const cols = { npc_brian: C.orange, npc_lex: C.blue, npc_ruby: C.pink, npc_jo: C.purple,
    npc_dex: C.pink, npc_marlo: C.orange, npc_pidge: C.green, npc_suzie: C.yellow,
    npc_grim: C.blue, npc_tex: C.orange, npc_vee: C.purple, npc_otis: C.blue };
  const GENRE_COL = { blues: "#4a6fa5", rock: "#c0392b", jazz: "#9b59b6", funk: "#e67e22", electronic: "#1abc9c", country: "#c9a23d", pop: "#ff6fb5", metal: "#7f8c8d", hiphop: "#f1c40f", soul: "#8e44ad", punk: "#e74c3c", indie: "#16a085" };
  const col = cols[o.npcId] || GENRE_COL[o.genre] || C.green;
  ctx.fillStyle = "#1b1622"; ctx.fillRect(cx - 5, cy - 12, 4, 12); ctx.fillRect(cx + 1, cy - 12, 4, 12);
  ctx.fillStyle = col; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  roundRect(cx - 7, cy - 26, 14, 16, 3); ctx.fill(); ctx.stroke();
  if (o.rival) { ctx.fillStyle = "#11121a"; ctx.fillRect(cx - 7, cy - 21, 14, 4); ctx.fillStyle = "#ffd23f"; ctx.fillRect(cx - 4, cy - 20, 8, 2); }
  ctx.fillStyle = "#e9c9a0"; ctx.beginPath(); ctx.arc(cx, cy - 31, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = col; ctx.fillRect(cx - 6, cy - 37, 12, 4);
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(cx + 2, cy - 31, 1.2, 0, Math.PI * 2); ctx.fill();
}
function stageShape(cx, cy) {
  cuboid(cx, cy, 26, 13, 8, "#2a2233", "#1f1828", "#160f1f");
  ctx.strokeStyle = "#9aa3ad"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy - 34); ctx.stroke();
  ctx.fillStyle = C.pink; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy - 37, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#1a1422"; ctx.fillRect(cx + 10, cy - 22, 12, 14); ctx.strokeRect(cx + 10, cy - 22, 12, 14);
  ctx.fillStyle = C.yellow; ctx.fillRect(cx + 13, cy - 19, 6, 6);
}
// short, floor-level threshold — never occludes furniture behind it
function doorway(cx, cy, label) {
  label = String(label || "OUT").toUpperCase().slice(0, 7);
  // faint floor threshold (not a solid trapdoor)
  diamond(cx, cy, "rgba(255,210,63,0.10)", "rgba(255,210,63,0.42)");
  // standing vertical doorframe — reads as a door set into the wall
  const fw = 13, fh = 32;
  ctx.fillStyle = "#0c0812"; ctx.fillRect(cx - fw, cy - fh, fw * 2, fh);
  ctx.fillStyle = "#15101c"; ctx.fillRect(cx - fw + 3, cy - fh + 3, fw * 2 - 6, fh - 5);
  ctx.strokeStyle = C.yellow; ctx.lineWidth = 2.5; ctx.strokeRect(cx - fw, cy - fh, fw * 2, fh);
  // label above the frame
  ctx.fillStyle = C.yellow; ctx.textAlign = "center";
  ctx.font = `700 ${label.length > 5 ? 7 : 9}px 'Arial Narrow', sans-serif`;
  ctx.fillText(label, cx, cy - fh - 3); ctx.textAlign = "left";
}
function outlineObject(cx, cy) {
  ctx.strokeStyle = C.green; ctx.lineWidth = 2;
  ctx.strokeRect(cx - TILE_W * 0.5, cy - 48, TILE_W, 60);
}
function drawPlayer() {
  const c = toScreen(player.x, player.y);
  shadow(c.x, c.y, 13, 7);
  const img = getImage("assets/img/chars/player.png");
  ctx.save();
  if (player.facing < 0) { ctx.translate(c.x, 0); ctx.scale(-1, 1); ctx.translate(-c.x, 0); }
  if (img && img._ok) {
    const dw = 40, dh = dw * (img.naturalHeight / img.naturalWidth || 1.6);
    ctx.drawImage(img, c.x - dw / 2, c.y - dh + 6, dw, dh);
  } else {
    const col = getState().player?.avatar?.color || C.pink;
    ctx.fillStyle = "#1b1622"; ctx.fillRect(c.x - 5, c.y - 12, 4, 12); ctx.fillRect(c.x + 1, c.y - 12, 4, 12);
    ctx.fillStyle = col; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
    roundRect(c.x - 7, c.y - 26, 14, 16, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#e9c9a0"; ctx.beginPath(); ctx.arc(c.x, c.y - 31, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.fillRect(c.x - 6, c.y - 37, 12, 4);
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(c.x + 3, c.y - 31, 1.3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawDayNight() {
  const hour = getState().time.hour;
  let col = null;
  if (hour >= 6 && hour < 9) col = "rgba(255,150,90,0.10)";
  else if (hour >= 9 && hour < 17) col = null;
  else if (hour >= 17 && hour < 20) col = "rgba(255,120,40,0.16)";
  else if (hour >= 20 && hour < 23) col = "rgba(40,40,110,0.30)";
  else col = "rgba(15,18,55,0.46)";
  if (!col) return;
  ctx.fillStyle = col; ctx.fillRect(0, 0, cssW, cssH);
}
function drawLabel() {
  const o = objectAt2(hovered);
  if (!o) return;
  const c = toScreen(o.tile.x, o.tile.y);
  const txt = o.name.toUpperCase();
  ctx.font = "700 12px 'Arial Narrow', Oswald, sans-serif";
  const tw = ctx.measureText(txt).width + 14;
  const lx = c.x - tw / 2, ly = c.y - 64;
  ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.fillRect(lx, ly, tw, 18);
  ctx.strokeStyle = C.green; ctx.lineWidth = 1; ctx.strokeRect(lx, ly, tw, 18);
  ctx.fillStyle = C.green; ctx.textBaseline = "middle";
  ctx.fillText(txt, lx + 7, ly + 10);
  ctx.textBaseline = "alphabetic";
}
function objectAt2(id) { return furniture.find((x) => x.id === id) || exits.find((x) => x.id === id) || null; }

function getImage(path) {
  if (!path) return null;
  if (!(DATA.config && DATA.config.useSprites)) return null;   // no PNG art yet -> use code shapes, skip 404 requests
  if (imgCache.has(path)) return imgCache.get(path);
  const img = new Image();
  img._ok = false;
  img.onload = () => { img._ok = true; requestRender(); };
  img.onerror = () => { img._ok = false; img._failed = true; };
  img.src = path;
  imgCache.set(path, img);
  return img;
}

// ============================================================
// World life (Step 24.1): ambient real-time movers — passing cars on
// roads, a town dog, and a couple of pedestrians. Built from the scene's
// optional `world` block; regenerated per visit (never saved). Movers are
// non-interactive ambience — they don't intercept taps and (for now) don't
// collide with the player. Code-drawn placeholders, each overridable by a
// PNG dropped into the matching assets/world/ slot.
// ============================================================
const ROAD = { face: "#2a2630", edge: "#1d1a24", line: "#6b6478" };
const lerp = (a, b, t) => a + (b - a) * t;
const roadLen = (r) => Math.hypot(r.to.x - r.from.x, r.to.y - r.from.y) || 1;
function lineTiles(from, to) {
  const out = [{ x: from.x, y: from.y }]; const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  let x = from.x, y = from.y, guard = 0;
  while ((x !== to.x || y !== to.y) && guard++ < 64) { x += dx; y += dy; out.push({ x, y }); }
  return out;
}
function randomFreeTileNear(cx, cy, rad) {
  for (let i = 0; i < 14; i++) { const x = Math.round(cx + (Math.random() * 2 - 1) * rad), y = Math.round(cy + (Math.random() * 2 - 1) * rad); if (isFree(x, y)) return { x, y }; }
  return null;
}
function posCar(m) { const r = m.road; m.x = lerp(r.from.x, r.to.x, m.t); m.y = lerp(r.from.y, r.to.y, m.t); }
function spawnCar(r, t0, dir) { const m = { kind: "car", road: r, t: t0, dir, speed: 1.5, x: 0, y: 0, facing: 1 }; posCar(m); return m; }
function spawnBoat(r, t0, dir) { const m = { kind: "boat", road: r, t: t0, dir, speed: 0.5, x: 0, y: 0, facing: 1 }; posCar(m); return m; }
function drawBoat(cx, cy, facing) {
  shadow(cx, cy, 22, 9);
  ctx.save();
  ctx.fillStyle = "rgba(200,230,255,0.16)"; ctx.beginPath(); ctx.ellipse(cx, cy + 5, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#6b5a45"; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx - 18, cy); ctx.lineTo(cx + 18, cy); ctx.lineTo(cx + 11, cy + 9); ctx.lineTo(cx - 11, cy + 9); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#aeb9c2"; roundRect(cx - 8, cy - 13, 16, 13, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#3a4750"; ctx.fillRect(cx - 5, cy - 10, 10, 5);
  ctx.restore();
}
function makeWanderer(kind, speed) {
  const w = room.size?.w || 8, h = room.size?.h || 6; let spot = null;
  for (let i = 0; i < 24 && !spot; i++) { const x = Math.floor(Math.random() * w), y = Math.floor(Math.random() * h); if (isFree(x, y)) spot = { x, y }; }
  spot = spot || firstFreeTile();
  return { kind, x: spot.x, y: spot.y, speed, target: null, pause: Math.random() * 1.5, facing: 1 };
}
function buildWorld() {
  movers = []; roads = [];
  const W = room && room.world; if (!W) return;
  roads = (W.roads || []).map((r) => ({ id: r.id, from: r.from, to: r.to }));
  const amb = W.ambient || {};
  const nCars = Math.min(3, amb.cars || 0);
  for (let i = 0; i < nCars; i++) { const r = roads[i % Math.max(1, roads.length)]; if (!r) break; const dir = i % 2 ? -1 : 1; movers.push(spawnCar(r, dir > 0 ? i / Math.max(1, nCars) : 1 - i / Math.max(1, nCars), dir)); }
  if (amb.dog) movers.push(makeWanderer("dog", 1.5));
  const nPed = Math.min(4, amb.pedestrians || 0);
  for (let i = 0; i < nPed; i++) movers.push(makeWanderer("ped", 1.0));
  const lanes = (W.waterLanes || []).map((r) => ({ id: r.id, from: r.from, to: r.to }));
  const nBoats = Math.min(3, amb.boats || 0);
  for (let i = 0; i < nBoats; i++) { const r = lanes[i % Math.max(1, lanes.length)]; if (!r) break; const dir = i % 2 ? -1 : 1; movers.push(spawnBoat(r, dir > 0 ? i / Math.max(1, nBoats) : 1 - i / Math.max(1, nBoats), dir)); }
}
function updateMovers(dt) {
  for (const m of movers) (m.kind === "car" || m.kind === "boat") ? updateCar(m, dt) : updateWanderer(m, dt);
  for (const m of npcMovers) if (!m.posted) updateWanderer(m, dt);
}
function updateCar(m, dt) {
  m.t += m.dir * (m.speed / roadLen(m.road)) * dt;
  if (m.t > 1) m.t -= 1; else if (m.t < 0) m.t += 1;
  const px = m.x, py = m.y; posCar(m);
  const sdx = (m.x - px) - (m.y - py); if (Math.abs(sdx) > 0.0001) m.facing = sdx >= 0 ? 1 : -1;
  if (m.t >= 0.5 && !m.passed) { m.passed = true; if (Math.random() < 0.5) playWorldSfx("car_pass", 0.5, 0.82 + Math.random() * 0.42); } else if (m.t < 0.45) m.passed = false;
}
function updateWanderer(m, dt) {
  if (m.kind === "dog") { m.bark = (m.bark == null ? 9 + Math.random() * 12 : m.bark - dt); if (m.bark <= 0) { playWorldSfx("dog_bark", 0.6); m.bark = 18 + Math.random() * 30; } }
  if (m.pause > 0) { m.pause -= dt; return; }
  if (!m.target) { m.target = randomFreeTileNear(m.x, m.y, 3); if (!m.target) { m.pause = 1; return; } }
  const dx = m.target.x - m.x, dy = m.target.y - m.y, dist = Math.hypot(dx, dy), step = m.speed * dt;
  if (dist <= step) { m.x = m.target.x; m.y = m.target.y; m.target = null; m.pause = 0.8 + Math.random() * 2.2; }
  else { m.x += (dx / dist) * step; m.y += (dy / dist) * step; const sdx = dx - dy; if (Math.abs(sdx) > 0.0001) m.facing = sdx >= 0 ? 1 : -1; }
}
function drawRoads() {
  for (const r of roads) {
    for (const t of lineTiles(r.from, r.to)) { const c = toScreen(t.x, t.y); diamond(c.x, c.y, ROAD.face, ROAD.edge); }
    const n = Math.max(1, Math.round(roadLen(r)));
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; const c = toScreen(lerp(r.from.x, r.to.x, t), lerp(r.from.y, r.to.y, t)); ctx.fillStyle = ROAD.line; ctx.fillRect(c.x - 3, c.y - 1, 6, 2); }
  }
}
function flipped(cx, facing, fn) { ctx.save(); if (facing < 0) { ctx.translate(cx, 0); ctx.scale(-1, 1); ctx.translate(-cx, 0); } fn(); ctx.restore(); }
function drawMover(m) {
  const c = toScreen(m.x, m.y);
  if (m.kind === "car") return drawCar(c.x, c.y, m.facing);
  if (m.kind === "boat") return drawBoat(c.x, c.y, m.facing);
  if (m.kind === "dog") return drawDog(c.x, c.y, m.facing);
  if (m.kind === "npc") {
    shadow(c.x, c.y, 12, 6);
    flipped(c.x, m.facing, () => npcFigure(c.x, c.y, { npcId: m.npcId, genre: m.genre, rival: m.rival }));
    if (m.band) { ctx.save(); ctx.fillStyle = "#b388ff"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.fillText("\u266A", c.x, c.y - 44); ctx.restore(); }
    else if (m.interact === "talk") { ctx.save(); ctx.fillStyle = "#ffd23f"; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center"; ctx.fillText("\u266A", c.x, c.y - 44); ctx.restore(); }
    return;
  }
  return drawPed(c.x, c.y, m.facing);
}
function drawCar(cx, cy, facing) {
  shadow(cx, cy, 20, 9);
  const img = getImage("assets/world/car.png");
  if (img && img._ok) { const dw = 54, dh = dw * (img.naturalHeight / img.naturalWidth || 0.6); return flipped(cx, facing, () => ctx.drawImage(img, cx - dw / 2, cy - dh + 8, dw, dh)); }
  flipped(cx, facing, () => {
    ctx.fillStyle = "#e0556b"; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
    roundRect(cx - 18, cy - 16, 36, 14, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#f2c14e"; roundRect(cx - 11, cy - 24, 22, 10, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#bfe6ff"; ctx.fillRect(cx - 8, cy - 22, 16, 6);
    ctx.fillStyle = "#1b1622"; ctx.beginPath(); ctx.arc(cx - 11, cy - 1, 4, 0, Math.PI * 2); ctx.arc(cx + 11, cy - 1, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff6cc"; ctx.fillRect(cx + 16, cy - 13, 3, 4);
  });
}
function drawDog(cx, cy, facing) {
  shadow(cx, cy, 9, 4);
  const img = getImage("assets/world/dog.png");
  if (img && img._ok) { const dw = 26, dh = dw * (img.naturalHeight / img.naturalWidth || 0.8); return flipped(cx, facing, () => ctx.drawImage(img, cx - dw / 2, cy - dh + 4, dw, dh)); }
  flipped(cx, facing, () => {
    ctx.fillStyle = "#8a6b4a"; ctx.strokeStyle = C.line; ctx.lineWidth = 1.4;
    roundRect(cx - 9, cy - 12, 18, 8, 3); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + 9, cy - 13, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#6e5236"; ctx.fillRect(cx - 8, cy - 5, 2.5, 5); ctx.fillRect(cx + 5, cy - 5, 2.5, 5);
    ctx.fillStyle = "#8a6b4a"; ctx.beginPath(); ctx.moveTo(cx - 9, cy - 11); ctx.lineTo(cx - 14, cy - 15); ctx.lineTo(cx - 9, cy - 8); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(cx + 11, cy - 14, 1, 0, Math.PI * 2); ctx.fill();
  });
}
function drawPed(cx, cy, facing) {
  shadow(cx, cy, 10, 5);
  const img = getImage("assets/world/pedestrian.png");
  if (img && img._ok) { const dw = 30, dh = dw * (img.naturalHeight / img.naturalWidth || 1.6); return flipped(cx, facing, () => ctx.drawImage(img, cx - dw / 2, cy - dh + 6, dw, dh)); }
  flipped(cx, facing, () => {
    ctx.fillStyle = "#1b1622"; ctx.fillRect(cx - 5, cy - 12, 4, 12); ctx.fillRect(cx + 1, cy - 12, 4, 12);
    ctx.fillStyle = "#6fae8f"; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
    roundRect(cx - 7, cy - 26, 14, 16, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#e9c9a0"; ctx.beginPath(); ctx.arc(cx, cy - 31, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#3a2f49"; ctx.fillRect(cx - 6, cy - 37, 12, 4);
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(cx + 2, cy - 31, 1.2, 0, Math.PI * 2); ctx.fill();
  });
}

// ============================================================
// NPC routines (Step 24.4): scheduled NPCs inhabit walkable scenes by
// time-of-day. Each NPC's per-slot `schedule` says which scene they're in
// (and optionally a fixed `post` tile for workers); everyone else wanders
// via the mover system. Recruitable musicians keep their talk/recruit flow;
// flavor townsfolk show a line. Re-evaluated on scene entry + slot change.
// ============================================================
function scheduleResolve(npc, slot) {
  const sc = npc.schedule && npc.schedule[slot];
  if (!sc || sc === "away") return null;
  if (typeof sc === "string") return { at: sc, post: null };
  return { at: sc.at, post: sc.post || null };
}
function npcRecruited(id) { return (getState().musicians || []).some((m) => m.id === id && m.bandId); }
function bandBusyNow() {   // does your band have a show/practice this very slot?
  const b = activeBand(); if (!b) return false;
  return bookedCommitments().some((c) => c.bandId === b.id && c.day === currentDay() && c.slot === currentSlot());
}
const BANDMATE_LINES = ["\"Ready when you are.\"", "\"When's the next gig?\"", "\"Sounds good, boss.\"", "\"Place is dead tonight, huh.\"", "\"I've been working on something new.\""];
function bandmateLine(npc) { const day = (getState().time && getState().time.day) || 1; const i = (npc.id.length + day) % BANDMATE_LINES.length; return `${npc.name || "Bandmate"}: ${BANDMATE_LINES[i]}`; }
function freeSceneTile() {
  const w = room.size?.w || 8, h = room.size?.h || 6;
  for (let i = 0; i < 30; i++) { const x = Math.floor(Math.random() * w), y = Math.floor(Math.random() * h); if (isFree(x, y)) return { x, y }; }
  return firstFreeTile();
}
function buildSceneNPCs() {
  npcMovers = [];
  const here = getState().location, slot = currentSlot();
  lastSlot = slot;
  const placed = new Set();   // one instance per NPC, ever — no clones on a map
  for (const npc of ((DATA.npcs && DATA.npcs.npcs) || [])) {
    if (placed.has(npc.id)) continue;
    const r = scheduleResolve(npc, slot);
    if (!r || r.at !== here) continue;
    const bandmate = !npc.townsfolk && npcRecruited(npc.id);   // already in your band
    if (bandmate && bandBusyNow()) continue;                   // off at a show / practice
    placed.add(npc.id);
    const posted = !!(r.post && Array.isArray(r.post) && isFree(r.post[0], r.post[1]));
    const spot = posted ? { x: r.post[0], y: r.post[1] } : freeSceneTile();
    npcMovers.push({
      kind: "npc", npcId: npc.id, name: npc.name || npc.id, band: bandmate, genre: npc.genre, rival: !!npc.rival,
      interact: bandmate ? "flavor" : (npc.townsfolk ? "flavor" : "talk"),
      flavor: bandmate ? bandmateLine(npc) : (npc.line || npc.name || ""),
      posted, x: spot.x, y: spot.y, speed: 0.85, target: null, pause: Math.random() * 2, facing: 1
    });
  }
}
function hintRecruitables() {
  const loc = getState().location;
  if (loc === lastHintLoc) return;
  lastHintLoc = loc;
  const n = npcMovers.filter((m) => m.interact === "talk").length;
  if (n > 0) toast(`${n} musician${n > 1 ? "s" : ""} hanging around \u2014 tap one to talk.`, "info");
}
function npcAt(tx, ty) {
  const m = npcMovers.find((mv) => Math.round(mv.x) === tx && Math.round(mv.y) === ty);
  if (!m) return null;
  return { id: m.npcId, tile: { x: tx, y: ty }, interact: m.interact, npcId: m.npcId, name: m.name, flavor: m.flavor };
}
