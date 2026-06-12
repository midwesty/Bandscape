// ============================================================
// properties.js — the Properties phone app (Step 19.4). A
// real-estate browser: tappable dwelling listings for the city
// you're standing in, with rent / buy / sell / buy-out and an
// Enter action for places you control. Full home bases: sleep,
// arrange & store gear, record. Photos are placeholders for now
// (swap in art later via each listing's "photo" path).
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, propDefs, propDef, propertyStatus, setPropertyStatus, spendable, addStat } from "../engine/state.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { travelTo } from "./stage.js";
import { closePhone } from "./phone.js";
import { currentDay } from "./calendar.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + Math.round(n || 0).toLocaleString();

const LOC_CITY = { apartment: "yourtown", loft: "yourtown", town: "yourtown", venue: "yourtown", thedive: "yourtown", rocktroit: "rocktroit", rocktroit_bar: "rocktroit", arcade: "rocktroit" };
const CITY_NAME = { yourtown: "Your Town", rocktroit: "Rocktroit" };
const TIER_TINT = { crappy: "#6e5a3a", nice: "#3a5a6e", lux: "#5a3a6e" };

function rentPeriod() { return (DATA.config.dwellings && DATA.config.dwellings.rentPeriodDays) || 30; }
function currentCity() { return LOC_CITY[getState().location] || "yourtown"; }
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
    <span class="prop-photo-glyph">\u2302</span><span class="prop-photo-tag">${esc(p.name)}</span></div>`;
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

function cardHTML(p) {
  const status = propertyStatus(p.id);
  const amen = (p.amenities || []).map((a) => `<span class="prop-chip">${esc(a)}</span>`).join("");
  return `<div class="prop-card">
    ${photoHTML(p)}
    <div class="prop-body">
      <div class="prop-head"><div><div class="prop-name">${esc(p.name)}</div><div class="prop-tag">${esc(p.tagline || "")}</div></div>${badge(status)}</div>
      <div class="prop-blurb">${esc(p.blurb || "")}</div>
      <div class="prop-chips">${amen}</div>
      <div class="prop-acts">${actionsHTML(p, status)}</div>
    </div></div>`;
}

export function renderPropertiesApp(container) {
  screenEl = container;
  const city = currentCity();
  const listings = propDefs().filter((p) => (p.city || "yourtown") === city);
  const cards = listings.length ? listings.map(cardHTML).join("") : `<p class="muted" style="padding:16px">No listings in ${esc(CITY_NAME[city] || city)} yet.</p>`;
  screenEl.innerHTML = `<h2 class="app-title">Properties</h2>
    <div class="prop-sub">${esc(CITY_NAME[city] || city)} \u00b7 ${money(spendable())} to spend</div>
    <div class="prop-list">${cards}</div>`;
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
      addStat("money", -p.rentPrice); setPropertyStatus(p.id, "rented", { nextRentDay: currentDay() + rentPeriod() });
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
