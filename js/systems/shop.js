// ============================================================
// shop.js — the town economy: shops + busking.
//
// Pawn shop: pay down your $350 debt and sell gear/items.
// Corner store: buy food, drink, and vices with cash.
// The Dive (venue): teaser hub until shows arrive (Step 8).
// Busking: play on the street for a few bucks — your starter
// income, gated by energy and a chunk of in-game time.
//
// Shop stock + rates live in data/shops.json; busk tuning in
// config.economy.busk. Emits shop:opened, money:earned,
// debt:paid, debt:cleared.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, activeBand, controlledProperties, propDef } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { giveItem, takeItem, countItem } from "./inventory.js";
import { advanceMinutes } from "./time.js";
import { playCode, ensureAudio } from "./audio.js";
import { deviceList, currentDevice, deviceIndex, ownDevice, instrumentTiers, ownedInstrumentTier, ownInstrumentTier, parseInstrItem, instrItemId } from "./gear.js";
import { openPerform, venueById, venueEligible, venueReqText, venueStanding } from "./shows.js";
import { openScheduler, findReady } from "./calendar.js";

let overlay = null, currentShop = null, currentVenue = null, lastRenderKey = null;
let storeView = { stage: "cats", type: null, tierId: null };

const money = () => getState().stats.money || 0;
const item = (id) => DATA.items.items[id] || null;
const priceOf = (id, markup = 1) => Math.max(1, Math.ceil((item(id)?.value || 1) * markup));
const sellOf = (id, rate) => Math.max(1, Math.floor((item(id)?.value || 1) * rate));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---- open / close ----
export function openShop(shopId) {
  overlay = overlay || document.getElementById("shop");
  if (!overlay) return;
  currentShop = shopId;
  if (shopId === "musicstore") storeView = { stage: "cats", type: null, tierId: null };
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  render();
  emit("shop:opened", { shop: shopId });
}
export function closeShop() {
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}

function render() {
  const renderKey = currentShop === "venuebook" ? "venuebook:" + currentVenue : currentShop;
  const sc = overlay.querySelector(".shop-modal");
  const prevTop = (renderKey === lastRenderKey && sc) ? sc.scrollTop : 0;  // keep scroll on same screen, reset when shop changes
  const head = (title) => `
    <div class="shop-head">
      <span class="shop-title">${esc(title)}</span>
      <div><span class="shop-cash">$${money()}</span> <button class="phone-nav" id="shop-close">✕</button></div>
    </div>`;
  let body = "", title = "";
  if (currentShop === "pawn" || currentShop === "pawn2") { body = pawnBody(); title = currentShop === "pawn" ? DATA.shops.pawn.name : "Rust Belt Pawn"; }
  else if (currentShop === "grocery") { body = groceryBody(); title = DATA.shops.grocery.name; }
  else if (currentShop === "musicstore") { body = storeBody(); title = "Sound City — Music & Gear"; }
  else if (currentShop === "venuebook") { body = venuePanelBody(); title = venueById(currentVenue)?.name || "Venue"; }
  else { body = venueBody(); title = DATA.shops.venue.name; }
  overlay.innerHTML = `<div class="shop-modal">${head(title)}<div class="shop-body">${body}</div></div>`;
  lastRenderKey = renderKey;
  const nm = overlay.querySelector(".shop-modal"); if (nm) nm.scrollTop = prevTop;
  overlay.querySelector("#shop-close").addEventListener("click", closeShop);
  bind();
}

