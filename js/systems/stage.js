// ============================================================
// stage.js — STEP 2: the isometric apartment renderer.
//
// A 2:1 isometric room drawn on a canvas. Walk by tapping the
// floor (pathfinds around furniture); tap an object to walk over
// and use it. Objects + character are drawn in code (our palette)
// and AUTO-OVERRIDDEN by a real PNG the moment you drop one into
// the matching assets/ slot — zero code changes.
//
// Day/night light is tied to the clock. Tile coordinates come
// straight from data/locations/<id>.json.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { sleep } from "./time.js";
import { toast } from "../ui/toast.js";

// ---- palette ----
const C = {
  floorA: "#221a2b", floorB: "#1c1626", floorEdge: "#3a2f49",
  wallL: "#241d30", wallR: "#1a1422", wallTop: "#4a3d5e",
  shadow: "rgba(0,0,0,0.38)",
  pink: "#ff3b6b", yellow: "#ffd23f", green: "#7CFC9B",
  blue: "#4fc3f7", purple: "#b388ff", orange: "#ff8a3d",
  ink: "#0b0b0f", line: "#0b0b0f"
};

const TILE_W = 64, TILE_H = 32, WALL_H = 46, SPEED = 3.6; // tiles/sec

let initialized = false, running = false;
let stageEl, canvas, ctx, dpr = 1;
let cssW = 0, cssH = 0, originX = 0, originY = 0;

let room = null, objects = [], blocked = null;
let player = { x: 4, y: 3, fx: 4, fy: 3, facing: 1 };
let path = [], pendingInteract = null, movedOnce = false;
let hovered = null;
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

  const ro = new ResizeObserver(() => { resize(); requestRender(); });
  ro.observe(stageEl);

  on("time:tick", () => requestRender()); // day/night drifts with the clock
  resize();
}

function syncToState() {
  const s = getState();
  running = true;
  room = DATA.locations[s.location] || DATA.locations.apartment;
  objects = [...(room.objects || []), ...(room.exits || [])];

  const w = room.size?.w || 8, h = room.size?.h || 6;
  blocked = Array.from({ length: h }, () => Array(w).fill(false));
  for (const o of (room.objects || [])) {
    if (o.tile && o.interact !== "exit") blocked[o.tile.y][o.tile.x] = true;
  }

  // restore / default the player tile (kept on the save when possible)
  const start = s.player?.tile && isFree(s.player.tile.x, s.player.tile.y)
    ? s.player.tile : firstFreeTile();
  player.x = player.fx = start.x;
  player.y = player.fy = start.y;
  path = []; pendingInteract = null;
  resize();
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

// ---- input ----
function onClick(e) {
  const p = ptr(e);
  const t = toTile(p.x, p.y);
  if (!inBounds(t.x, t.y)) return;

  const obj = objectAt(t.x, t.y);
  if (obj) { approachAndInteract(obj); return; }
  if (isFree(t.x, t.y)) walkTo(t.x, t.y, null);
}
function onHover(e) {
  const p = ptr(e);
  const t = toTile(p.x, p.y);
  const obj = objectAt(t.x, t.y);
  const next = obj ? obj.id : null;
  if (next !== hovered) { hovered = next; canvas.style.cursor = obj ? "pointer" : "default"; requestRender(); }
}
function onKey(e) {
  if (document.getElementById("game").classList.contains("hidden")) return;
  if (!document.getElementById("phone").classList.contains("hidden")) return; // phone open: ignore
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
function objectAt(x, y) { return objects.find((o) => o.tile && o.tile.x === x && o.tile.y === y) || null; }

// ---- movement / pathfinding ----
function walkTo(tx, ty, interact) {
  const start = { x: Math.round(player.x), y: Math.round(player.y) };
  const p = bfs(start, { x: tx, y: ty });
  if (!p) return;
  path = p.slice(1); // drop current tile
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
  const cand = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
    .filter(([nx, ny]) => isFree(nx, ny))
    .map(([nx, ny]) => ({ x: nx, y: ny, d: Math.hypot(nx - player.x, ny - player.y) }))
    .sort((a, b) => a.d - b.d);
  return cand[0] || null;
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
      emit("instrument:equipped", { id: obj.instrumentId });
      toast("You pick up the " + (DATA.instruments[obj.instrumentId]?.name || "guitar") + ".", "good");
      break;
    }
    case "container":
      toast("Empty for now — storage opens up with the inventory (next build).", "info");
      break;
    case "daw":
      toast("The laptop's your studio. It boots up in a later build.", "info");
      break;
    case "exit":
      toast("The town's out there. That map opens up in a later build.", "info");
      break;
    default:
      toast(obj.name, "info");
  }
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
  if (hovered) drawTileHighlight();

  // depth-sorted entities (objects + player)
  const ents = objects.map((o) => ({ kind: "obj", o, depth: o.tile.x + o.tile.y + ((o.interact === "exit" || o.to) ? -0.5 : 0) }));
  ents.push({ kind: "player", depth: player.x + player.y + 0.4 });
  ents.sort((a, b) => a.depth - b.depth);
  for (const e of ents) e.kind === "player" ? drawPlayer() : drawObject(e.o);

  drawDayNight();
  if (hovered) drawLabel();
}

