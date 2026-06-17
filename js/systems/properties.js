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
import { getState, propDefs, propDef, propertyStatus, setPropertyStatus, spendable, addStat, currentCity, cityDef, cityUnlocked, activeBand, vehicleBand, bandById } from "../engine/state.js";
import { saveToSlot } from "../engine/storage.js";
import { on } from "../engine/bus.js";
import { toast } from "../ui/toast.js";
import { travelTo } from "./stage.js";
import { closePhone } from "./phone.js";
import { advanceMinutes } from "./time.js";
import { currentDay, nextCommitment } from "./calendar.js";
import { payForBand } from "./bank.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let propTab = "properties";
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
  const listings = propDefs().filter((p) => !p.vehicle && (p.city || "yourtown") === city);
  if (!listings.length) return "";
  const unlocked = cityUnlocked(city);
  const lock = unlocked ? "" : `<span class="prop-lock">&#128274; visit to unlock</span>`;
  const cards = listings.map((p) => cardHTML(p, unlocked)).join("");
  return `<div class="prop-city ${unlocked ? "" : "is-locked"}">
    <div class="prop-city-head">${esc((cityDef(city) && cityDef(city).name) || city)}${lock}</div>${cards}</div>`;
}

function vehicleActions(p, status) {
  const m = (n) => money(n);
  if (status === "owned") return `<button class="btn prop-act" data-act="enter" data-id="${p.id}">Enter</button><button class="btn prop-act" data-act="driveshow" data-id="${p.id}">Drive to next show \u25B8</button><button class="btn ghost prop-act" data-act="sell" data-id="${p.id}">Sell (+${m(p.sellValue)})</button>`;
  if (status === "rented") return `<button class="btn prop-act" data-act="enter" data-id="${p.id}">Enter</button><button class="btn prop-act" data-act="driveshow" data-id="${p.id}">Drive to next show \u25B8</button><button class="btn prop-act" data-act="buyout" data-id="${p.id}">Buy out (${m(p.buyPrice)})</button><button class="btn ghost prop-act" data-act="endlease" data-id="${p.id}">End lease</button>`;
  const rent = p.rentPrice ? `<button class="btn prop-act" data-act="rent" data-id="${p.id}">Rent ${m(p.rentPrice)}/mo</button>` : "";
  return `${rent}<button class="btn prop-act" data-act="buy" data-id="${p.id}">Buy ${m(p.buyPrice)}</button>`;
}
function vehiclesSection() {
  const vs = propDefs().filter((p) => p.vehicle);
  if (!vs.length) return "";
  const pbAll = getState().bands.filter((x) => x.playerIn);
  const cards = vs.map((p) => {
    const status = propertyStatus(p.id);
    const controlled = status === "owned" || status === "rented";
    const am = (p.amenities || []).map((a) => `<span class="prop-am">${esc(a)}</span>`).join("");
    const tag = status === "owned" ? " · owned" : status === "rented" ? " · leased" : "";
    const ob = controlled ? bandById(vehicleBand(p.id)) : null;
    const assign = controlled ? `<div class="prop-assign">Assigned to <strong>${esc((ob && ob.name) || "your band")}</strong></div>` : "";
    const reassign = (controlled && pbAll.length > 1) ? `<button class="btn ghost prop-act" data-act="reassign" data-id="${p.id}">Reassign band ▸</button>` : "";
    return `<div class="prop-card"><div class="prop-card-head">${esc(p.name)}<span class="muted">${esc(p.tagline || "")}${tag}</span></div>${assign}<div class="prop-ams">${am}</div><div class="prop-acts">${vehicleActions(p, status)}${reassign}</div></div>`;
  }).join("");
  return `<div class="prop-city"><div class="prop-city-head">Vehicles</div>${cards}</div>`;
}
function driveToShow() {
  const cmt = nextCommitment("show", null);
  if (!cmt) { toast("No shows booked - book one first in the BAND app.", "info"); return; }
  const v = (DATA.venues && DATA.venues.venues && DATA.venues.venues[cmt.venue]) || null;
  const cd = v && v.town && cityDef(v.town);
  const es = cd && cd.entryScene;
  if (!es) { toast("Can't find the road to that venue yet.", "warn"); return; }
  const mins = (DATA.config.travel && DATA.config.travel.vehicleDriveMinutes) || 45;
  closePhone();
  travelTo(es.scene, es.spawn);
  advanceMinutes(mins);
  toast(`On the road to ${cd.name} \u2014 ${mins} min.`, "good");
}