// ---- pawn ----
function pawnBody() {
  const isDebtShop = currentShop === "pawn";
  const debt = isDebtShop ? (getState().debt.pawn || 0) : 0;
  const opts = DATA.shops.pawn.payOptions || [20, 50];
  const rate = DATA.shops.pawn.sellRate || 0.5;
  const inv = getState().inventory || [];
  const payBtns = debt > 0
    ? opts.map((a) => `<button class="btn shop-btn" data-pay="${a}">Pay $${a}</button>`).join("") + `<button class="btn shop-btn" data-pay="all">Pay all</button>`
    : `<span class="shop-note">Debt cleared. You're free.</span>`;
  const sellRows = inv.length
    ? inv.map((st, i) => {
        const it = item(st.item); if (!it) return "";
        return `<div class="shop-row"><div><strong>${esc(it.name)}</strong> <small>x${st.qty}</small></div>
          <div><span class="shop-price">+$${sellOf(st.item, rate)}</span> <button class="btn shop-btn" data-sell="${i}">Sell 1</button></div></div>`;
      }).join("")
    : `<p class="shop-note">Your pockets are empty — nothing to hock.</p>`;
  const cur = currentDevice(); const curIdx = deviceIndex(cur.id);
  const upgrades = deviceList().filter((d, i) => i > curIdx && d.price > 0);
  const gearRows = `<div class="shop-section">RECORDING GEAR</div>
    <div class="shop-row"><div><strong>Current: ${esc(cur.name)}</strong><small>${cur.tracks} tracks · fidelity ${Math.round((cur.fidelity || 0) * 100)}</small></div></div>
    ${upgrades.length ? upgrades.map((d) => `<div class="shop-row"><div><strong>${esc(d.name)}</strong><small>${d.tracks} tracks · ${esc(d.desc)}</small></div><div><span class="shop-price">$${d.price}</span> <button class="btn shop-btn" data-buy-device="${d.id}">Buy</button></div></div>`).join("") : `<p class="shop-note">Top of the line — nothing better in stock.</p>`}`;
  const instrSell = (getState().inventory || []).filter((st) => parseInstrItem(st.item));
  const instrSellRows = instrSell.length ? `<div class="shop-section">SELL YOUR INSTRUMENTS (${Math.round(rate * 100)}% value)</div>` + instrSell.map((st) => {
    const ip = parseInstrItem(st.item); const t = instrumentTiers(ip.type).find((x) => x.id === ip.tier);
    const payout = Math.round((t ? t.price : 0) * rate);
    return `<div class="shop-row"><div><strong>${esc(t ? t.name : st.item)}</strong> <small>x${st.qty}</small></div><div><span class="shop-price">+$${money(payout)}</span> <button class="btn shop-btn" data-sell-instr="${st.item}">Sell 1</button></div></div>`;
  }).join("") : "";
  const stock = (DATA.shops[currentShop] && DATA.shops[currentShop].stock) || [];
  const mk = (DATA.shops[currentShop] && DATA.shops[currentShop].markup) || 1;
  const supplyRows = stock.length ? `<div class="shop-section">SUPPLIES</div>` + stock.map((id) => `<div class="shop-row"><div><strong>${esc(item(id)?.name || id)}</strong><small>${esc(item(id)?.desc || "")}</small></div><div><span class="shop-price">$${priceOf(id, mk)}</span> <button class="btn shop-btn" data-buy="${id}">Buy</button></div></div>`).join("") : "";
  return `
    ${isDebtShop ? `<div class="shop-debt">Pawn debt: $${debt}</div><div class="shop-pay">${payBtns}</div>` : `<p class="shop-note">Rocktroit\'s finest secondhand gear emporium. No tab — cash on the barrel.</p>`}
    ${supplyRows}
    ${gearRows}
    ${instrSellRows}
    <div class="shop-section">SELL FROM POCKETS (½ value)</div>
    ${sellRows}
    <p class="shop-note" style="margin-top:12px">${isDebtShop ? "The clerk doesn't make eye contact. Pay it down and your gear's safe." : "The clerk's seen better decades. So has the inventory."}</p>`;
}

// ---- grocery ----
function groceryBody() {
  const g = DATA.shops.grocery; const markup = g.markup || 1;
  const rows = (g.stock || []).map((id) => {
    const it = item(id); if (!it) return "";
    return `<div class="shop-row"><div><strong>${esc(it.name)}</strong><small>${esc(it.desc || it.category)}</small></div>
      <div><span class="shop-price">$${priceOf(id, markup)}</span> <button class="btn shop-btn" data-buy="${id}">Buy</button></div></div>`;
  }).join("");
  return `<div class="shop-section">FOR SALE</div>${rows}<p class="shop-note" style="margin-top:12px">Cash only. The card reader's "broken" again.</p>`;
}

