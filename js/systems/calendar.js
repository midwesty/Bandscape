// ============================================================
// calendar.js — Calendar & Scheduling (Step 9).
//
// Time becomes the resource. Each day has SLOTS (Morning /
// Afternoon / Evening / Late). Activities are COMMITMENTS booked
// into a (day, slot): rehearsals and shows. You can only book a
// slot that's open — gated by bandmate availability (rehearsals)
// and the venue's open nights (shows) — and you must ATTEND during
// that slot or you miss it. Busking stays spontaneous (no booking).
//
// This module owns commitments, the scheduler picker, the Calendar
// phone app, and the missed-commitment sweep. band.js / shows.js
// consult findReady()/complete() to gate execution.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, activeBand, bandMembers, bandById } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { autoResolveShow, showAutoReport } from "./shows.js";
import { billOpenSlots, billLineup, addPlayerAct, billContext, wouldHeadline, currentHeadlinerName } from "./bills.js";

let overlay = null, schedVenue = null;

const cfg = () => DATA.config.calendar;
const slots = () => cfg().slots;
const slotIndex = (id) => slots().findIndex((s) => s.id === id);
export function slotLabel(id) { return (slots().find((s) => s.id === id) || {}).label || id; }
export function currentSlot() {
  const h = getState().time.hour;
  for (const s of slots()) { const end = s.end > 24 ? s.end - 24 : s.end; if (s.end > 24) { if (h >= s.start || h < end) return s.id; } else if (h >= s.start && h < s.end) return s.id; }
  return slots()[slots().length - 1].id;
}
const today = () => getState().time.day;
const nUnits = () => slots().length;
const nowIndex = () => today() * nUnits() + slotIndex(currentSlot());
const cmtIndex = (c) => c.day * nUnits() + slotIndex(c.slot);
function list() { const s = getState(); s.calendar = s.calendar || { commitments: [] }; return s.calendar.commitments; }
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function bookedAt(day, slot) { return list().some((c) => c.status === "booked" && c.day === day && c.slot === slot); }
function bandBusyAt(bandId, day, slot) { return list().some((c) => c.status === "booked" && c.bandId === bandId && c.day === day && c.slot === slot); }
function venueBusyAt(venueId, day, slot) { return list().some((c) => c.status === "booked" && c.type === "show" && c.venue === venueId && c.day === day && c.slot === slot); }
function venueOpen(day) { return (((day * 2654435761) >>> 0) % 3) !== 0; }
// Per-venue weekly rhythm (Step 23.1): day 1 = Monday. A venue with days[] hosts only those
// weekdays at its own slot; venues without days[] fall back to the legacy open-most-nights rhythm.
const WK = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WK_LABEL = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
function weekday(day) { return WK[((day - 1) % 7 + 7) % 7]; }
function weekdayLabel(day) { return WK_LABEL[weekday(day)] || ""; }
function venueRec(id) { return (DATA.venues && DATA.venues.venues && DATA.venues.venues[id]) || null; }
export function venueSlotOf(id) { const v = venueRec(id); return (v && v.slot) || cfg().showSlot || "evening"; }
export function venueOpenOn(id, day) { const v = venueRec(id); if (v && Array.isArray(v.days) && v.days.length) return v.days.includes(weekday(day)); return venueOpen(day); }
export function venueOpenInfo(venueId) {
  const v = venueRec(venueId); const d0 = today();
  let nextDay = null;
  for (let d = d0; d <= d0 + 14; d++) { if (venueOpenOn(venueId, d)) { nextDay = d; break; } }
  const nextLabel = nextDay == null ? null : (nextDay === d0 ? "today" : nextDay === d0 + 1 ? "tomorrow" : `Day ${nextDay} (${weekdayLabel(nextDay)})`);
  return { openToday: venueOpenOn(venueId, d0), nextDay, nextLabel, slotLabel: slotLabel(venueSlotOf(venueId)), dayLabels: v && Array.isArray(v.days) ? v.days.map((x) => WK_LABEL[x] || x) : null };
}
function bandAvailableCount(slot) {
  const npcs = DATA.npcs.npcs || []; const ab = activeBand(); const mem = ab ? bandMembers(ab.id) : [];
  return mem.filter((m) => { const n = npcs.find((x) => x.id === m.id); return n && (n.availability || []).includes(slot); }).length;
}

