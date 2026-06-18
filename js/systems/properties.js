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
import { getState, propDefs, propDef, propertyStatus, setPropertyStatus, spendable, addStat, currentCity, cityDef, cityUnlocked, activeBand, bandById, ownedVehicles, addVehicle, removeVehicle, setVehicleBand, vehicleById, bandSpend } from "../engine/state.js";
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

function vehiclesSection() {
  const types = propDefs().filter((p) => p.vehicle);
  if (!types.length) return "";
  const fleet = ownedVehicles();
  const pbAll = getState().bands.filter((x) => x.playerIn);
  let yours = "";
  if (fleet.length) {
    const seen = {};
    const cards = fleet.map((v) => {
      const d = propDef(v.type) || {};
      const sameType = fleet.filter((x) => x.type === v.type).length;
      seen[v.type] = (seen[v.type] || 0) + 1;
      const label = sameType > 1 ? `${d.name || v.type} #${seen[v.type]}` : (d.name || v.type);
      const ob = bandById(v.bandId);
      const statusTag = v.status === "leased" ? " \u00b7 leased" : " \u00b7 owned";
      const enter = `<button class="btn prop-act" data-act="venter" data-veh="${v.id}">Enter</button>`;
      const drive = `<button class="btn prop-act" data-act="vdrive" data-veh="${v.id}">Drive to next show \u25B8</button>`;
      const reassign = pbAll.length > 1 ? `<button class="btn ghost prop-act" data-act="vreassign" data-veh="${v.id}">Reassign band \u25B8</button>` : "";
      const dispose = v.status === "leased"
        ? `<button class="btn ghost prop-act" data-act="vendlease" data-veh="${v.id}">End lease</button>`
        : `<button class="btn ghost prop-act" data-act="vsell" data-veh="${v.id}">Sell (+${money(d.sellValue || 0)})</button>`;
      return `<div class="prop-card"><div class="prop-card-head">${esc(label)}<span class="muted">${esc(d.tagline || "")}${statusTag}</span></div><div class="prop-assign">Assigned to <strong>${esc((ob && ob.name) || "your band")}</strong></div><div class="prop-acts">${enter}${drive}${reassign}${dispose}</div></div>`;
    }).join("");
    yours = `<div class="prop-city"><div class="prop-city-head">Your Vehicles</div>${cards}</div>`;
  }
  const buy = types.map((p) => {
    const am = (p.amenities || []).map((a) => `<span class="prop-am">${esc(a)}</span>`).join("");
    const lease = p.rentPrice ? `<button class="btn prop-act" data-act="vlease" data-buytype="${p.id}">Lease ${money(p.rentPrice)}/mo</button>` : "";
    return `<div class="prop-card"><div class="prop-card-head">${esc(p.name)}<span class="muted">${esc(p.tagline || "")}</span></div><div class="prop-ams">${am}</div><div class="prop-acts">${lease}<button class="btn prop-act" data-act="vbuy" data-buytype="${p.id}">Buy ${money(p.buyPrice)}</button></div></div>`;
  }).join("");
  return yours + `<div class="prop-city"><div class="prop-city-head">Buy a Vehicle</div>${buy}</div>`;
}
function driveToShow(bandId) {
  const cmt = nextCommitment("show", bandId || null);
  if (!cmt) { toast("No shows booked for that band yet.", "info"); return; }
  const v = (DATA.venues && DATA.venues.venues && DATA.venues.venues[cmt.venue]) || null;
  const cd = v && v.town && cityDef(v.town);
  const es = cd && cd.entryScene;
  if (!es) { toast("Can't find the road to that venue yet.", "warn"); return; }
  const mins = (DATA.config.travel && DATA.config.travel.vehicleDriveMinutes) || 45;
  closePhone(); travelTo(es.scene, es.spawn); advanceMinutes(mins);
  toast(`On the road to ${cd.name} \u2014 ${mins} min.`, "good");
}
function handleVehicleAct(b, act) {
  if (b.dataset.veh) {
    const v = vehicleById(b.dataset.veh); if (!v) return;
    const d = propDef(v.type) || {};
    if (act === "venter") { closePhone(); travelTo(d.location, null); return; }
    if (act === "vdrive") { driveToShow(v.bandId); return; }
    if (act === "vreassign") { const pb = getState().bands.filter((x) => x.playerIn); if (pb.length > 1) { const i = pb.findIndex((x) => x.id === v.bandId); const nx = pb[(i + 1) % pb.length]; setVehicleBand(v.id, nx.id); toast(`${d.name} now serves ${nx.name || "that band"}.`, "good"); } persist(); renderPropertiesApp(screenEl); return; }
    if (act === "vsell") { addStat("money", d.sellValue || 0); removeVehicle(v.id); toast(`Sold ${d.name} for ${money(d.sellValue || 0)}.`, "good"); persist(); renderPropertiesApp(screenEl); return; }
    if (act === "vendlease") { removeVehicle(v.id); toast(`Ended the lease on ${d.name}.`, "good"); persist(); renderPropertiesApp(screenEl); return; }
    return;
  }
  if (b.dataset.buytype) {
    const d = propDef(b.dataset.buytype); if (!d) return;
    const ab = activeBand();
    if (act === "vbuy") { const r = payForBand(ab && ab.id, d.buyPrice, { label: d.name, category: "vehicle" }); if (!r || !r.ok) return; addVehicle(d.id, "owned", ab && ab.id); toast(`${(ab && ab.name) || "Your band"} bought ${d.name}!`, "good"); persist(); renderPropertiesApp(screenEl); return; }
    if (act === "vlease") { const r = payForBand(ab && ab.id, d.rentPrice, { label: d.name + " lease", category: "vehicle" }); if (!r || !r.ok) return; addVehicle(d.id, "leased", ab && ab.id, { nextRentDay: currentDay() + rentPeriod(), behind: false }); toast(`${(ab && ab.name) || "Your band"} leased ${d.name}.`, "good"); persist(); renderPropertiesApp(screenEl); return; }
  }
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
    const act = b.dataset.act;
    if (b.dataset.veh || b.dataset.buytype) { handleVehicleAct(b, act); return; }
    const p = propDef(b.dataset.id); if (!p) return;
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
  for (const v of ownedVehicles()) {
    if (v.status !== "leased") continue;
    const d = propDef(v.type) || {};
    if (v.nextRentDay == null) { v.nextRentDay = day + rentPeriod(); changed = true; continue; }
    if (day >= v.nextRentDay) {
      const ab = bandById(v.bandId);
      if (ab && (ab.account || 0) >= d.rentPrice) {
        bandSpend(v.bandId, d.rentPrice, "vehicle", d.name + " lease");
        v.nextRentDay = day + rentPeriod(); v.behind = false;
        toast(`Lease due: -${money(d.rentPrice)} for ${d.name}.`, "info");
      } else { v.behind = true; toast(`${(ab && ab.name) || "The band"} is short on the lease for ${d.name}.`, "warn"); }
      changed = true;
    }
  }
  if (changed) persist();
}