// ---- venue ----
function venueBody() {
  const s = getState();
  return `
    <p class="shop-note" style="font-size:13px;line-height:1.6">${esc(DATA.shops.venue.teaser)}</p>
    <div class="shop-section">YOUR STANDING</div>
    <div class="shop-row"><div>Fame</div><div class="shop-price">${s.stats.fame || 0}</div></div>
    <div class="shop-row"><div>Fans</div><div class="shop-price">${s.stats.fans || 0}</div></div>
    <p class="shop-note" style="margin-top:12px">Booking shows opens up once you've got a band and something to play.</p>`;
}

export function openVenue(venueId) {
  overlay = overlay || document.getElementById("shop"); if (!overlay) return;
  currentShop = "venuebook"; currentVenue = venueId;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  render(); emit("shop:opened", { shop: "venue:" + venueId });
}
function venuePanelBody() {
  const id = currentVenue; const v = venueById(id); const elig = venueEligible(id);
  const ready = findReady("show", null, id);
  const pk = activeBand() && activeBand().pressKit;
  const size = v && v.drawMult >= 3 ? "a serious room" : v && v.drawMult >= 2 ? "a real stage" : "a cozy stage";
  const reqLine = `<p class="shop-note" style="color:${elig ? "var(--green)" : "var(--pink)"}">${esc(venueReqText(id))}</p>`;
  const playBtn = ready ? `<button class="btn shop-btn" id="venue-play">▶ Play tonight's show here</button>` : `<p class="shop-note">No show booked here right now.</p>`;
  let bookBtn;
  if (!elig) bookBtn = `<p class="shop-note">Locked. Build up your standing and come back.</p>`;
  else if (!pk) bookBtn = `<p class="shop-note">Assemble a press kit first (BAND app), then book.</p>`;
  else bookBtn = `<button class="btn shop-btn" id="venue-book">Book a Show Here</button>`;
  const st = venueStanding(id);
  const dots = "●".repeat(Math.min(5, Math.round(st.rep / 20))) + "○".repeat(Math.max(0, 5 - Math.round(st.rep / 20)));
  const standLine = `<p class="shop-note">Your standing: <span style="color:var(--yellow)">${dots}</span> ${esc(st.name)}${st.payBonus > 0 ? ` · +${st.payBonus}% pay` : ""}</p>`;
  return `<p class="shop-note" style="font-size:13px;line-height:1.6">${esc(v && v.name)} — ${size}.</p>${reqLine}${standLine}
    <div class="shop-section">TONIGHT</div>${playBtn}
    <div class="shop-section">BOOKING</div>${bookBtn}`;
}
function bind() {
  const vp = overlay.querySelector("#venue-play"); if (vp) vp.addEventListener("click", () => { const id = currentVenue; closeShop(); openPerform(id); });
  const vb = overlay.querySelector("#venue-book"); if (vb) vb.addEventListener("click", () => { const id = currentVenue; closeShop(); openScheduler("show", id); });
  overlay.querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => payDebt(b.dataset.pay)));
  overlay.querySelectorAll("[data-sell]").forEach((b) => b.addEventListener("click", () => sellItem(parseInt(b.dataset.sell, 10))));
  overlay.querySelectorAll("[data-buy]").forEach((b) => b.addEventListener("click", () => buyItem(b.dataset.buy)));
  overlay.querySelectorAll("[data-buy-device]").forEach((b) => b.addEventListener("click", () => buyDevice(b.dataset.buyDevice)));
  overlay.querySelectorAll("[data-store-cat]").forEach((b) => b.addEventListener("click", () => { storeView = { stage: "tiers", type: b.dataset.storeCat, tierId: null }; render(); }));
  overlay.querySelectorAll("[data-store-back]").forEach((b) => b.addEventListener("click", () => { storeView = { stage: b.dataset.storeBack, type: storeView.type, tierId: storeView.tierId }; render(); }));
  overlay.querySelectorAll("[data-store-carry]").forEach((b) => b.addEventListener("click", () => buyAndCarry(b.dataset.storeCarry)));
  overlay.querySelectorAll("[data-store-send]").forEach((b) => b.addEventListener("click", () => { const parts = b.dataset.storeSend.split(":"); storeView = { stage: "send", type: parts[0], tierId: parts[1] }; render(); }));
  overlay.querySelectorAll("[data-store-place]").forEach((b) => b.addEventListener("click", () => buyAndSend(b.dataset.storePlace)));
  overlay.querySelectorAll("[data-sell-instr]").forEach((b) => b.addEventListener("click", () => sellInstrument(b.dataset.sellInstr)));
}

