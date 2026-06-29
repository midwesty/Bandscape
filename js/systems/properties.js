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
import { getState, propDefs, propDef, propertyStatus, setPropertyStatus, spendable, addStat, currentCity, cityDef, cityUnlocked, activeBand, bandById, ownedVehicles, addVehicle, removeVehicle, setVehicleBand, vehicleById, bandSpend, bandEarn, bandMembers, vehicleSleeps, vehicleScene, ensureRoadtownScene, cityDayCost, dayCostFrom, inHomeCircuit, cityRegion, isDiscovered } from "../engine/state.js";
import { saveToSlot } from "../engine/storage.js";
import { on } from "../engine/bus.js";
import { toast } from "../ui/toast.js";
import { travelTo } from "./stage.js";
import { closePhone } from "./phone.js";
import { advanceMinutes, sleep, travelAwake } from "./time.js";
import { roadsideStop, playRoadsideGig } from "./roadside.js";
import { currentDay, nextCommitment, bookedCommitments, openScheduler, setSchedulerReturn, setSchedBand, cancelShow } from "./calendar.js";
import { venueList, venueEligible, venueReqText } from "./shows.js";
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
      const outfit = `<button class="btn ghost prop-act" data-act="voutfit" data-veh="${v.id}">Outfit \u25b8</button>`;
      const drive = `<button class="btn prop-act" data-act="vdrive" data-veh="${v.id}">Hit the road \u25B8</button>`;
      const reassign = pbAll.length > 1 ? `<button class="btn ghost prop-act" data-act="vreassign" data-veh="${v.id}">Reassign band \u25B8</button>` : "";
      const dispose = v.status === "leased"
        ? `<button class="btn ghost prop-act" data-act="vendlease" data-veh="${v.id}">End lease</button>`
        : `<button class="btn ghost prop-act" data-act="vsell" data-veh="${v.id}">Sell (+${money(d.sellValue || 0)})</button>`;
      return `<div class="prop-card"><div class="prop-card-head">${esc(label)}<span class="muted">${esc(d.tagline || "")}${statusTag}</span></div><div class="prop-assign">Assigned to <strong>${esc((ob && ob.name) || "your band")}</strong></div><div class="prop-acts">${enter}${drive}${outfit}${reassign}${dispose}</div></div>`;
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
  const here = currentCity ? currentCity() : null;
  const days = town ? dayCostFrom(here, town) : 0;
  const arrivalDay = today + days;
  const alreadyHere = !!(town && here === town && days === 0);
  const reachable = c.day >= arrivalDay;                 // you land on or before its day
  const missed = bookedCommitments().filter((o) => o.type === "show" && o.id !== c.id && _isMine(o.bandId) && o.day >= today && o.day <= arrivalDay);
  return { v, town, cd, days, arrivalDay, reachable, alreadyHere, missed };
}
function openDriveMenu(vehId) { _driveVeh = vehId || null; _driveSel = null; renderDriveMenu(); }
function closeDriveMenu() { const ov = document.getElementById("cal"); if (!ov) return; ov.onclick = null; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); }
function renderDriveMenu() {
  const ov = document.getElementById("cal"); if (!ov) return;
  const today = currentDay();
  const bid = _tourBandId();
  const shows = bookedCommitments().filter((c) => c.type === "show" && c.bandId === bid);
  let body;
  if (!shows.length) body = `<p class="shop-note">No road shows booked for <strong>${esc(_tourBandName())}</strong> yet. Book this region\u2019s shows in the BAND app, or hit <em>Plan a tour</em> to book out-of-region anchors.</p>`;
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
  ov.innerHTML = `<div class="cal-modal"><div class="shop-head"><span class="shop-title">HIT THE ROAD \u00b7 ${esc(_tourBandName())}</span><button class="tp-link" id="drive-plan">Plan a tour \u25B8</button><button class="phone-nav" id="drive-close">\u2715</button></div>` +
    `<div class="cal-body"><p class="shop-note">Driving with <strong>${esc(_tourBandName())}</strong> \u2014 pick a show to drive to. Same-region circuit shows are a quick hop; distant ones cost days on the road.</p>${body}</div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  // One delegated handler on the stable overlay. Robust across re-renders AND reliable on iOS, where a
  // tap on a non-pointer child div otherwise fails to fire a click that bubbles up to the row.
  ov.onclick = (e) => {
    if (e.target.closest("#drive-close")) { closeDriveMenu(); return; }
    if (e.target.closest("#drive-plan")) { openTourPlanner(); return; }
    const driveBtn = e.target.closest("[data-drive]");
    if (driveBtn) { execDrive(driveBtn.dataset.cid, driveBtn.dataset.drive); return; }
    const row = e.target.closest("[data-pick]");
    if (row) { _driveSel = (_driveSel === row.dataset.pick) ? null : row.dataset.pick; renderDriveMenu(); }   // every booked show expands -> Fast-travel / Ride-along, in or out of region
  };
}
function chargeLeg(bid, veh) {
  const members = bandMembers(bid).length || 1;
  const sleeps = vehicleSleeps(veh);
  const cfgT = DATA.config.tour || {}; const gasRate = cfgT.gasPerDay || 45;
  const hotel = (DATA.config.lodging && DATA.config.lodging.hotelPrice) || 60;
  const bedShort = Math.max(0, members - sleeps);
  const lodging = bedShort * hotel;
  const total = gasRate + lodging;
  if (total > 0) { const r = bandSpend(bid, total, "tour", "Gas & lodging on the road"); if (!r || !r.ok) { const b = bandById(bid); if (b) b.account = (b.account || 0) - total; } }
  return { gas: gasRate, lodging, total };
}

// "Drive to next show" no longer teleports. It begins (or, from a roadtown bus, continues) a real
// day-by-day journey: multi-leg trips drop you in a walkable nowhere-town each morning, and the final
// leg lands you at the anchor city.
function execDrive(cid, mode) {
  const c = bookedCommitments().find((x) => x.id === cid); if (!c) { closeDriveMenu(); return; }
  const v = _venueOf(c.venue); const town = v.town; const cd = town ? cityDef(town) : null;
  const es = cd && cd.entryScene;
  if (!es) { toast("Can't find the road there yet.", "warn"); return; }
  const here = currentCity ? currentCity() : null;
  const totalLegs = town ? dayCostFrom(here, town) : 0;
  closeDriveMenu(); closePhone();
  if (totalLegs <= 0) { travelTo(es.scene, es.spawn); advanceMinutes((DATA.config.travel && DATA.config.travel.vehicleDriveMinutes) || 45); toast(`Over to ${cd.name} \u2014 quick hop.`, "good"); return; }
  const s = getState();
  s.journey = { active: true, anchorCmt: cid, anchorCity: town, totalLegs, leg: 0, bandId: _tourBandId(), vehId: _driveVeh };
  driveLeg(mode);
}

// Advance the active journey. ASLEEP = fast-forward straight to the next morning. AWAKE = you're dropped
// into your moving RV with the clock running in real time; turning in (the bed) is what rolls you into the
// next town. Either way you wake up in the next stop the following morning.
function driveLeg(mode) {
  const s = getState(); const j = s.journey; if (!j || !j.active) return;
  const veh = j.vehId ? vehicleById(j.vehId) : null;
  if (mode === "ride") {
    j.transit = true; persist();
    const vs = veh ? vehicleScene(veh) : null;
    if (vs) travelTo(vs, null);
    toast("On the road \u2014 work in the RV while the miles roll by. Turn in (the bed) when you're ready to wake up in the next town.", "good");
  } else {
    const poor = !veh || veh.type === "veh_van";
    sleep({ poor });        // advances the day; arrival is handled below (transit is off here)
    arriveAtLeg();
  }
}

// Resolve one leg: bill the day's gas + lodging to the band, then wake in the next nowhere-town (with the
// pickup-gig pop-up) or roll into the anchor city on the final day.
function arriveAtLeg() {
  const s = getState(); const j = s.journey; if (!j || !j.active) return;
  const veh = j.vehId ? vehicleById(j.vehId) : null;
  const cost = chargeLeg(j.bandId, veh);
  j.leg += 1;
  if (j.leg >= j.totalLegs) {
    const cd2 = cityDef(j.anchorCity); const es2 = cd2 && cd2.entryScene;
    j.active = false; j.transit = false; persist();
    if (es2) travelTo(es2.scene, es2.spawn);
    toast(`You roll into ${cd2 ? cd2.name : "town"} \u2014 show day. (\u2212$${cost.total} road)`, "good");
  } else {
    const stop = roadsideStop(currentDay());
    j.stop = stop; j.stopPlayed = false; j.transit = false;
    const key = ensureRoadtownScene(j.leg, stop);
    persist();
    if (key) travelTo(key, { x: 5, y: 4 });
    wakeInTown(stop, j, cost.total);
  }
}

// Turning in inside the RV (real-time ride) advances the day -> arrive in the next town.
function onDayAdvanced() {
  const s = getState(); const j = s.journey;
  if (j && j.active && j.transit) { j.transit = false; arriveAtLeg(); }
}
on("day:advanced", onDayAdvanced);

// Wake-up pop-up: you're parked on the main drag of a town you've never heard of. Opt into tonight's gig.
function wakeInTown(stop, j, spent) {
  const ov = document.getElementById("cal");
  if (!ov) { toast(`You wake up in ${stop.town}. (\u2212$${spent} road)`, "good"); return; }
  const left = j.totalLegs - j.leg;
  ov.innerHTML = `<div class="cal-modal"><div class="shop-head"><span class="shop-title">${esc(stop.town)}</span></div>` +
    `<div class="cal-body"><p class="shop-note">Morning. You're parked on the main drag \u2014 ${left} day${left > 1 ? "s" : ""} still to the show. (\u2212$${spent} road)</p>` +
    `<div class="rs-flavor" style="margin:8px 0">${esc(stop.flavor)}</div>` +
    `<p class="shop-note"><strong>${esc(stop.venue)}</strong> could put you on tonight.</p>` +
    `<button class="cal-slot-btn" data-wake="play" style="margin:9px 0">\uD83C\uDFB8 Play the pickup gig \u25b8</button>` +
    `<button class="cal-slot-btn" data-wake="skip">Just explore / pass through</button></div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  const close = () => { ov.onclick = null; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); };
  ov.onclick = (e) => { const w = e.target.closest("[data-wake]"); if (!w) return; close(); if (w.dataset.wake === "play") setTimeout(openRoadGig, 210); };
}

// The bar in a nowhere-town: play that stop's pickup gig (reuses the roadside payout).
function openRoadGig() {
  const s = getState(); const j = s.journey;
  if (!j || !j.stop) { toast("No pickup gig here.", "warn"); return; }
  if (j.stopPlayed) { toast("You already played here tonight.", "warn"); return; }
  const res = playRoadsideGig(j.stop, j.bandId); j.stopPlayed = true; persist();
  const ov = document.getElementById("cal");
  if (!ov) { toast(`Played ${res.venue} \u2014 +$${res.pay}, +${res.fans} fans.`, "good"); return; }
  ov.innerHTML = `<div class="cal-modal"><div class="shop-head"><span class="shop-title">${esc(j.stop.town)}</span><button class="phone-nav" id="rg-x">\u2715</button></div>` +
    `<div class="cal-body"><div class="rs-gig"><div class="rs-gig-h"><strong>${esc(res.venue)}</strong></div><div class="rs-flavor">${esc(j.stop.flavor)}</div><div class="rs-take">+$${res.pay} \u00b7 +${res.fans} fans</div></div>` +
    `<p class="shop-note">Played the local room \u2014 money's in the band account. When you're ready, head to your bus to drive on.</p></div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  ov.onclick = (e) => { if (e.target.closest("#rg-x")) { ov.onclick = null; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); } };
}

