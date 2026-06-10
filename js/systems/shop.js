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
import { getState, addStat, activeBand } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { giveItem } from "./inventory.js";
import { advanceMinutes } from "./time.js";
import { playCode, ensureAudio } from "./audio.js";
import { deviceList, currentDevice, deviceIndex, ownDevice } from "./gear.js";
import { openPerform, venueById, venueEligible, venueReqText, venueStanding } from "./shows.js";
import { openScheduler, findReady } from "./calendar.js";

let overlay = null, currentShop = null, currentVenue = null, lastRenderKey = null;

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
  return `
    ${isDebtShop ? `<div class="shop-debt">Pawn debt: $${debt}</div><div class="shop-pay">${payBtns}</div>` : `<p class="shop-note">Rocktroit's finest secondhand gear emporium. No tab — cash on the barrel.</p>`}
    ${gearRows}
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
  const price = priceOf(id, DATA.shops.grocery.markup || 1);
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

// ---- busking ----
export function busk() {
  const s = getState();
  const instId = s.equipped?.instrumentId;
  if (!instId) { toast("You need an instrument to busk. Grab one from your place.", "warn"); return; }
  if (DATA.instruments[instId]?.kind === "audio") { toast("Singing a cappella on the corner? Maybe grab an instrument.", "warn"); return; }
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
