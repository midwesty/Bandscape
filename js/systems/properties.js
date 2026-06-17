// ============================================================
// properties.js — the Properties phone app (Step 19.4). A
// real-estate browser grouped by city. Cities you've unlocked
// show live listings (rent / buy / sell / buy-out / enter);
// cities you haven't visited show greyed, non-selectable cards.
// Dwellings are full home bases: sleep, store/arrange gear,
// record. Rent comes due on a cadence (Step 19.4b).
// Photos are placeholders for now (swap art via "photo").
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, propDefs, propDef, propertyStatus, setPropertyStatus, spendable, addStat, currentCity, cityDef, cityUnlocked } from "../engine/state.js";
import { saveToSlot } from "../engine/storage.js";
import { on } from "../engine/bus.js";
import { toast } from "../ui/toast.js";
import { travelTo } from "./stage.js";
import { closePhone } from "./phone.js";
import { currentDay } from "./calendar.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + Math.round(n || 0).toLocaleString();

const TIER_TINT = { crappy: "#6e5a3a", nice: "#3a5a6e", lux: "#5a3a6e" };

function rentPeriod() { return (DATA.config.dwellings && DATA.config.dwellings.rentPeriodDays) || 30; }
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }

let screenEl = null;

function badge(status) {
  if (status === "owned") return `<span class="prop-badge owned">Owned</span>`;
  if (status === "rented") return `<span class="prop-badge rented">Renting</span>`;
  return `<span class="prop-badge avail">For rent / sale</span>`;
}

function photoHTML(p) {
  if (p.photo) return `<div class="prop-photo"><img src="${esc(p.photo)}" alt=""/></div>`;
  const tint = TIER_TINT[p.tier] || "#4a4458";
  return `<div class="prop-photo placeholder" style="background:linear-gradient(135deg,${tint},#1a1620)">
    <span class="prop-photo-glyph">&#8962;</span><span class="prop-photo-tag">${esc(p.name)}</span></div>`;
}

function actionsHTML(p, status) {
  if (status === "owned") return `
    <button class="btn prop-act" data-act="enter" data-id="${p.id}">Enter</button>
    <button class="btn ghost prop-act" data-act="sell" data-id="${p.id}">Sell (+${money(p.sellValue)})</button>`;
  if (status === "rented") return `
    <button class="btn prop-act" data-act="enter" data-id="${p.id}">Enter</button>
    <button class="btn prop-act" data-act="buyout" data-id="${p.id}">Buy out (${money(p.buyPrice)})</button>
    <button class="btn ghost prop-act" data-act="endlease" data-id="${p.id}">End lease</button>`;
  return `
    <button class="btn prop-act" data-act="rent" data-id="${p.id}">Rent ${money(p.rentPrice)}/mo</button>
    <button class="btn prop-act" data-act="buy" data-id="${p.id}">Buy ${money(p.buyPrice)}</button>`;
}

function cardHTML(p, unlocked) {
  const status = propertyStatus(p.id);
  const amen = (p.amenities || []).map((a) => `<span class="prop-chip">${esc(a)}</span>`).join("");
  const acts = unlocked
    ? `<div class="prop-acts">${actionsHTML(p, status)}</div>`
    : `<div class="prop-locked-note">Locked &mdash; visit this city to rent or buy here.</div>`;
  return `<div class="prop-card ${unlocked ? "" : "locked"}">
    ${photoHTML(p)}
    <div class="prop-body">
      <div class="prop-head"><div><div class="prop-name">${esc(p.name)}</div><div class="prop-tag">${esc(p.tagline || "")}</div></div>${badge(status)}</div>
      <div class="prop-blurb">${esc(p.blurb || "")}</div>
      <div class="prop-chips">${amen}</div>
      ${acts}
    </div></div>`;
}

function citiesWithListings() {
  const seen = [];
  for (const p of propDefs()) { const c = p.city || "yourtown"; if (!seen.includes(c)) seen.push(c); }
  const cur = currentCity();
  return seen.sort((a, b) => (a === cur ? -1 : b === cur ? 1 : 0));
}

function citySection(city) {
  const listings = propDefs().filter((p) => (p.city || "yourtown") === city);
  if (!listings.length) return "";
  const unlocked = cityUnlocked(city);
  const lock = unlocked ? "" : `<span class="prop-lock">&#128274; visit to unlock</span>`;
  const cards = listings.map((p) => cardHTML(p, unlocked)).join("");
  return `<div class="prop-city ${unlocked ? "" : "is-locked"}">
    <div class="prop-city-head">${esc((cityDef(city) && cityDef(city).name) || city)}${lock}</div>${cards}</div>`;
}

export function renderPropertiesApp(container) {
  screenEl = container;
  const sections = citiesWithListings().map(citySection).join("");
  screenEl.innerHTML = `<h2 class="app-title">Properties</h2>
    <div class="prop-sub">${money(spendable())} to spend</div>
    <div class="prop-list">${sections || `<p class="muted" style="padding:16px">No listings yet.</p>`}</div>`;
  bind();
}

function bind() {
  screenEl.querySelectorAll(".prop-act").forEach((b) => b.addEventListener("click", () => {
    const p = propDef(b.dataset.id); if (!p) return;
    const act = b.dataset.act;
    if (act === "enter") { closePhone(); travelTo(p.location, null); return; }
    if (act === "buy" || act === "buyout") {
      if (spendable() < p.buyPrice) { toast("Not enough cash to buy that.", "warn"); return; }
      addStat("money", -p.buyPrice); setPropertyStatus(p.id, "owned");
      toast(`You bought ${p.name}!`, "good");
    } else if (act === "rent") {
      if (spendable() < p.rentPrice) { toast("Can't cover the first month's rent.", "warn"); return; }
      addStat("money", -p.rentPrice); setPropertyStatus(p.id, "rented", { nextRentDay: currentDay() + rentPeriod(), behind: false });
      toast(`You signed a lease on ${p.name}.`, "good");
    } else if (act === "sell") {
      addStat("money", p.sellValue); setPropertyStatus(p.id, "none");
      toast(`Sold ${p.name} for ${money(p.sellValue)}.`, "good");
    } else if (act === "endlease") {
      setPropertyStatus(p.id, "none");
      toast(`You gave up the lease on ${p.name}.`, "info");
    }
    persist();
    renderPropertiesApp(screenEl);
  }));
}

// ---- recurring rent (Step 19.4b) ----
export function initRentSchedule() {
  on("day:advanced", () => chargeDueRent());
}
function chargeDueRent() {
  const s = getState();
  const day = currentDay();
  let changed = false;
  for (const p of propDefs()) {
    const rec = s.properties && s.properties[p.id];
    if (!rec || rec.status !== "rented") continue;
    if (rec.nextRentDay == null) { rec.nextRentDay = day + rentPeriod(); changed = true; continue; }
    if (day >= rec.nextRentDay) {
      if ((s.stats.money || 0) >= p.rentPrice) {
        addStat("money", -p.rentPrice);
        rec.nextRentDay = day + rentPeriod();
        rec.behind = false;
        toast(`Rent due: \u2212${money(p.rentPrice)} for ${p.name}.`, "info");
      } else {
        rec.behind = true;
        toast(`You're short on rent for ${p.name}. Pay up soon.`, "warn");
      }
      changed = true;
    }
  }
  if (changed) persist();
}