// ---- transactions ----
function payDebt(which) {
  const s = getState(); const debt = s.debt.pawn || 0;
  if (debt <= 0) return;
  let amount = which === "all" ? Math.min(money(), debt) : Math.min(parseInt(which, 10), money(), debt);
  if (amount <= 0) { toast("Not enough cash for that.", "warn"); return; }
  addStat("money", -amount);
  s.debt.pawn = Math.max(0, debt - amount);
  persist();
  emit("debt:paid", { amount, remaining: s.debt.pawn });
  emit("renderAll");
  if (s.debt.pawn <= 0) { emit("debt:cleared", {}); toast("DEBT CLEARED. The clerk almost smiles.", "good"); }
  else toast(`Paid $${amount}. $${s.debt.pawn} to go.`, "good");
  render();
}
function sellItem(idx) {
  const s = getState(); const st = (s.inventory || [])[idx]; if (!st) return;
  const gain = sellOf(st.item, DATA.shops.pawn.sellRate || 0.5);
  st.qty -= 1; if (st.qty <= 0) s.inventory.splice(idx, 1);
  addStat("money", gain);
  persist(); emit("renderAll");
  toast(`Sold for $${gain}.`, "good");
  render();
}
function buyItem(id) {
  const price = priceOf(id, (DATA.shops[currentShop] && DATA.shops[currentShop].markup) || DATA.shops.grocery.markup || 1);
  if (money() < price) { toast("You can't afford that.", "warn"); return; }
  const leftover = giveItem("inventory", id, 1);
  if (leftover > 0) { toast("Your pockets are full.", "warn"); return; }
  addStat("money", -price);
  persist(); emit("renderAll");
  toast(`Bought ${item(id)?.name || id}.`, "good");
  render();
}
function buyDevice(id) {
  const d = deviceList().find((x) => x.id === id); if (!d) return;
  if (money() < d.price) { toast("Can't afford that yet.", "warn"); return; }
  addStat("money", -d.price); ownDevice(id);
  persist(); emit("renderAll");
  toast(`Upgraded to ${d.name}! More tracks, better fidelity.`, "good");
  render();
}
function buyInstrument(spec) {
  const [type, tierId] = String(spec).split(":");
  const t = instrumentTiers(type).find((x) => x.id === tierId); if (!t) return;
  if (money() < t.price) { toast("Can't afford that yet.", "warn"); return; }
  addStat("money", -t.price); ownInstrumentTier(type, tierId);
  persist(); emit("renderAll");
  toast(`Bought the ${t.name}! Your recordings on it just got better.`, "good");
  render();
}

// ---- busking ----
export function busk() {
  const s = getState();
  // Busk with any instrument you have on hand: carried in your pockets, placed in this room, or equipped.
  const avail = new Set();
  if (s.equipped && s.equipped.instrumentId) avail.add(s.equipped.instrumentId);
  for (const st of (s.inventory || [])) { const ip = parseInstrItem(st.item); if (ip) avail.add(ip.type); }
  const here = (s.placedObjects && s.placedObjects[s.location]) || (DATA.locations[s.location] && DATA.locations[s.location].objects) || [];
  for (const o of here) if (o && o.instrumentId) avail.add(o.instrumentId);
  const melodic = [...avail].filter((id) => DATA.instruments[id] && DATA.instruments[id].kind !== "audio");
  if (!melodic.length) {
    toast(avail.size ? "Singing a cappella on the corner? Grab a melodic instrument." : "You need an instrument to busk. Carry one in your pocket.", "warn");
    return;
  }
  const instId = melodic[0];
  const cfg = (DATA.config.economy && DATA.config.economy.busk) || {};
  const cost = cfg.energyCost ?? 12;
  if ((s.stats.energy ?? 0) < cost) { toast("You're too wiped to busk. Get some rest.", "warn"); return; }

  try { ensureAudio(); buskRiff(instId); } catch {}
  const fame = s.stats.fame || 0;
  const tip = randInt(cfg.tipMin ?? 3, cfg.tipMax ?? 14) + Math.floor(fame * 0.5);
  addStat("money", tip);
  addStat("energy", -cost);
  addStat("mood", cfg.moodGain ?? 3);
  if (Math.random() * 100 < (cfg.fameChancePct ?? 35)) addStat("fame", 1);
  advanceMinutes(cfg.minutes ?? 90);
  persist();
  emit("money:earned", { amount: tip, source: "busk" });
  emit("renderAll");
  toast(`You busk for a while… tips: $${tip}.`, "good");
}
function buskRiff(id) {
  const inst = DATA.instruments[id]; if (!inst) return;
  if (inst.kind === "percussion") ["kick", "hihat", "snare", "hihat"].forEach((p, i) => playCode(id, p, i * 0.16));
  else ["note_C", "note_E", "note_G", "note_C"].forEach((n, i) => playCode(id, n, i * 0.16, { octave: i === 3 ? 5 : 4 }));
}