const venueMatch = (c, venueId) => !venueId || c.venue === venueId || (venueId === "thedive" && (c.venue === "venue" || c.venue == null));
export function findReady(type, bandId, venueId) { return list().find((c) => c.status === "booked" && c.type === type && (!bandId || c.bandId === bandId) && venueMatch(c, venueId) && c.day === today() && c.slot === currentSlot()) || null; }
export function nextCommitment(type, bandId) {
  const ni = nowIndex();
  return list().filter((c) => c.status === "booked" && (!type || c.type === type) && (!bandId || c.bandId === bandId) && cmtIndex(c) >= ni).sort((a, b) => cmtIndex(a) - cmtIndex(b))[0] || null;
}
export function bookedCommitments() { return list().filter((c) => c.status === "booked").sort((a, b) => cmtIndex(a) - cmtIndex(b)); }
export function currentDay() { return today(); }
export function complete(id) { const c = list().find((x) => x.id === id); if (c) { c.status = "done"; persist(); emit("calendar:updated"); } }

function availableSlots(type) {
  const out = []; const horizon = type === "show" ? (cfg().showHorizonDays || 14) : (cfg().horizonDays || 7); const ni = nowIndex();
  const ab = (type === "show" && schedBand) ? schedBand : (activeBand() || {}); const mem = (ab.id ? bandMembers(ab.id) : []).length;
  for (let d = today(); d <= today() + horizon; d++) {
    for (const sl of slots()) {
      const idx = d * nUnits() + slotIndex(sl.id);
      if (idx < ni) continue;
      if (ab.id && bandBusyAt(ab.id, d, sl.id)) continue;                       // never double-book the SAME band
      if (type === "show") {
        if (sl.id !== venueSlotOf(schedVenue)) continue;
        if (!venueOpenOn(schedVenue, d)) continue;
        if (schedVenue && billOpenSlots(schedVenue, d) <= 0) continue;          // the bill is full that night
      } else if (type === "rehearse") {
        if (!mem) continue;
        if (bandAvailableCount(sl.id) < Math.ceil(mem / 2)) continue;
      }
      out.push({ day: d, slot: sl.id, label: sl.label });
      if (out.length >= 16) return out;
    }
  }
  return out;
}