// The parked bus in a nowhere-town: drive on toward the anchor (awake or asleep).
function openRoadBus() {
  const s = getState(); const j = s.journey;
  if (!j || !j.active) { toast("Nowhere to be right now.", "warn"); return; }
  const left = j.totalLegs - j.leg;
  const ov = document.getElementById("cal"); if (!ov) { driveLeg("fast"); return; }
  ov.innerHTML = `<div class="cal-modal"><div class="shop-head"><span class="shop-title">HIT THE ROAD</span><button class="phone-nav" id="rb-x">\u2715</button></div>` +
    `<div class="cal-body"><p class="shop-note">${left} day${left > 1 ? "s" : ""} to ${esc((cityDef(j.anchorCity) || {}).name || "the show")}. How do you cover today's drive?</p>` +
    `<button class="cal-slot-btn" data-leg="ride" style="margin-bottom:9px">\u2615 Ride awake \u2014 work in the RV \u25b8</button>` +
    `<button class="cal-slot-btn" data-leg="fast">\uD83D\uDECC Sleep through \u2014 wake up there \u25b8</button></div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  const close = () => { ov.onclick = null; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); };
  ov.onclick = (e) => { if (e.target.closest("#rb-x")) { close(); return; } const lg = e.target.closest("[data-leg]"); if (lg) { close(); setTimeout(() => driveLeg(lg.dataset.leg), 210); } };
}
on("road:gig", openRoadGig);
on("road:bus", openRoadBus);

// Recap after a multi-day drive. If you played roadside gigs along the way, show the haul; otherwise
// just confirm the arrival. Reuses the #cal overlay.
function roadsideArrive(destName, days, mode, gigs, costs) {
  costs = costs || { total: 0 };
  const dayTxt = `${days} day${days > 1 ? "s" : ""}`;
  if (!gigs.length && !(costs.total > 0)) {
    toast(mode === "ride" ? `Rode along ${dayTxt} to ${destName} \u2014 wiped, but awake.` : `Slept the drive \u2014 ${dayTxt} to ${destName}.`, "good");
    return;
  }
  const ov = document.getElementById("cal");
  const totPay = gigs.reduce((s, g) => s + g.res.pay, 0);
  const net = totPay - (costs.total || 0);
  const netTxt = `${net >= 0 ? "+" : "\u2212"}$${Math.abs(net)}`;
  if (!ov) { toast(`${destName}: +$${totPay} gigs, \u2212$${costs.total || 0} road \u2014 net ${netTxt}.`, net >= 0 ? "good" : "warn"); return; }
  const rows = gigs.map((g) => `<div class="rs-gig"><div class="rs-gig-h"><strong>${esc(g.stop.town)}</strong> \u2014 ${esc(g.stop.venue.name)}</div><div class="rs-flavor">${esc(g.stop.flavor)}</div><div class="rs-take">+$${g.res.pay} \u00b7 +${g.res.fans} fans</div></div>`).join("");
  const lodgeRow = costs.lodging > 0
    ? `<div class="rs-cost-row"><span>\uD83C\uDFE8 Hotels \u00b7 ${costs.bedShort} of ${costs.members} (no bed aboard)</span><span>\u2212$${costs.lodging}</span></div>`
    : `<div class="rs-cost-row"><span>\uD83D\uDECC Slept in the vehicle (${costs.sleeps} bed${costs.sleeps === 1 ? "" : "s"})</span><span>free</span></div>`;
  const costRows = `<div class="rs-cost"><div class="rs-cost-row"><span>\u26fd Gas \u00b7 ${dayTxt}</span><span>\u2212$${costs.gas || 0}</span></div>${lodgeRow}</div>`;
  ov.innerHTML = `<div class="cal-modal"><div class="shop-head"><span class="shop-title">ON THE ROAD</span><button class="phone-nav" id="rs-x">\u2715</button></div>` +
    `<div class="cal-body">` +
    (gigs.length ? `<p class="shop-note">Pickup gigs on the way to ${esc(destName)}:</p>${rows}` : `<p class="shop-note">Drove ${dayTxt} to ${esc(destName)}.</p>`) +
    costRows +
    `<div class="tp-foot">${gigs.length ? `+$${totPay} gigs \u00b7 ` : ""}\u2212$${costs.total || 0} road \u00b7 net ${netTxt}</div>` +
    `<button class="cal-slot-btn" id="rs-roll" style="margin-top:11px">Roll on into ${esc(destName)} \u25b8</button></div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  const close = () => { ov.onclick = null; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); };
  ov.onclick = (e) => { if (e.target.closest("#rs-x") || e.target.closest("#rs-roll")) close(); };
}

