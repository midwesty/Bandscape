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
import { getState, addStat, setFlag } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { sleep } from "./time.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { openContainerView, giveItem } from "./inventory.js";
import { openDAW } from "./daw.js";
import { openShop, busk, openVenue } from "./shop.js";
import { openRecruit } from "./band.js";
import { openPerform } from "./shows.js";

const C = {
  floorA: "#221a2b", floorB: "#1c1626", floorEdge: "#3a2f49",
  wallL: "#241d30", wallR: "#1a1422", wallTop: "#4a3d5e",
  shadow: "rgba(0,0,0,0.38)",
  pink: "#ff3b6b", yellow: "#ffd23f", green: "#7CFC9B",
  blue: "#4fc3f7", purple: "#b388ff", orange: "#ff8a3d",
  ink: "#0b0b0f", line: "#0b0b0f"
};

const TILE_W = 64, TILE_H = 32, WALL_H = 46, SPEED = 3.6;

let initialized = false, running = false;
let stageEl, canvas, ctx, dpr = 1;
let cssW = 0, cssH = 0, originX = 0, originY = 0;

let room = null, furniture = [], exits = [], blocked = null;
let player = { x: 4, y: 3, fx: 4, fy: 3, facing: 1 };
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

  // seed / migrate movable furniture into the save (per location)
  s.placedObjects = s.placedObjects || {};
  if (!s.placedObjects[s.location]) {
    s.placedObjects[s.location] = JSON.parse(JSON.stringify(room.objects || []));
  }
  furniture = s.placedObjects[s.location];
  // merge any objects added in an update (e.g. new instruments) into existing saves
  const haveIds = new Set(furniture.map((o) => o.id));
  for (const o of (room.objects || [])) if (!haveIds.has(o.id)) furniture.push(JSON.parse(JSON.stringify(o)));
  exits = room.exits || [];
  rebuildBlocked();

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
  for (const o of furniture) { if (o !== except && o.tile && o.kind !== "item") blocked[o.tile.y][o.tile.x] = true; }
  for (const o of exits) { if (o.solid && o.tile && inBounds(o.tile.x, o.tile.y)) blocked[o.tile.y][o.tile.x] = true; }
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
function objectAt(x, y) {
  return furniture.find((o) => o.tile && o.tile.x === x && o.tile.y === y)
      || exits.find((o) => o.tile && o.tile.x === x && o.tile.y === y) || null;
}