export function renderPropertiesApp(container) {
  screenEl = container;
  const tabs = `<div class="prop-tabs"><button class="prop-tab ${propTab === "vehicles" ? "" : "on"}" data-ptab="properties">Properties</button><button class="prop-tab ${propTab === "vehicles" ? "on" : ""}" data-ptab="vehicles">Vehicles</button></div>`;
  const body = propTab === "vehicles"
    ? (vehiclesSection() || `<p class="muted" style="padding:16px">No vehicles available.</p>`)
    : (citiesWithListings().map(citySection).join("") || `<p class="muted" style="padding:16px">No listings yet.</p>`);
  screenEl.innerHTML = `<h2 class="app-title">Properties</h2>
    <div class="prop-sub">${money(spendable())} to spend</div>${tabs}
    <div class="prop-list">${body}</div>`;
  bind();
}

function bind() {
  screenEl.querySelectorAll("[data-ptab]").forEach((b) => b.addEventListener("click", () => { propTab = b.dataset.ptab; renderPropertiesApp(screenEl); }));
  screenEl.querySelectorAll(".prop-act").forEach((b) => b.addEventListener("click", () => {
    const p = propDef(b.dataset.id); if (!p) return;
    const act = b.dataset.act;
    if (act === "enter") { closePhone(); travelTo(p.location, null); return; }
    if (act === "driveshow") { driveToShow(); return; }
    if (act === "reassign") {
      const pb = getState().bands.filter((x) => x.playerIn);
      if (pb.length > 1) { const cur = vehicleBand(p.id); const i = pb.findIndex((x) => x.id === cur); const nx = pb[(i + 1) % pb.length]; setPropertyStatus(p.id, propertyStatus(p.id), { bandId: nx.id }); toast(`${p.name} now belongs to ${nx.name || "that band"}.`, "good"); }
      persist(); renderPropertiesApp(screenEl); return;
    }
    if (act === "buy" || act === "buyout") {
      if (p.vehicle) {
        const ab = activeBand(); const keep = (act === "buyout" ? vehicleBand(p.id) : null) || (ab && ab.id);
        const r = payForBand(keep, p.buyPrice, { label: p.name, category: "vehicle" });
        if (!r || !r.ok) return;
        setPropertyStatus(p.id, "owned", { bandId: keep });
        toast(`${(bandById(keep) && bandById(keep).name) || "Your band"} bought ${p.name}!`, "good");
      } else {
        if (spendable() < p.buyPrice) { toast("Not enough cash to buy that.", "warn"); return; }
        addStat("money", -p.buyPrice); setPropertyStatus(p.id, "owned");
        toast(`You bought ${p.name}!`, "good");
      }
    } else if (act === "rent") {
      if (p.vehicle) {
        const ab = activeBand();
        const r = payForBand(ab && ab.id, p.rentPrice, { label: p.name + " lease", category: "vehicle" });
        if (!r || !r.ok) return;
        setPropertyStatus(p.id, "rented", { nextRentDay: currentDay() + rentPeriod(), behind: false, bandId: ab && ab.id });
        toast(`${(ab && ab.name) || "Your band"} leased ${p.name}.`, "good");
      } else {
        if (spendable() < p.rentPrice) { toast("Can't cover the first month's rent.", "warn"); return; }
        addStat("money", -p.rentPrice); setPropertyStatus(p.id, "rented", { nextRentDay: currentDay() + rentPeriod(), behind: false });
        toast(`You signed a lease on ${p.name}.`, "good");
      }
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