// ============================================================
// Music store (Step 19.5a) — "Sound City". Browse instruments by
// category, see every tier, then buy to CARRY or SEND to a place
// you control. Sending where you already own that type prompts
// trade-in (replace) vs. add. All tiers always available.
// ============================================================

function storeSprite(type) {
  for (const loc in DATA.locations) {
    for (const o of ((DATA.locations[loc] && DATA.locations[loc].objects) || [])) {
      if (o.instrumentId === type && o.sprite) return o.sprite;
    }
  }
  return null;
}
function freeTile(loc, arr) {
  const size = (DATA.locations[loc] && DATA.locations[loc].size) || { w: 8, h: 6 };
  const occ = new Set(arr.filter((o) => o && o.tile).map((o) => o.tile.x + "," + o.tile.y));
  for (let y = 1; y < size.h - 1; y++) for (let x = 1; x < size.w - 1; x++) if (!occ.has(x + "," + y)) return { x, y };
  return { x: 1, y: 1 };
}
function placedAt(loc) {
  const s = getState();
  return (s.placedObjects && s.placedObjects[loc]) || (DATA.locations[loc] && DATA.locations[loc].objects) || [];
}

function storeBody() {
  if (storeView.stage === "tiers") return storeTiers(storeView.type);
  if (storeView.stage === "send") return storeSend(storeView.type, storeView.tierId);
  return storeCats();
}

function storeCats() {
  const rows = Object.keys(DATA.instruments || {}).map((type) => {
    const inst = DATA.instruments[type]; const tiers = instrumentTiers(type);
    const from = Math.min.apply(null, tiers.map((x) => x.price));
    return `<button class="shop-row store-cat" data-store-cat="${type}">
      <div><strong>${esc(inst.name)}</strong><small>${tiers.length} models \u00b7 from $${money(from)}</small></div>
      <span class="store-chev">\u203a</span></button>`;
  }).join("");
  return `<p class="shop-note">Walk the floor. Pick a category to see every model \u2014 buy to carry, or have it delivered to a place you own.</p>${rows}`;
}

function storeTiers(type) {
  const inst = DATA.instruments[type];
  const rows = instrumentTiers(type).map((t) => `<div class="shop-row">
    <div><strong>${esc(t.name)}</strong><small>quality ${Math.round(t.quality * 100)} \u00b7 $${money(t.price)}</small></div>
    <div class="store-acts">
      <button class="btn shop-btn" data-store-carry="${type}:${t.id}">Carry</button>
      <button class="btn shop-btn ghost" data-store-send="${type}:${t.id}">Send\u2026</button>
    </div></div>`).join("");
  return `<button class="shop-back" data-store-back="cats">\u2039 All categories</button>
    <div class="shop-section">${esc(inst.name).toUpperCase()}</div>${rows}`;
}