// ---- Vehicle Outfitter (Step 56): kit out THIS vehicle's own interior, remotely. Reads/writes
// placedObjects[vehicleScene(v)] so each vehicle is outfitted independently. Beds + a kitchen feed
// the tour economy (free sleep / cheaper food); comfort + vibe items are staged here for the morale pass. ----
let _outfitVeh = null;
function outfitScene(v) {
  const scene = vehicleScene(v); const s = getState(); s.placedObjects = s.placedObjects || {};
  if (!s.placedObjects[scene]) { const base = (propDef(v.type) || {}).location; s.placedObjects[scene] = JSON.parse(JSON.stringify((DATA.locations[base] && DATA.locations[base].objects) || [])); }
  return scene;
}
function outfitFreeTile(scene, base) {
  const grid = (DATA.locations[base] && DATA.locations[base].grid) || { w: 6, h: 4 };
  const occ = new Set((getState().placedObjects[scene] || []).map((o) => `${o.tile.x},${o.tile.y}`));
  for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) { if (!occ.has(`${x},${y}`)) return { x, y }; }
  return null;
}
function openOutfitter(vehId) { _outfitVeh = vehId; const v = vehicleById(vehId); if (!v) { toast("No vehicle.", "warn"); return; } outfitScene(v); renderOutfitter(); }
function closeOutfitter() { const ov = document.getElementById("cal"); if (!ov) return; ov.onclick = null; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); }
function renderOutfitter() {
  const ov = document.getElementById("cal"); if (!ov) return;
  const v = vehicleById(_outfitVeh); if (!v) return;
  const def = propDef(v.type) || {}; const scene = vehicleScene(v);
  const s = getState(); const placed = s.placedObjects[scene] || [];
  const cap = def.slots || 10; const used = placed.length;
  const ob = bandById(v.bandId); const acct = (ob && ob.account) || 0; const wallet = spendable();
  const items = (DATA.decor && DATA.decor.items) || {};
  const instRows = placed.map((o, i) => { const did = o.decorId || o.id; const di = items[did] || {}; const nm = o.name || di.name || did; const isBed = di.shape === "bed" || o.interact === "sleep" || /bed|futon|bunk/i.test(did || ""); return `<div class="of-row"><span>${esc(nm)}${isBed ? ` <small class="muted">sleeps ${di.sleeps || 1}</small>` : ""}</span><button class="of-rm" data-rm="${i}">Remove</button></div>`; }).join("") || `<p class="shop-note">Empty inside.</p>`;
  const labels = { sleep: "Sleeping", kitchen: "Kitchen", bath: "Bathroom", comfort: "Comfort", vibe: "Vibe", audio: "Audio / Screens" };
  const groups = {};
  for (const [id, it] of Object.entries(items)) { if (!it.vehicleOk) continue; const c = it.vcat || "other"; (groups[c] = groups[c] || []).push({ id, it }); }
  let cat = "";
  for (const c of ["sleep", "kitchen", "bath", "comfort", "vibe", "audio"]) {
    if (!groups[c]) continue;
    cat += `<div class="of-cat">${esc(labels[c] || c)}</div>` + groups[c].map(({ id, it }) => {
      const price = it.price || 0; const full = used >= cap; const broke = (acct + wallet) < price; const dis = full || broke;
      const note = it.shape === "bed" ? ` \u00b7 sleeps ${it.sleeps || 1}` : (c === "kitchen" ? " \u00b7 food" : "");
      return `<div class="of-row"><span>${esc(it.name || id)} <small class="muted">${money(price)}${note}</small></span><button class="of-buy" data-buy="${id}" ${dis ? "disabled" : ""}>${full ? "Full" : "Install"}</button></div>`;
    }).join("");
  }
  ov.innerHTML = `<div class="cal-modal"><div class="shop-head"><span class="shop-title">OUTFIT \u00b7 ${esc(def.name || "Vehicle")}</span><button class="phone-nav" id="of-x">\u2715</button></div>` +
    `<div class="cal-body">` +
    `<div class="of-bar"><span>Space ${used}/${cap}</span><span>${esc((ob && ob.name) || "Band")} acct ${money(acct)}</span></div>` +
    `<div class="of-h">Installed</div>${instRows}` +
    `<div class="of-h">Add to this vehicle</div>${cat}` +
    `<p class="shop-note">Each vehicle is outfitted on its own. Step inside to rearrange where things sit.</p></div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  ov.onclick = (e) => {
    if (e.target.closest("#of-x")) { closeOutfitter(); return; }
    const buy = e.target.closest("[data-buy]"); if (buy) { outfitInstall(buy.dataset.buy); return; }
    const rm = e.target.closest("[data-rm]"); if (rm) { outfitRemove(parseInt(rm.dataset.rm, 10)); return; }
  };
}
function outfitInstall(itemId) {
  const v = vehicleById(_outfitVeh); if (!v) return;
  const def = propDef(v.type) || {}; const scene = outfitScene(v); const base = def.location;
  const placed = getState().placedObjects[scene]; const cap = def.slots || 10;
  if (placed.length >= cap) { toast("No room left inside.", "warn"); return; }
  const it = ((DATA.decor && DATA.decor.items) || {})[itemId]; if (!it) return;
  const tile = outfitFreeTile(scene, base); if (!tile) { toast("No open spot inside.", "warn"); return; }
  const price = it.price || 0;
  if (price > 0) { const r = bandSpend(v.bandId, price, "vehicle", `Outfit \u2014 ${it.name || itemId}`); if (!r || !r.ok) { toast("Can't afford that.", "warn"); return; } }
  placed.push({ id: "decor_" + itemId + "_" + Date.now().toString(36), name: it.name || itemId, tile, decorId: itemId, sprite: it.sprite });
  persist(); toast(`Installed ${it.name || itemId}.`, "good"); renderOutfitter();
}
function outfitRemove(idx) {
  const v = vehicleById(_outfitVeh); if (!v) return;
  const scene = vehicleScene(v); const placed = getState().placedObjects[scene] || [];
  const o = placed[idx]; if (!o) return;
  const it = ((DATA.decor && DATA.decor.items) || {})[o.decorId || o.id];
  placed.splice(idx, 1);
  if (it && it.price && v.bandId) { const refund = Math.floor(it.price * 0.5); bandEarn(v.bandId, refund, "vehicle", `Removed ${it.name || o.id}`); toast(`Removed ${it.name || o.id} (+${money(refund)}).`, "good"); }
  else toast(`Removed ${o.name || o.id}.`, "good");
  persist(); renderOutfitter();
}

// ---- The Tour Planner (Step 51): plan-then-execute. Lay out the road route (anchors + the nights
// between them) and choose which in-between nights to fill with pickup gigs UP FRONT, so driving later
// executes the plan instead of skipping those nights. Anchors are your booked out-of-circuit shows. ----
function _cityRegionOf(town) { const cd = town && cityDef(town); return (cd && cd.region) || "midwest"; }
function _showRegion(c) { return _cityRegionOf(_venueOf(c.venue).town); }
// A tour belongs to ONE band: the band assigned to the vehicle you hit the road with. Everything
// (the route, the anchors shown, the fill-nights, who gets booked) scopes to this band so two bands
// never share a tour.
function _tourBandId() { const v = _driveVeh ? vehicleById(_driveVeh) : null; return (v && v.bandId) || ((activeBand() || {}).id) || "band_1"; }
function _tourBandName() { return (bandById(_tourBandId()) || {}).name || "Your band"; }
function _tourFills() { const s = getState(); s.tour = s.tour || {}; const bid = _tourBandId(); if (!s.tour[bid] || typeof s.tour[bid] !== "object" || !s.tour[bid].fills) s.tour[bid] = { fills: {} }; return s.tour[bid].fills; }
function _currentRegion() { return _cityRegionOf(currentCity ? currentCity() : null); }
function openTourPlanner() { renderTourPlanner(); }
function closeTourPlanner() { const ov = document.getElementById("cal"); if (!ov) return; ov.onclick = null; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); }
function renderTourPlanner() {
  const ov = document.getElementById("cal"); if (!ov) return;
  const bid = _tourBandId(); const bandNm = _tourBandName();
  const today = currentDay();
  const anchors = bookedCommitments().filter((c) => c.type === "show" && c.bandId === bid && !inHomeCircuit(_venueOf(c.venue).town)).sort((a, b) => a.day - b.day);
  let body;
  if (!anchors.length) {
    body = `<p class="shop-note">No road shows on <strong>${esc(bandNm)}</strong>\u2019s tour yet. Book your anchor cities below \u2014 you\u2019ll roll through a real town each day on the way to each one.</p>`;
  } else {
    let rows = `<div class="tp-node tp-home">\uD83C\uDFE0 <strong>Home base</strong> \u2014 Day ${today}</div>`;
    let prevDay = today, totalDrive = 0;
    anchors.forEach((c) => {
      const town = _venueOf(c.venue).town; const cd = cityDef(town); const dc = cityDayCost(town); totalDrive += dc;
      const gap = c.day - prevDay - 1;
      if (gap > 0) {
        const days = []; for (let d = prevDay + 1; d <= c.day - 1; d++) days.push(d);
        rows += `<div class="tp-gap"><span>${gap} town${gap > 1 ? "s" : ""} to pass through on the way</span></div>`;
      }
      const b = bandById(c.bandId) || {}; const mine = _isMine(c.bandId);
      rows += `<div class="tp-leg">\u2193 drive ${dc} day${dc !== 1 ? "s" : ""}</div>` +
        `<div class="tp-node tp-anchor ${mine ? "mine" : "mgr"}"><strong>${esc(b.name || "Your band")}</strong> <span class="tp-tag ${mine ? "mine" : "mgr"}">${mine ? "be there" : "auto-plays"}</span><br><small>${esc(_venueOf(c.venue).name || "venue")} \u00b7 ${esc((cd && cd.name) || town)} \u2014 Day ${c.day}</small> <button class="tp-cancel" data-cancel="${c.id}">Cancel show</button></div>`;
      prevDay = c.day;
    });
    const daysOut = anchors[anchors.length - 1].day - today;
    body = rows +
      `<div class="tp-foot">${anchors.length} road show${anchors.length > 1 ? "s" : ""} \u00b7 ${daysOut} days out \u00b7 ${totalDrive} town${totalDrive !== 1 ? "s" : ""} en route</div>` +
      `<p class="shop-note" style="margin-top:8px">Each day on the road you wake up in a real town \u2014 explore it, play the local pickup gig if you want, restock, then drive on from your bus. Add more anchors by booking distant shows in the BAND app.</p>`;
  }
  // Book out-of-region anchors right here. Newcomer doors (open bars) are always bookable; gated rooms need discovery/fame.
  const curR = _currentRegion();
  const roadVs = venueList().filter((v) => v.town && cityDef(v.town) && _cityRegionOf(v.town) !== curR && (v.open || isDiscovered(v.id)));
  const byCity = {}; roadVs.forEach((v) => { (byCity[v.town] = byCity[v.town] || []).push(v); });
  const cityIds = Object.keys(byCity).sort((a, b) => (((cityDef(a) || {}).name) || a).localeCompare(((cityDef(b) || {}).name) || b));
  let addHTML = `<div class="tp-add-h">+ Add an anchor (book a road show)</div>`;
  if (!cityIds.length) addHTML += `<p class="shop-note">No out-of-region rooms open to you yet \u2014 tour somewhere new or build fame to unlock them.</p>`;
  else addHTML += cityIds.map((town) => { const cd = cityDef(town); return `<div class="tp-city"><div class="tp-city-h">${esc((cd && cd.name) || town)} \u00b7 ${esc(_cityRegionOf(town))}</div>` + byCity[town].map((v) => {
    return venueEligible(v.id)
      ? `<button class="tp-venue" data-book="${v.id}">${esc(v.name)}</button>`
      : `<button class="tp-venue locked" data-locked="${v.id}">${esc(v.name)} \uD83D\uDD12 <small>${esc(venueReqText(v.id))}</small></button>`;
  }).join("") + `</div>`; }).join("");
  body += addHTML;
  ov.innerHTML = `<div class="cal-modal"><div class="shop-head"><span class="shop-title">TOUR PLANNER \u00b7 ${esc(bandNm)}</span><button class="phone-nav" id="tp-close">\u2715</button></div><div class="cal-body">${body}</div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  ov.onclick = (e) => {
    if (e.target.closest("#tp-close")) { closeTourPlanner(); return; }
    const cn = e.target.closest("[data-cancel]");
    if (cn) { const r = cancelShow(cn.dataset.cancel); if (r) toast(r.famePenalty ? `Show canceled \u2014 \u2212${r.famePenalty} fame for short notice.` : "Show canceled \u2014 plenty of notice, no harm done.", r.famePenalty ? "warn" : "good"); renderTourPlanner(); return; }
    const lk = e.target.closest("[data-locked]");
    if (lk) { toast(venueReqText(lk.dataset.locked) || "That room isn\u2019t open to you yet.", "warn"); return; }
    const bk = e.target.closest("[data-book]");
    if (bk) { setSchedBand(bid, true); setSchedulerReturn(() => openTourPlanner()); openScheduler("show", bk.dataset.book); return; }
  };
}
function handleVehicleAct(b, act) {
  if (b.dataset.veh) {
    const v = vehicleById(b.dataset.veh); if (!v) return;
    const d = propDef(v.type) || {};
    if (act === "venter") { closePhone(); travelTo(vehicleScene(v), null); return; }
    if (act === "vdrive") { openDriveMenu(v.id); return; }
    if (act === "voutfit") { openOutfitter(v.id); return; }
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