function drawFloor(w, h) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = toScreen(x, y);
    diamond(c.x, c.y, (x + y) % 2 ? C.floorA : C.floorB, C.floorEdge);
  }
}
function diamond(cx, cy, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - TILE_H / 2);
  ctx.lineTo(cx + TILE_W / 2, cy);
  ctx.lineTo(cx, cy + TILE_H / 2);
  ctx.lineTo(cx - TILE_W / 2, cy);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
}
function drawWalls(w, h) {
  const top = toScreen(0, 0); top.y -= TILE_H / 2;          // back corner (top vertex of 0,0)
  const right = toScreen(w - 1, 0); right.x += TILE_W / 2;  // right vertex of (w-1,0)
  const left = toScreen(0, h - 1); left.x -= TILE_W / 2;    // left vertex of (0,h-1)

  // right-hand wall
  wallQuad(top, right, C.wallR);
  // left-hand wall
  wallQuad(top, left, C.wallL);
  // top capping highlight
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
function drawTileHighlight() { /* reserved: object hover handled by label */ }

// ---- entities ----
function shadow(cx, cy, rw = TILE_W * 0.34, rh = TILE_H * 0.34) {
  ctx.beginPath(); ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.shadow; ctx.fill();
}
function drawObject(o) {
  const c = toScreen(o.tile.x, o.tile.y);
  const img = getImage(o.sprite);
  shadow(c.x, c.y);
  if (img && img._ok) {
    const dw = TILE_W * 1.1, dh = dw * (img.naturalHeight / img.naturalWidth || 1);
    ctx.drawImage(img, c.x - dw / 2, c.y - dh + TILE_H * 0.35, dw, dh);
  } else {
    drawProc(o, c.x, c.y);
  }
  if (hovered === o.id) outlineObject(o, c.x, c.y);
}
function drawProc(o, cx, cy) {
  switch (o.id) {
    case "bed":    cuboid(cx, cy, 26, 13, 14, "#3a2740", "#2a1c30", "#241828");
                   ctx.fillStyle = C.yellow; pad(cx - 10, cy - 14, 14, 7); break;
    case "fridge": cuboid(cx, cy, 14, 7, 40, "#cfd6dd", "#9aa3ad", "#7c858f");
                   ctx.fillStyle = "#5a626b"; ctx.fillRect(cx + 6, cy - 34, 2, 18); break;
    case "crate":  cuboid(cx, cy, 13, 7, 16, "#7a5a36", "#5e4528", "#4a361f");
                   ctx.strokeStyle = "#3a2a18"; ctx.lineWidth = 2;
                   ctx.beginPath(); ctx.moveTo(cx - 10, cy - 16); ctx.lineTo(cx + 8, cy - 4); ctx.stroke(); break;
    case "laptop": cuboid(cx, cy, 18, 9, 5, "#2b2533", "#211b29", "#1a1521");
                   ctx.fillStyle = "#1a1422"; ctx.fillRect(cx - 12, cy - 24, 24, 16);
                   ctx.fillStyle = C.green; ctx.fillRect(cx - 10, cy - 22, 20, 12); break;
    case "guitar": billboardGuitar(cx, cy); break;
    case "door":   doorway(cx, cy); break;
    default:       cuboid(cx, cy, 14, 7, 18, C.purple, "#6e54a0", "#523f78");
  }
}
function cuboid(cx, cy, fw, fh, hgt, top, lft, rgt) {
  // left face
  ctx.beginPath(); ctx.moveTo(cx - fw, cy); ctx.lineTo(cx, cy + fh);
  ctx.lineTo(cx, cy + fh - hgt); ctx.lineTo(cx - fw, cy - hgt); ctx.closePath();
  ctx.fillStyle = lft; ctx.fill();
  // right face
  ctx.beginPath(); ctx.moveTo(cx + fw, cy); ctx.lineTo(cx, cy + fh);
  ctx.lineTo(cx, cy + fh - hgt); ctx.lineTo(cx + fw, cy - hgt); ctx.closePath();
  ctx.fillStyle = rgt; ctx.fill();
  // top face
  ctx.beginPath(); ctx.moveTo(cx, cy - fh - hgt); ctx.lineTo(cx + fw, cy - hgt);
  ctx.lineTo(cx, cy + fh - hgt); ctx.lineTo(cx - fw, cy - hgt); ctx.closePath();
  ctx.fillStyle = top; ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke();
}
function pad(x, y, w, h) { ctx.fillRect(x, y, w, h); }
function billboardGuitar(cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.32);
  ctx.fillStyle = C.orange; ctx.strokeStyle = C.line; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, -8, 11, 15, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(0, -8, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#caa56b"; ctx.fillRect(-2.5, -40, 5, 26); ctx.strokeRect(-2.5, -40, 5, 26);
  ctx.restore();
}
function doorway(cx, cy) {
  ctx.fillStyle = "#15101c"; ctx.fillRect(cx - 14, cy - 44, 28, 46);
  ctx.strokeStyle = C.yellow; ctx.lineWidth = 2; ctx.strokeRect(cx - 14, cy - 44, 28, 46);
  ctx.fillStyle = C.yellow; ctx.beginPath(); ctx.arc(cx + 8, cy - 20, 1.8, 0, Math.PI * 2); ctx.fill();
}
function outlineObject(o, cx, cy) {
  ctx.strokeStyle = C.green; ctx.lineWidth = 2;
  ctx.strokeRect(cx - TILE_W * 0.5, cy - 48, TILE_W, 60);
}

function drawPlayer() {
  const c = toScreen(player.x, player.y);
  shadow(c.x, c.y, 13, 7);
  const img = getImage("assets/img/chars/player.png");
  if (img && img._ok) {
    const dw = 40, dh = dw * (img.naturalHeight / img.naturalWidth || 1.6);
    ctx.save();
    if (player.facing < 0) { ctx.translate(c.x, 0); ctx.scale(-1, 1); ctx.translate(-c.x, 0); }
    ctx.drawImage(img, c.x - dw / 2, c.y - dh + 6, dw, dh);
    ctx.restore();
    return;
  }
  // procedural billboard figure in avatar color
  const col = getState().player?.avatar?.color || C.pink;
  ctx.save();
  if (player.facing < 0) { ctx.translate(c.x, 0); ctx.scale(-1, 1); ctx.translate(-c.x, 0); }
  // legs
  ctx.fillStyle = "#1b1622"; ctx.fillRect(c.x - 5, c.y - 12, 4, 12); ctx.fillRect(c.x + 1, c.y - 12, 4, 12);
  // torso
  ctx.fillStyle = col; ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  roundRect(c.x - 7, c.y - 26, 14, 16, 3); ctx.fill(); ctx.stroke();
  // head
  ctx.fillStyle = "#e9c9a0"; ctx.beginPath(); ctx.arc(c.x, c.y - 31, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // hair tuft
  ctx.fillStyle = col; ctx.fillRect(c.x - 6, c.y - 37, 12, 4);
  // facing nub
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(c.x + 3, c.y - 31, 1.3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ---- day/night ----
function drawDayNight() {
  const hour = getState().time.hour;
  let col = null;
  if (hour >= 6 && hour < 9) col = "rgba(255,150,90,0.10)";      // dawn
  else if (hour >= 9 && hour < 17) col = null;                    // day (brightest)
  else if (hour >= 17 && hour < 20) col = "rgba(255,120,40,0.16)";// golden hour
  else if (hour >= 20 && hour < 23) col = "rgba(40,40,110,0.30)"; // evening
  else col = "rgba(15,18,55,0.46)";                               // deep night
  if (!col) return;
  ctx.fillStyle = col; ctx.fillRect(0, 0, cssW, cssH);
}

// ---- hover label ----
function drawLabel() {
  const o = objects.find((x) => x.id === hovered);
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
}

// ---- asset loading w/ fallback ----
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
