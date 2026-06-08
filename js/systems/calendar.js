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
import { getState, addStat, activeBand, bandMembers } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";

let overlay = null;

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
function venueOpen(day) { return (((day * 2654435761) >>> 0) % 3) !== 0; }
function bandAvailableCount(slot) {
  const npcs = DATA.npcs.npcs || []; const ab = activeBand(); const mem = ab ? bandMembers(ab.id) : [];
  return mem.filter((m) => { const n = npcs.find((x) => x.id === m.id); return n && (n.availability || []).includes(slot); }).length;
}

export function findReady(type, bandId) { return list().find((c) => c.status === "booked" && c.type === type && (!bandId || c.bandId === bandId) && c.day === today() && c.slot === currentSlot()) || null; }
export function nextCommitment(type, bandId) {
  const ni = nowIndex();
  return list().filter((c) => c.status === "booked" && (!type || c.type === type) && (!bandId || c.bandId === bandId) && cmtIndex(c) >= ni).sort((a, b) => cmtIndex(a) - cmtIndex(b))[0] || null;
}
export function complete(id) { const c = list().find((x) => x.id === id); if (c) { c.status = "done"; persist(); emit("calendar:updated"); } }

function availableSlots(type) {
  const out = []; const horizon = cfg().horizonDays || 7; const ni = nowIndex();
  const ab = activeBand(); const mem = (ab ? bandMembers(ab.id) : []).length;
  for (let d = today(); d <= today() + horizon; d++) {
    for (const sl of slots()) {
      const idx = d * nUnits() + slotIndex(sl.id);
      if (idx < ni) continue;
      if (bookedAt(d, sl.id)) continue;
      if (type === "show") { if (sl.id !== (cfg().showSlot || "evening")) continue; if (!venueOpen(d)) continue; }
      else if (type === "rehearse") { if (!mem) continue; if (bandAvailableCount(sl.id) < Math.ceil(mem / 2)) continue; }
      out.push({ day: d, slot: sl.id, label: sl.label });
      if (out.length >= 16) return out;
    }
  }
  return out;
}

// ---- scheduler picker ----
export function openScheduler(type) {
  const opts = availableSlots(type);
  overlay = overlay || document.getElementById("cal");
  const title = type === "show" ? "BOOK A SHOW" : "SCHEDULE REHEARSAL";
  const sub = type === "show" ? "The Dive's open nights. Be there that evening to play." : "Open slots where enough of your band is free. Show up to rehearse.";
  const byDay = {};
  opts.forEach((o) => { (byDay[o.day] = byDay[o.day] || []).push(o); });
  const daysHTML = Object.keys(byDay).length
    ? Object.entries(byDay).map(([d, arr]) => `
        <div class="cal-day"><div class="cal-day-h">Day ${d}${+d === today() ? " · today" : ""}</div>
          <div class="cal-slots">${arr.map((o) => `<button class="cal-slot-btn" data-day="${o.day}" data-slot="${o.slot}">${esc(o.label)}</button>`).join("")}</div></div>`).join("")
    : `<p class="shop-note">No open slots ${type === "show" ? "at the venue" : "for the band"} in the next while. ${type === "show" ? "Check back another day." : "Your bandmates aren't free — try a different week."}</p>`;
  overlay.innerHTML = `
    <div class="cal-modal">
      <div class="shop-head"><span class="shop-title">${title}</span><button class="phone-nav" id="cal-close">✕</button></div>
      <div class="cal-body"><p class="shop-note">${sub}</p>${daysHTML}</div>
    </div>`;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  overlay.querySelector("#cal-close").addEventListener("click", closeScheduler);
  overlay.querySelectorAll(".cal-slot-btn").forEach((b) => b.addEventListener("click", () => book(type, parseInt(b.dataset.day, 10), b.dataset.slot)));
}
function closeScheduler() {
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}
function book(type, day, slot) {
  const band = activeBand() || {};
  const title = type === "show" ? `Show · ${band.name || "your band"} @ The Dive` : `Rehearsal · ${band.name || "your band"}`;
  list().push({ id: "cmt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6), type, day, slot, status: "booked", title, bandId: band.id, venue: type === "show" ? "venue" : null });
  persist();
  emit("calendar:booked", { type, day, slot });
  emit("renderAll");
  toast(`Booked: ${slotLabel(slot)}, Day ${day}.`, "good");
  closeScheduler();
}

// ---- calendar app (read view) ----
export function renderCalendarApp(container) {
  const horizon = Math.min(cfg().horizonDays || 7, 6);
  const cur = currentSlot();
  const rows = [];
  for (let d = today(); d <= today() + horizon; d++) {
    const cells = slots().map((sl) => {
      const c = list().find((x) => x.status !== "missed" && x.day === d && x.slot === sl.id);
      const isNow = d === today() && sl.id === cur;
      const cls = c ? (c.type === "show" ? "cal-cell show" : "cal-cell reh") : "cal-cell";
      return `<div class="${cls} ${isNow ? "now" : ""}"><span class="cal-cell-sl">${sl.label.slice(0, 3)}</span>${c ? `<span class="cal-cell-t">${c.type === "show" ? "🎤" : "♬"}</span>` : ""}</div>`;
    }).join("");
    rows.push(`<div class="cal-row"><div class="cal-row-d">Day ${d}${d === today() ? " ·now" : ""}</div><div class="cal-row-cells">${cells}</div></div>`);
  }
  const next = nextCommitment();
  container.innerHTML = `
    <h2 class="app-title">CALENDAR</h2>
    <p class="muted cal-note">Today is <strong>Day ${today()}</strong>, ${slotLabel(cur)}. ${next ? `Next up: ${esc(next.title)} — Day ${next.day}, ${slotLabel(next.slot)}.` : "Nothing booked. Schedule rehearsals & shows from the BAND app."}</p>
    <div class="cal-grid">${rows.join("")}</div>
    <p class="muted cal-legend">♬ rehearsal · 🎤 show (be at The Dive). Book from the BAND app.</p>`;
}

// ---- missed sweep ----
function sweepMissed() {
  const ni = nowIndex(); let missedShow = 0, missedReh = 0;
  for (const c of list()) {
    if (c.status === "booked" && cmtIndex(c) < ni) {
      c.status = "missed";
      if (c.type === "show") missedShow++; else missedReh++;
      emit("commitment:missed", { bandId: c.bandId, type: c.type });
    }
  }
  if (missedShow) { addStat("fans", -Math.min(getState().stats.fans || 0, 2 * missedShow)); toast("You blew off a booked gig at The Dive. Word gets around.", "warn"); }
  if (missedReh) toast("Your band showed up to rehearse and you didn't. They're not thrilled.", "warn");
  if (missedShow || missedReh) { persist(); emit("renderAll"); }
}

export function initCalendar() { on("day:advanced", sweepMissed); }
