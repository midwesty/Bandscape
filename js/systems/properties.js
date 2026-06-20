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
import { getState, propDefs, propDef, propertyStatus, setPropertyStatus, spendable, addStat, currentCity, cityDef, cityUnlocked, activeBand, bandById, ownedVehicles, addVehicle, removeVehicle, setVehicleBand, vehicleById, bandSpend, cityDayCost } from "../engine/state.js";
import { saveToSlot } from "../engine/storage.js";
import { on } from "../engine/bus.js";
import { toast } from "../ui/toast.js";
import { travelTo } from "./stage.js";
import { closePhone } from "./phone.js";
import { advanceMinutes, sleep, travelAwake } from "./time.js";
import { currentDay, nextCommitment, bookedCommitments } from "./calendar.js";
import { payForBand } from "./bank.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let _driveSel = null, _driveVeh = null;
function _isMine(bandId) { const b = bandById(bandId); return !!(b && b.playerIn); }
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
  const pbAll = getState().bands; // any band you control (incl. ones you formed) can own a vehicle
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
      const drive = `<button class="btn prop-act" data-act="vdrive" data-veh="${v.id}">Hit the road \u25B8</button>`;
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
// ---- The Drive menu (Step 47): pick which show to drive to, warned about anything you'd miss ----
function _venueOf(id) { return (DATA.venues && DATA.venues.venues && DATA.venues.venues[id]) || {}; }
function driveAssess(c, today) {
  const v = _venueOf(c.venue); const town = v.town; const cd = town ? cityDef(town) : null;
  const days = town ? cityDayCost(town) : 0;
  const arrivalDay = today + days;
  const here = currentCity ? currentCity() : null;
  const alreadyHere = !!(town && here === town && days === 0);
  const reachable = c.day >= arrivalDay;                 // you land on or before its day
  const missed = bookedCommitments().filter((o) => o.type === "show" && o.id !== c.id && _isMine(o.bandId) && o.day >= today && o.day <= arrivalDay);
  return { v, town, cd, days, arrivalDay, reachable, alreadyHere, missed };
}
function openDriveMenu(vehId) { _driveVeh = vehId || null; _driveSel = null; renderDriveMenu(); }
function closeDriveMenu() { const ov = document.getElementById("cal"); if (!ov) return; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); }
function renderDriveMenu() {
  const ov = document.getElementById("cal"); if (!ov) return;
  const today = currentDay();
  const shows = bookedCommitments().filter((c) => c.type === "show");
  let body;
  if (!shows.length) body = `<p class="shop-note">No shows booked yet. Book one from the BAND app, then come back to hit the road.</p>`;
  else body = shows.map((c) => {
    const a = driveAssess(c, today); const mine = _isMine(c.bandId); const b = bandById(c.bandId) || {};
    const cityNm = (a.cd && a.cd.name) || a.town || "somewhere"; const vnm = a.v.name || "a venue";
    const dist = a.alreadyHere ? "you're already here" : a.days === 0 ? "in your circuit \u2014 quick hop" : `${a.days} day${a.days > 1 ? "s" : ""} away`;
    const tag = mine ? `<span class="drive-tag mine">be there</span>` : `<span class="drive-tag mgr">auto-plays</span>`;
    let expand = "";
    if (_driveSel === c.id) {
      const warns = [];
      if (!a.reachable) warns.push(`\u26A0 Can't reach this in time \u2014 it's Day ${c.day}, but the drive lands you Day ${a.arrivalDay}.`);
      a.missed.forEach((m) => { const mb = bandById(m.bandId) || {}; const mv = _venueOf(m.venue).name || "a venue"; warns.push(`\u26A0 You'd miss <strong>${esc(mb.name || "your band")}</strong> @ ${esc(mv)}, Day ${m.day}.`); });
      const warnHTML = warns.length ? `<div class="drive-warn">${warns.join("<br>")}</div>` : `<div class="drive-ok">Clear run \u2014 nothing booked in the way.</div>`;
      const danger = warns.length ? " anyway" : "";
      const fastLbl = a.days === 0 ? "Drive over" : `Fast-travel${danger} (sleep there)`;
      expand = `<div class="drive-exp">${warnHTML}<div class="drive-modes">` +
        `<button class="cal-slot-btn" data-drive="fast" data-cid="${c.id}">\uD83D\uDECC ${fastLbl} \u25B8</button>` +
        (a.days === 0 ? "" : `<button class="cal-slot-btn" data-drive="ride" data-cid="${c.id}">\u2615 Ride along${danger} (stay awake) \u25B8</button>`) +
        `</div></div>`;
    }
    return `<div class="drive-row ${mine ? "mine" : "mgr"} ${_driveSel === c.id ? "sel" : ""}" data-pick="${c.id}">` +
      `<div class="drive-row-h"><strong>${esc(b.name || "Your band")}</strong>${tag}</div>` +
      `<div class="drive-row-sub">${esc(vnm)} \u00b7 ${esc(cityNm)} \u2014 Day ${c.day} \u00b7 <span class="drive-dist">${esc(dist)}</span></div>` +
      expand + `</div>`;
  }).join("");
  ov.innerHTML = `<div class="cal-modal"><div class="shop-head"><span class="shop-title">HIT THE ROAD</span><button class="phone-nav" id="drive-close">\u2715</button></div>` +
    `<div class="cal-body"><p class="shop-note">Pick a show to drive to. <span class="drive-tag mine">be there</span> = your band \u2014 show up. <span class="drive-tag mgr">auto-plays</span> = a band that plays itself; drive over to catch it for a boost.</p>${body}</div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  ov.querySelector("#drive-close").addEventListener("click", closeDriveMenu);
  ov.querySelectorAll("[data-pick]").forEach((el) => el.addEventListener("click", (e) => { if (e.target.closest("[data-drive]")) return; _driveSel = (_driveSel === el.dataset.pick) ? null : el.dataset.pick; renderDriveMenu(); }));
  ov.querySelectorAll("[data-drive]").forEach((bn) => bn.addEventListener("click", (e) => { e.stopPropagation(); execDrive(bn.dataset.cid, bn.dataset.drive); }));
}
function execDrive(cid, mode) {
  const c = bookedCommitments().find((x) => x.id === cid); if (!c) { closeDriveMenu(); return; }
  const a = driveAssess(c, currentDay()); const es = a.cd && a.cd.entryScene;
  if (!es) { toast("Can't find the road there yet.", "warn"); return; }
  closeDriveMenu(); closePhone(); travelTo(es.scene, es.spawn);
  if (a.days <= 0) { advanceMinutes((DATA.config.travel && DATA.config.travel.vehicleDriveMinutes) || 45); toast(`Over to ${a.cd.name} \u2014 quick hop.`, "good"); return; }
  if (mode === "ride") { travelAwake(a.days); toast(`Rode along ${a.days} day${a.days > 1 ? "s" : ""} to ${a.cd.name} \u2014 wiped, but awake.`, "good"); }
  else { const veh = _driveVeh ? vehicleById(_driveVeh) : null; const poor = !veh || veh.type === "veh_van"; for (let i = 0; i < a.days; i++) sleep({ poor }); toast(`Slept the drive \u2014 ${a.days} day${a.days > 1 ? "s" : ""} to ${a.cd.name}.`, "good"); }
}
function handleVehicleAct(b, act) {
  if (b.dataset.veh) {
    const v = vehicleById(b.dataset.veh); if (!v) return;
    const d = propDef(v.type) || {};
    if (act === "venter") { closePhone(); travelTo(d.location, null); return; }
    if (act === "vdrive") { openDriveMenu(v.id); return; }
    if (act === "vreassign") { const pb = getState().bands; if (pb.length > 1) { const i = pb.findIndex((x) => x.id === v.bandId); const nx = pb[(i + 1) % pb.length]; setVehicleBand(v.id, nx.id); toast(`${d.name} now serves ${nx.name || "that band"}.`, "good"); } persist(); renderPropertiesApp(screenEl); return; }
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