function storeSend(type, tierId) {
  const t = instrumentTiers(type).find((x) => x.id === tierId);
  const props = controlledProperties();
  if (!props.length) {
    return `<button class="shop-back" data-store-back="tiers">\u2039 Back</button>
      <p class="shop-note">You don't have a place to send it to yet. Rent or buy somewhere in the Properties app first \u2014 or just Carry it.</p>`;
  }
  const rows = props.map((p) => {
    const has = placedAt(p.location).some((o) => o && o.instrumentId === type);
    const acts = has
      ? `<button class="btn shop-btn" data-store-place="${type}:${tierId}:${p.id}:replace">Trade in</button>
         <button class="btn shop-btn ghost" data-store-place="${type}:${tierId}:${p.id}:add">Add</button>`
      : `<button class="btn shop-btn" data-store-place="${type}:${tierId}:${p.id}:add">Deliver</button>`;
    return `<div class="shop-row"><div><strong>${esc(p.name)}</strong><small>${has ? "already has a " + esc(DATA.instruments[type].name) : "no " + esc(DATA.instruments[type].name) + " here yet"}</small></div><div class="store-acts">${acts}</div></div>`;
  }).join("");
  return `<button class="shop-back" data-store-back="tiers">\u2039 Back</button>
    <div class="shop-section">SEND \u2014 ${esc(t.name).toUpperCase()}</div>${rows}`;
}

function buyAndCarry(spec) {
  const [type, tierId] = String(spec).split(":");
  const t = instrumentTiers(type).find((x) => x.id === tierId); if (!t) return;
  if (money() < t.price) { toast("Can't afford that yet.", "warn"); return; }
  const left = giveItem("inventory", instrItemId(type, tierId), 1);
  if (left > 0) { toast("Your pockets are full \u2014 free up a slot or have it delivered.", "warn"); return; }
  addStat("money", -t.price);
  persist(); emit("renderAll");
  toast(`Bought the ${t.name}. It's in your pockets.`, "good");
  render();
}

function buyAndSend(spec) {
  const [type, tierId, propId, mode] = String(spec).split(":");
  const t = instrumentTiers(type).find((x) => x.id === tierId); if (!t) return;
  const p = propDef(propId); if (!p) return;
  if (money() < t.price) { toast("Can't afford that yet.", "warn"); return; }
  const s = getState();
  s.placedObjects = s.placedObjects || {};
  const loc = p.location;
  if (!s.placedObjects[loc]) s.placedObjects[loc] = JSON.parse(JSON.stringify((DATA.locations[loc] && DATA.locations[loc].objects) || []));
  const arr = s.placedObjects[loc];
  addStat("money", -t.price);
  let creditMsg = "";
  if (mode === "replace") {
    const idx = arr.findIndex((o) => o && o.instrumentId === type);
    if (idx >= 0) {
      const old = arr[idx];
      const oldT = instrumentTiers(type).find((x) => x.id === (old.tier || "starter"));
      const rate = (DATA.config.gear && DATA.config.gear.tradeInRate) || 0.4;
      const credit = Math.round((oldT ? oldT.price : 0) * rate);
      arr.splice(idx, 1);
      if (credit > 0) { addStat("money", credit); creditMsg = ` Traded in your old ${old.name || DATA.instruments[type].name} for $${money(credit)}.`; }
    }
  }
  const sprite = storeSprite(type);
  const obj = { id: "instr_" + Math.random().toString(36).slice(2, 8), instrumentId: type, tier: tierId, name: t.name, interact: "equip", tile: freeTile(loc, arr) };
  if (sprite) obj.sprite = sprite;
  arr.push(obj);
  persist(); emit("renderAll");
  toast(`${t.name} delivered to ${p.name}.${creditMsg}`, "good");
  storeView = { stage: "tiers", type, tierId: null };
  render();
}

function sellInstrument(itemId) {
  const ip = parseInstrItem(itemId); if (!ip) return;
  if (countItem(itemId) <= 0) return;
  const t = instrumentTiers(ip.type).find((x) => x.id === ip.tier);
  const rate = (DATA.shops[currentShop] && DATA.shops[currentShop].sellRate) || 0.5;
  const payout = Math.round((t ? t.price : 0) * rate);
  takeItem(itemId, 1);
  addStat("money", payout);
  persist(); emit("renderAll");
  toast(`Sold your ${t ? t.name : "instrument"} for $${money(payout)}.`, "good");
  render();
}
