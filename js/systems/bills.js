// ============================================================
// bills.js — Step 32: multi-band bills + the simulated living calendar.
//
// A venue NIGHT (a date the venue is open) holds 2-4 BILL POSITIONS that
// all happen at the venue's showtime — these are lineup positions, NOT
// the morning/evening time-of-day slots the calendar uses elsewhere.
// World bands actively claim positions on a daily tick: near nights pack
// out, far nights stay open, so the schedule genuinely fills as dates
// approach. A band plays one venue per night; occasionally a big touring
// act rolls through even a small room. Bills are stored state, advanced
// each day over a rolling horizon and pruned once past — kept light.
//
// This step builds the model + the simulation + a read-only "who else is
// playing" line in the venue board. Booking INTO a bill (slots, headliner
// logic, co-booking, bill-aware show outcome) is the next step.
// ============================================================
import { DATA } from "../engine/data.js";
import { getState, regionOfCity, bandById, mainGenre } from "../engine/state.js";
import { on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { worldBands, worldBandById } from "./worldmusic.js";
import { venueOpenOn, currentDay } from "./calendar.js";

function bcfg() { return (DATA.config && DATA.config.bills) || {}; }
function horizon() { return bcfg().horizonDays || 30; }
function venueRec(id) { return (DATA.venues && DATA.venues.venues && DATA.venues.venues[id]) || null; }
export function billCapacity(id) { const v = venueRec(id); return (v && v.billSlots) || bcfg().capacity || 3; }
function venueRegion(id) { const v = venueRec(id); return v ? regionOfCity(v.town) : null; }
function relevantVenues() { return Object.keys((DATA.venues && DATA.venues.venues) || {}); }

let _touringAdded = [];
function billsMap() { const s = getState(); if (s && !s.bills) s.bills = {}; return (s && s.bills) || {}; }
const keyOf = (venueId, day) => venueId + "@" + day;
export function billFor(venueId, day) { return billsMap()[keyOf(venueId, day)] || null; }

function drawScore(b) { return Math.round((b.fans || 0) * 0.5 + (b.fame || 0) * 2 + 10); }

function bandsPlayingOn(day) { const set = new Set(); const m = billsMap(); for (const k in m) { if (m[k].day === day) for (const a of m[k].acts) set.add(a.bandId); } return set; }

function pickBand(venueId, usedThisNight, inThisBill) {
  const region = venueRegion(venueId); const localMult = bcfg().localMult || 3;
  const v = venueRec(venueId); const vg = (v && v.genre) ? mainGenre(v.genre) : null; const gm = bcfg().genreMatchMult || 2.5;
  const pool = [];
  for (const b of worldBands()) {
    if (usedThisNight.has(b.id) || inThisBill.has(b.id)) continue;
    let w = ((b.fans || 50) / 100 + 1) * (b.region === region ? localMult : 0.15);
    if (vg) w *= (b.genreMain === vg) ? gm : 0.35;
    pool.push({ b, w });
  }
  if (!pool.length) return null;
  const tot = pool.reduce((a, x) => a + x.w, 0); let n = Math.random() * tot;
  for (const x of pool) { n -= x.w; if (n <= 0) return x.b; }
  return pool[pool.length - 1].b;
}
function pickTouring(usedThisNight, inThisBill) {
  const cands = worldBands().filter((b) => !usedThisNight.has(b.id) && !inThisBill.has(b.id) && ["Touring Act", "National", "Legend"].includes(b.tier));
  return cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
}

function fillTarget(daysAway, cap) {
  const frac = daysAway <= 2 ? 0.95 : daysAway <= 6 ? 0.75 : daysAway <= 12 ? 0.5 : daysAway <= 20 ? 0.3 : 0.15;
  return Math.max(0, Math.min(cap, Math.round(cap * frac)));
}
function ensureBill(venueId, day) { const m = billsMap(); const k = keyOf(venueId, day); if (!m[k]) m[k] = { venueId, day, acts: [] }; return m[k]; }

function stepNight(venueId, day, today) {
  if (!venueOpenOn(venueId, day)) return;
  const bill = ensureBill(venueId, day); const cap = billCapacity(venueId);
  const target = fillTarget(day - today, cap);
  const inThisBill = new Set(bill.acts.map((a) => a.bandId));
  const usedThisNight = bandsPlayingOn(day);
  if (bill.acts.length < cap && !bill.acts.some((a) => a.touring) && Math.random() < (bcfg().touringChance || 0.015)) {
    const t = pickTouring(usedThisNight, inThisBill);
    if (t) { bill.acts.push({ bandId: t.id, draw: drawScore(t), touring: true }); inThisBill.add(t.id); usedThisNight.add(t.id); _touringAdded.push({ venueId, day, name: t.name }); }
  }
  let guard = cap + 2;
  while (bill.acts.length < target && guard-- > 0) {
    if (Math.random() > (bcfg().addChance || 0.7)) break;
    const b = pickBand(venueId, usedThisNight, inThisBill); if (!b) break;
    bill.acts.push({ bandId: b.id, draw: drawScore(b), touring: false });
    inThisBill.add(b.id); usedThisNight.add(b.id);
  }
  bill.acts.sort((a, b) => (a.draw || 0) - (b.draw || 0)); // headliner = biggest = last
}

export function tickBills(today) {
  const s = getState(); if (!s || !worldBands().length) return;
  const m = billsMap();
  for (const k in m) { if (m[k].day < today - 1) delete m[k]; }   // keep yesterday so overnight auto-resolve can read the bill
  _touringAdded = [];
  const venues = relevantVenues();
  for (let d = today; d <= today + horizon(); d++) for (const vId of venues) stepNight(vId, d, today);
  try { saveToSlot(s.meta.slot, s); } catch (e) {}
  // heads-up: a big touring act rolling through soon (rare — an event worth catching)
  const soon = _touringAdded.filter((t) => t.day > today && t.day <= today + 7);
  if (soon.length) { const t = soon[0]; const vn = (venueRec(t.venueId) || {}).name || "a venue"; toast(`\uD83C\uDFB8 ${t.name} (\u2605) is touring through \u2014 ${vn}, Day ${t.day}. Grab an opener slot!`, "good"); }
}

export function ensureBills() {
  const s = getState(); if (!s) return;
  if (!worldBands().length) return;
  const ver = (DATA.config && DATA.config.bills && DATA.config.bills.coverageVersion) || 1;
  if (s.bills && Object.keys(s.bills).length && s.billsVer === ver) return;
  const today = currentDay();
  for (let p = 0; p < 6; p++) tickBills(today);  // bootstrap (or re-bootstrap on version bump) to proximity targets
  s.billsVer = ver;
}

let _inited = false;
export function initBills() {
  if (_inited) return; _inited = true;
  on("day:advanced", ({ day }) => tickBills(day != null ? day : currentDay()));
  ensureBills();
}

// ---- read helpers (display + next step's booking) ----
export function billLineup(venueId, day) {
  const bill = billFor(venueId, day); if (!bill) return [];
  return bill.acts.slice().sort((a, b) => (b.draw || 0) - (a.draw || 0)).map((a, i) => { const b = worldBandById(a.bandId) || bandById(a.bandId); return { bandId: a.bandId, name: (b ? (b.name || "Your band") : "Unknown") + (a.player ? " (you)" : ""), draw: a.draw, headliner: i === 0, touring: !!a.touring, player: !!a.player }; });
}
export function billOpenSlots(venueId, day) { return Math.max(0, billCapacity(venueId) - ((billFor(venueId, day) || { acts: [] }).acts.length)); }

// ---- player booking into bills (Step 32 step 2) ----
export function playerDrawScore(band) { return Math.round(((band && band.fans) || 0) * 0.5 + ((band && band.fame) || 0) * 2 + 10); }

export function addPlayerAct(venueId, day, band) {
  if (!band || !band.id) return false;
  const bill = ensureBill(venueId, day);
  if (bill.acts.some((a) => a.bandId === band.id)) return true; // already on this night
  if (bill.acts.length >= billCapacity(venueId)) return false;  // no open position
  bill.acts.push({ bandId: band.id, draw: playerDrawScore(band), player: true });
  bill.acts.sort((a, b) => (a.draw || 0) - (b.draw || 0));
  try { const s = getState(); saveToSlot(s.meta.slot, s); } catch (e) {}
  return true;
}
export function removePlayerAct(venueId, day, bandId) {
  const bill = billFor(venueId, day); if (!bill) return;
  bill.acts = bill.acts.filter((a) => !(a.player && a.bandId === bandId));
  try { const s = getState(); saveToSlot(s.meta.slot, s); } catch (e) {}
}
export function playerActsOn(day) { const out = []; const m = billsMap(); for (const k in m) { if (m[k].day === day) for (const a of m[k].acts) if (a.player) out.push({ venueId: m[k].venueId, bandId: a.bandId }); } return out; }

// the strategic context for a band playing a given venue-night
export function billContext(venueId, day, playerBandId) {
  const bill = billFor(venueId, day); if (!bill || !bill.acts.length) return null;
  const acts = bill.acts.slice().sort((a, b) => (b.draw || 0) - (a.draw || 0));
  const headliner = acts[0];
  const others = acts.filter((a) => a.bandId !== playerBandId);
  const mine = acts.find((a) => a.bandId === playerBandId);
  const coActs = others.map((a) => { const b = worldBandById(a.bandId) || bandById(a.bandId); return { bandId: a.bandId, name: b ? (b.name || "a band") : "Unknown", draw: a.draw }; });
  return {
    billSize: acts.length,
    onBill: !!mine,
    isHeadliner: !!mine && headliner.bandId === playerBandId,
    coActsDraw: others.reduce((s, a) => s + (a.draw || 0), 0),
    headlinerDraw: headliner ? headliner.draw : 0,
    headlinerName: (worldBandById(headliner.bandId) || bandById(headliner.bandId) || {}).name || (headliner.bandId === playerBandId ? "you" : "the headliner"),
    coActs
  };
}
// would this band headline if it booked this night? (for the booking projection)
export function wouldHeadline(venueId, day, band) {
  const bill = billFor(venueId, day); const my = playerDrawScore(band);
  const top = bill && bill.acts.length ? Math.max(...bill.acts.map((a) => a.draw || 0)) : 0;
  return my >= top;
}
export function currentHeadlinerName(venueId, day) {
  const lu = billLineup(venueId, day); return lu.length ? lu[0].name : null;
}