// ---- scheduler picker ----
let schedBand = null, schedType = "show";
function playerBands() { return (getState().bands || []); }   // every band the player manages is bookable
function ensureSchedBand() { const pb = playerBands(); const ab = activeBand(); schedBand = (ab && pb.find((b) => b.id === ab.id)) ? ab : ((schedBand && pb.find((b) => b.id === schedBand.id)) ? schedBand : (pb[0] || null)); }
function bandPillsHTML() {
  const pb = playerBands(); if (pb.length <= 1) return "";
  return `<div class="sched-bands"><span class="sched-bands-lbl">Booking as:</span>${pb.map((b) => `<button class="sched-band-pill ${schedBand && b.id === schedBand.id ? "on" : ""}" data-band="${esc(b.id)}">${esc(b.name || "Your band")}</button>`).join("")}</div>`;
}
function showNightCard(o) {
  const day = o.day; const lu = billLineup(schedVenue, day); const open = billOpenSlots(schedVenue, day);
  const lineupStr = lu.length ? lu.map((a) => esc(a.name) + (a.headliner ? " (headliner)" : "") + (a.touring ? " ★" : "")).join(", ") : "wide open — no acts booked yet";
  const proj = schedBand ? (wouldHeadline(schedVenue, day, schedBand)
      ? `<span class="sched-proj head">you'd headline</span>`
      : `<span class="sched-proj open">you'd open under ${esc(currentHeadlinerName(schedVenue, day) || "the headliner")}</span>`) : "";
  return `<div class="sched-night">
    <div class="sched-night-h">Day ${day} · ${weekdayLabel(day)}${day === today() ? " · today" : ""}</div>
    <div class="sched-bill"><span class="mp-bill-h">On the bill:</span> ${lineupStr}</div>
    <div class="sched-meta"><span class="mp-bill-open">${open} slot${open !== 1 ? "s" : ""} open</span>${proj ? " · " + proj : ""}</div>
    <button class="cal-slot-btn" data-day="${day}" data-slot="${esc(o.slot)}">Book ${esc((schedBand && schedBand.name) || "band")} here</button>
  </div>`;
}
export function openScheduler(type, venueId) {
  schedType = type;
  schedVenue = venueId || (type === "show" ? "thedive" : null);
  if (type === "show") ensureSchedBand();
  overlay = overlay || document.getElementById("cal");
  renderScheduler();
}
function renderScheduler() {
  const type = schedType;
  const opts = availableSlots(type);
  const title = type === "show" ? "BOOK A SHOW" : "SCHEDULE REHEARSAL";
  const schedVName = (DATA.venues && DATA.venues.venues && DATA.venues.venues[schedVenue] && DATA.venues.venues[schedVenue].name) || "The Dive";
  let body;
  if (type === "show") {
    const sub = `${schedVName} — 2–4 acts share each night's bill. Book into an open slot; out-draw the room to headline. Be there that evening.`;
    const nights = opts.length ? opts.map(showNightCard).join("") : `<p class="shop-note">No nights with an open slot in the next while. Check back another day.</p>`;
    body = `<p class="shop-note">${sub}</p>${bandPillsHTML()}${nights}`;
  } else {
    const sub = "Open slots where enough of your band is free. Show up to rehearse.";
    const byDay = {}; opts.forEach((o) => { (byDay[o.day] = byDay[o.day] || []).push(o); });
    const daysHTML = Object.keys(byDay).length
      ? Object.entries(byDay).map(([d, arr]) => `<div class="cal-day"><div class="cal-day-h">Day ${d} · ${weekdayLabel(+d)}${+d === today() ? " · today" : ""}</div><div class="cal-slots">${arr.map((o) => `<button class="cal-slot-btn" data-day="${o.day}" data-slot="${o.slot}">${esc(o.label)}</button>`).join("")}</div></div>`).join("")
      : `<p class="shop-note">Your bandmates aren't free — try a different week.</p>`;
    body = `<p class="shop-note">${sub}</p>${daysHTML}`;
  }
  overlay.innerHTML = `
    <div class="cal-modal">
      <div class="shop-head"><span class="shop-title">${title}</span><button class="phone-nav" id="cal-close">✕</button></div>
      <div class="cal-body">${body}</div>
    </div>`;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  overlay.querySelector("#cal-close").addEventListener("click", closeScheduler);
  overlay.querySelectorAll(".sched-band-pill").forEach((b) => b.addEventListener("click", () => { const pb = playerBands().find((x) => x.id === b.dataset.band); if (pb) schedBand = pb; renderScheduler(); }));
  overlay.querySelectorAll(".cal-slot-btn").forEach((b) => b.addEventListener("click", () => book(schedType, parseInt(b.dataset.day, 10), b.dataset.slot)));
}
function closeScheduler() {
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}
function book(type, day, slot) {
  const band = type === "show" ? (schedBand || activeBand() || {}) : (activeBand() || {});
  const venueId = type === "show" ? (schedVenue || "thedive") : null;
  const vName = (DATA.venues && DATA.venues.venues && DATA.venues.venues[venueId] && DATA.venues.venues[venueId].name) || "the venue";
  const title = type === "show" ? `Show · ${band.name || "your band"} @ ${vName}` : `Rehearsal · ${band.name || "your band"}`;
  if (band.id && bandBusyAt(band.id, day, slot)) { toast(`${band.name || "That band"} is already booked then.`, "warn"); return; }
  if (type === "show") {
    if (billOpenSlots(venueId, day) <= 0) { toast("That bill is full that night.", "warn"); return; }
    if (!addPlayerAct(venueId, day, band)) { toast("No open slot on that bill.", "warn"); return; }
  }
  list().push({ id: "cmt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6), type, day, slot, status: "booked", title, bandId: band.id, venue: venueId });
  persist();
  emit("calendar:booked", { type, day, slot });
  emit("renderAll");
  if (type === "show") {
    const bc = billContext(venueId, day, band.id);
    const where = bc && bc.isHeadliner ? "headlining" : (bc ? `opening under ${bc.headlinerName}` : "booked");
    toast(`Booked: ${band.name || "your band"} — Day ${day}, ${where}.`, "good");
    renderScheduler();
  } else {
    toast(`Booked: ${slotLabel(slot)}, Day ${day}.`, "good");
    closeScheduler();
  }
}

// ---- calendar app (read view) ----
let calSel = null;  // {day, slot} of the tapped cell

function venueNameOf(id) { const v = DATA.venues && DATA.venues.venues && DATA.venues.venues[id]; return v ? v.name : null; }

function calDetailHTML(sel) {
  const cs = list().filter((x) => x.status !== "missed" && x.day === sel.day && x.slot === sel.slot);
  const head = `<div class="cal-detail-h">Day ${sel.day} · ${slotLabel(sel.slot)} <button class="cal-d-x" data-calclose="1">\u2715</button></div>`;
  if (!cs.length) return `<div class="cal-detail">${head}<p class="shop-note">Nothing booked this slot — it's free.</p></div>`;
  const rows = cs.map((c) => {
    const b = bandById(c.bandId); const bn = b ? (b.name || "Unnamed band") : "\u2014";
    const mine = !!(b && b.playerIn);
    const where = c.type === "show" ? (venueNameOf(c.venue) || "a venue") : "rehearsal space";
    const tag = mine ? `<span class="cal-tag mine">be there</span>` : `<span class="cal-tag mgr">auto-plays</span>`;
    return `<div class="cal-d-row"><span class="cal-d-ic">${c.type === "show" ? "\uD83C\uDFA4" : "\u266C"}</span><div class="cal-d-info"><strong>${esc(bn)}</strong><small>${c.type === "show" ? "Show" : "Rehearsal"} · ${esc(where)}</small></div>${tag}</div>`;
  }).join("");
  const mineCount = cs.filter((c) => { const b = bandById(c.bandId); return b && b.playerIn; }).length;
  let summary;
  if (mineCount > 1) summary = `<p class="cal-conflict">\u26A0 Conflict — you're in ${mineCount} acts booked this slot. You can only be one place.</p>`;
  else if (mineCount === 1) summary = `<p class="cal-where">You're in one of these — be there to play.</p>`;
  else summary = `<p class="cal-where muted">These play on their own \u2014 your report lands the next morning. Show up anyway for a performance boost.</p>`;
  return `<div class="cal-detail">${head}${rows}${summary}</div>`;
}

export function renderCalendarApp(container) {
  const horizon = Math.min(cfg().horizonDays || 7, 6);
  const cur = currentSlot();
  const cmtsAt = (d, slid) => list().filter((x) => x.status !== "missed" && x.day === d && x.slot === slid);
  const rows = [];
  for (let d = today(); d <= today() + horizon; d++) {
    const cells = slots().map((sl) => {
      const cs = cmtsAt(d, sl.id);
      const isNow = d === today() && sl.id === cur;
      const isSel = calSel && calSel.day === d && calSel.slot === sl.id;
      const hasShow = cs.some((c) => c.type === "show");
      const cls = "cal-cell" + (cs.length ? (hasShow ? " show" : " reh") : "") + (isNow ? " now" : "") + (isSel ? " sel" : "");
      let mark = "";
      if (cs.length === 1) mark = `<span class="cal-cell-t">${cs[0].type === "show" ? "\uD83C\uDFA4" : "\u266C"}</span>`;
      else if (cs.length > 1) mark = `<span class="cal-cell-n">${cs.length}</span>`;
      return `<button class="${cls}" data-day="${d}" data-slot="${sl.id}"><span class="cal-cell-sl">${sl.label.slice(0, 3)}</span>${mark}</button>`;
    }).join("");
    rows.push(`<div class="cal-row"><div class="cal-row-d">Day ${d}${d === today() ? " ·now" : ""}</div><div class="cal-row-cells">${cells}</div></div>`);
  }
  const next = nextCommitment();
  container.innerHTML = `
    <h2 class="app-title">CALENDAR</h2>
    <p class="muted cal-note">Today is <strong>Day ${today()}</strong>, ${slotLabel(cur)}. ${next ? `Next up: ${esc(next.title)} — Day ${next.day}, ${slotLabel(next.slot)}.` : "Nothing booked. Schedule rehearsals & shows from the BAND app."}</p>
    <div class="cal-grid">${rows.join("")}</div>
    ${calSel ? calDetailHTML(calSel) : `<p class="muted cal-legend">Tap any slot to see everything booked then. \u266C rehearsal · \uD83C\uDFA4 show.</p>`}`;
  container.querySelectorAll("[data-day][data-slot]").forEach((b) => b.addEventListener("click", () => {
    const d = parseInt(b.dataset.day, 10), sl = b.dataset.slot;
    calSel = (calSel && calSel.day === d && calSel.slot === sl) ? null : { day: d, slot: sl };
    renderCalendarApp(container);
  }));
  const x = container.querySelector("[data-calclose]");
  if (x) x.addEventListener("click", () => { calSel = null; renderCalendarApp(container); });
}

// ---- missed sweep ----
function sweepMissed() {
  const ni = nowIndex(); let missedShow = 0, missedReh = 0; const autoResults = [];
  for (const c of list()) {
    if (c.status !== "booked" || cmtIndex(c) >= ni) continue;
    if (c.type === "show") {
      const b = bandById(c.bandId);
      if (b && !b.playerIn) {                       // delegated: the band plays it themselves
        const res = autoResolveShow(c);
        c.status = "done";
        if (res) autoResults.push(res);
        continue;
      }
      c.status = "missed"; missedShow++;
      emit("commitment:missed", { bandId: c.bandId, type: c.type, venue: c.venue });
    } else {
      c.status = "missed"; missedReh++;
      emit("commitment:missed", { bandId: c.bandId, type: c.type, venue: c.venue });
    }
  }
  if (missedShow) { addStat("fans", -Math.min(getState().stats.fans || 0, 2 * missedShow)); toast("You blew off a booked gig. Word gets around.", "warn"); }
  if (missedReh) toast("Your band showed up to rehearse and you didn't. They're not thrilled.", "warn");
  if (autoResults.length) toast(`${autoResults.length} of your act${autoResults.length > 1 ? "s" : ""} played without you.`, "good");
  if (missedShow || missedReh || autoResults.length) { persist(); emit("renderAll"); }
  if (autoResults.length) showAutoReport(autoResults);
}

export function initCalendar() { on("day:advanced", sweepMissed); }