// ---- input ----
function onClick(e) {
  const p = ptr(e);
  const t = toTile(p.x, p.y);
  if (!inBounds(t.x, t.y)) return;
  if (arranging) { handleArrangeClick(t); return; }

  const obj = objectAt(t.x, t.y);
  if (obj) { approachAndInteract(obj); return; }
  if (isFree(t.x, t.y)) walkTo(t.x, t.y, null);
}
function onHover(e) {
  if (arranging) return;
  const p = ptr(e);
  const t = toTile(p.x, p.y);
  const obj = objectAt(t.x, t.y);
  const next = obj ? obj.id : null;
  if (next !== hovered) { hovered = next; canvas.style.cursor = obj ? "pointer" : "default"; requestRender(); }
}
function onKey(e) {
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
    if (isFree(t.x, t.y) && !onPlayer) {
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
  const f = furniture.find((o) => o.tile.x === t.x && o.tile.y === t.y);
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
  s.location = to;
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
  const spot = nearestFreeNeighbor(obj.tile.x, obj.tile.y);
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
  const step = SPEED * dt;
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

function handleBus(obj) {
  const s = getState(); const fee = (DATA.config.travel && DATA.config.travel.busFare) || 1000;
  if (s.flags && s.flags.rocktroit_unlocked) { travel(obj.to, obj.spawn); return; }
  if ((s.stats.money || 0) < fee) { toast(`A bus pass to Rocktroit is $${fee}. You can't afford it yet.`, "warn"); return; }
  if (!confirm(`Buy a one-time bus pass to Rocktroit for $${fee}? After this, the bus runs free both ways forever.`)) return;
  addStat("money", -fee); setFlag("rocktroit_unlocked", true);
  toast("Bus pass bought. Next stop: Rocktroit.", "good");
  travel(obj.to, obj.spawn);
}

// ---- interactions ----
function interact(obj) {
  const kind = obj.interact || (obj.to ? "exit" : null);
  switch (kind) {
    case "sleep":
      if (confirm("Crash for the night? (advances to tomorrow and saves)")) sleep();
      break;
    case "equip": {
      const s = getState();
      s.equipped = s.equipped || { instrumentId: null };
      s.equipped.instrumentId = obj.instrumentId;
      s.owned = s.owned || [];
      if (!s.owned.includes(obj.instrumentId)) s.owned.push(obj.instrumentId);
      emit("instrument:equipped", { id: obj.instrumentId });
      toast("You pick up the " + (DATA.instruments[obj.instrumentId]?.name || "instrument") + ".", "good");
      break;
    }
    case "container":
      openContainerView(obj.containerId || "storage");
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
    case "talk":
      openRecruit(obj.npcId);
      break;
    case "stage":
      openPerform(obj.venueId);
      break;
    case "bus":
      handleBus(obj);
      break;
    case "venue":
      openVenue(obj.venueId);
      break;
    case "flavor":
      toast(obj.flavor || obj.name, "info");
      break;
    case "exit":
      travel(obj.to, obj.spawn);
      break;
    default:
      toast(obj.name, "info");
  }
}

// ---- dropped items on the floor ----
function placeFloorItem(d) {
  const tile = { x: Math.round(player.x), y: Math.round(player.y) };
  furniture.push({
    id: "floor_" + Math.random().toString(36).slice(2, 8),
    kind: "item", item: d.item, qty: d.qty, name: d.name, icon: d.icon,
    interact: "pickup", tile
  });
  rebuildBlocked();
  persist();
  requestRender();
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
  draw();
  if (path.length) requestRender();
}

function draw() {
  const w = room.size?.w || 8, h = room.size?.h || 6;
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#0c0810"; ctx.fillRect(0, 0, cssW, cssH);

  drawWalls(w, h);
  drawFloor(w, h);
  drawArrangeOverlay(w, h);

  const ents = [];
  for (const o of furniture) ents.push({ kind: "obj", o, depth: o.tile.x + o.tile.y });
  for (const o of exits) ents.push({ kind: "obj", o, depth: o.tile.x + o.tile.y - 0.5 });
  ents.push({ kind: "player", depth: player.x + player.y + 0.4 });
  ents.sort((a, b) => a.depth - b.depth);
  for (const e of ents) e.kind === "player" ? drawPlayer() : drawObject(e.o);

  drawDayNight();
  if (hovered && !arranging) drawLabel();
}

function drawFloor(w, h) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = toScreen(x, y);
    diamond(c.x, c.y, (x + y) % 2 ? C.floorA : C.floorB, C.floorEdge);
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
      const onPlayer = Math.round(player.x) === x && Math.round(player.y) === y;
      if (isFree(x, y) && !onPlayer) { const c = toScreen(x, y); diamond(c.x, c.y, "rgba(124,252,155,0.16)", "rgba(124,252,155,0.5)"); }
    }
    const hc = toScreen(held.tile.x, held.tile.y);
    diamond(hc.x, hc.y, "rgba(255,210,63,0.22)", C.yellow);
  } else {
    for (const o of furniture) { const c = toScreen(o.tile.x, o.tile.y); diamond(c.x, c.y, null, "rgba(255,210,63,0.55)"); }
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
  const c = toScreen(o.tile.x, o.tile.y);
  const lifted = held === o;
  const img = getImage(o.sprite);
  shadow(c.x, c.y);
  ctx.save();
  if (lifted) ctx.translate(0, -8);
  if (img && img._ok) {
    const dw = (o.kind === "item" ? TILE_W * 0.6 : TILE_W * 1.1), dh = dw * (img.naturalHeight / img.naturalWidth || 1);
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
  if (o.interact === "talk") return npcFigure(cx, cy, o);
  if (o.interact === "stage") return stageShape(cx, cy);
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
    case "door":   doorway(cx, cy); break;
    case "pawn":    building(cx, cy, C.yellow); break;
    case "grocery": building(cx, cy, C.green); break;
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
  cuboid(cx, cy, w, h, ht, "#241d30", "#181122", "#120d18");
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
  const col = cols[o.npcId] || C.green;
  ctx.fillStyle = "#1b1622"; ctx.fillRect(cx - 5, cy - 12, 4, 12); ctx.fillRect(cx + 1, cy - 12, 4, 12);
  ctx.fillStyle = col; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  roundRect(cx - 7, cy - 26, 14, 16, 3); ctx.fill(); ctx.stroke();
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
function doorway(cx, cy) {
  diamond(cx, cy, "#191324", C.yellow);
  ctx.fillStyle = "#15101c"; ctx.fillRect(cx - 11, cy - 15, 22, 15);
  ctx.strokeStyle = C.yellow; ctx.lineWidth = 2; ctx.strokeRect(cx - 11, cy - 15, 22, 15);
  ctx.fillStyle = C.yellow; ctx.font = "700 8px 'Arial Narrow', sans-serif"; ctx.textAlign = "center";
  ctx.fillText("OUT", cx, cy - 5); ctx.textAlign = "left";
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
  if (imgCache.has(path)) return imgCache.get(path);
  const img = new Image();
  img._ok = false;
  img.onload = () => { img._ok = true; requestRender(); };
  img.onerror = () => { img._ok = false; img._failed = true; };
  img.src = path;
  imgCache.set(path, img);
  return img;
}
