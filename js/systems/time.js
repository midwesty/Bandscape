// ============================================================
// time.js — the clock.
//
// Schedule-I model: time advances in real time WHILE you're awake,
// but the DAY only rolls forward when you SLEEP. If you push past
// the curfew hour (small hours of the morning) you pass out and
// lose the rest of the night.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, statDef, homeVibeHere, homeAmbient, addRapport, activeBand, bandMembers } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { tickConditionsHour, pruneConditions, addCondition } from "./conditions.js";
import { toast } from "../ui/toast.js";

let timer = null;
let running = false;

// ---- player-facing time controls (pause + advance) ----
function slotsCfg() { return (DATA.config.calendar && DATA.config.calendar.slots) || []; }
export function isPaused() { return !running; }
function syncPauseBtn() { const b = document.getElementById("tc-pause"); if (b) b.textContent = running ? "⏸" : "▶"; document.body.classList.toggle("paused", !running); }
function togglePause() { const willPause = running; if (willPause) pauseClock(); else resumeClock(); syncPauseBtn(); toast(willPause ? "Paused." : "Resumed.", "info"); }
function fmtHour(h) { const hh = ((h % 24) + 24) % 24; const ap = hh < 12 ? "am" : "pm"; let d = hh % 12; if (d === 0) d = 12; return d + ap; }
export function initTimeControls() {
  const wrap = document.getElementById("hud-timectl");
  if (!wrap) return;
  wrap.innerHTML = `<button id="tc-pause" class="tc-btn" title="Pause / resume">⏸</button><button id="tc-adv" class="tc-btn" title="Advance time">⏩</button>`;
  wrap.querySelector("#tc-pause").addEventListener("click", togglePause);
  wrap.querySelector("#tc-adv").addEventListener("click", openAdvance);
  syncPauseBtn();
}
function advanceToSlot(slotId) {
  const sl = slotsCfg().find((x) => x.id === slotId); if (!sl) return;
  const s = getState(); const mins = sl.start * 60 - (s.time.hour * 60 + s.time.minute);
  if (mins <= 0) { toast("That time's already passed today.", "warn"); return; }
  advanceMinutes(mins);
  toast(`Advanced to ${sl.label}.`, "info");
}
function closeAdvance() { const ov = document.getElementById("timeskip"); if (!ov) return; ov.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => ov.classList.add("hidden"), 200); }
function openAdvance() {
  const ov = document.getElementById("timeskip"); if (!ov) return;
  const s = getState(); const nowMin = s.time.hour * 60 + s.time.minute;
  const opts = slotsCfg().filter((sl) => sl.start * 60 > nowMin);
  const body = opts.length
    ? opts.map((sl) => `<button class="ts-opt" data-slot="${sl.id}">${sl.label}<small>${fmtHour(sl.start)}</small></button>`).join("")
    : `<p class="shop-note">It's already late. Use your bed to sleep and start a fresh day.</p>`;
  ov.innerHTML = `<div class="ts-modal"><div class="shop-head"><span class="shop-title">ADVANCE TIME</span><button class="phone-nav" id="ts-x">✕</button></div>
    <div class="ts-body"><p class="shop-note">Skip ahead to the start of…</p>${body}<button class="btn" id="ts-cancel">Cancel</button></div></div>`;
  ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("open")); document.body.classList.add("modal-open");
  ov.querySelector("#ts-x").addEventListener("click", closeAdvance);
  ov.querySelector("#ts-cancel").addEventListener("click", closeAdvance);
  ov.querySelectorAll(".ts-opt").forEach((b) => b.addEventListener("click", () => { advanceToSlot(b.dataset.slot); closeAdvance(); }));
}

export function startClock() {
  const cfg = DATA.config.time;
  if (timer) clearInterval(timer);
  running = true;
  timer = setInterval(tickMinute, cfg.realMsPerGameMinute);
}

export function pauseClock() { running = false; }
export function resumeClock() { running = true; }
export function stopClock() { running = false; if (timer) clearInterval(timer); timer = null; }

function tickMinute() {
  if (!running) return;
  const s = getState();
  if (!s) return;

  s.time.minute += 1;
  if (s.time.minute >= 60) {
    s.time.minute = 0;
    s.time.hour += 1;
    onHour();
    if (s.time.hour >= 24) s.time.hour = 0; // wraps past midnight; day does NOT advance here
  }

  emit("time:tick", { time: s.time });
  emit("renderAll");
  checkCurfew();
}

function onHour() {
  const s = getState();
  const rules = DATA.stats.healthRules || {};

  const homeVibe = homeVibeHere();              // Step 26.1: a comfortable home eases hunger/thirst/energy drain
  const ease = homeVibe > 0 ? Math.max(0.5, 1 - homeVibe / 60) : 1;
  for (const def of DATA.stats.stats) {
    if (!def.decayPerHour) continue;
    addStat(def.id, -(def.kind === "need" ? def.decayPerHour * ease : def.decayPerHour));
  }

  const starving = (s.stats.hunger ?? 99) <= (rules.starvingHungerAt ?? 0)
                 || (s.stats.thirst ?? 99) <= (rules.starvingThirstAt ?? 0);
  if (starving) addStat("health", -(rules.healthLossPerHourWhenStarving ?? 6));
  else addStat("health", rules.healthGainPerHourWhenOk ?? 1);
  const well = homeAmbient("wellness"); if (well > 0) addStat("health", Math.min(3, Math.round(well * 0.18)));   // Step 27.3 plants
  const ambMood = homeAmbient("mood"); if (ambMood > 0) addStat("mood", Math.min(3, Math.round(ambMood * 0.18)));

  tickConditionsHour();
  pruneConditions();

  if ((s.stats.health ?? 1) <= 0) emit("player:collapsed", { reason: "health" });
}

// The small hours: hour wrapped past midnight and reached curfew.
function checkCurfew() {
  const s = getState();
  const curfew = DATA.config.time.curfewHour;
  // hour is 0..23; curfew like 4 means 4am. Only triggers in the early-morning window.
  if (s.time.hour === curfew && s.time.minute === 0) {
    toast("You can't keep your eyes open any longer…", "warn");
    sleep({ forced: true });
  }
}

// Sleep: the only way the day advances. Restores energy, sets morning, autosaves.
export function sleep({ forced = false, poor = false } = {}) {
  const s = getState();
  const cfg = DATA.config.time;

  s.time.day += 1;
  s.time.hour = cfg.dayStartHour;
  s.time.minute = 0;

  const energyDef = statDef("energy");
  s.stats.energy = energyDef ? energyDef.max : 100;

  if (forced) addCondition("exhausted");        // involuntary collapse (curfew / health)
  else if (!poor) addCondition("well_rested");  // a rough (poor) night is CHOSEN, not a collapse — no exhausted, no well-rested

  const bonus = !forced && !poor;               // home comforts only reward a proper bed
  const homeVibe = homeVibeHere();              // Step 26.1: décor pays off when you rest at home
  if (homeVibe > 0 && bonus) { addStat("mood", Math.min(12, Math.round(homeVibe * 0.4))); addStat("health", Math.min(6, Math.round(homeVibe * 0.2))); }
  const rest = homeAmbient("rest"); if (rest > 0 && bonus) { addStat("mood", Math.min(8, Math.round(rest * 0.4))); addStat("health", Math.min(4, Math.round(rest * 0.2))); }  // Step 27.3
  const social = homeAmbient("social"); if (social > 0 && bonus) { const ab = activeBand(); if (ab) for (const m of bandMembers(ab.id)) addRapport(m.id, Math.min(3, Math.round(social * 0.25))); }  // your place is the hang
  if (poor) addStat("mood", -4);                // a cramped van bunk is no fun

  // Overnight your needs still drain (~sleepDrainHours of hunger/thirst). A comfy home eases it; a rough van bunk drains a touch more.
  const ease = homeVibe > 0 ? Math.max(0.5, 1 - homeVibe / 60) : 1;
  const nightHours = cfg.sleepDrainHours || 8;
  const drainMult = poor ? 1.25 : ease;
  for (const def of DATA.stats.stats) {
    if (def.kind === "need" && def.decayPerHour) addStat(def.id, -(def.decayPerHour * nightHours * drainMult));
  }

  if (poor) toast("A rough night in the van — you're up, but stiff.", "info");
  emit("day:advanced", { day: s.time.day, forced });
  emit("renderAll");
}

// Ride along (stay awake) for N travel days. Unlike sleep(): no energy restore, no well-rested —
// you're up in the cab the whole way, so energy/needs drain and you arrive with the evening ahead
// (so an arrival-day show is still playable). Rolls the day each leg so the world ticks normally
// (bills, and the missed-show sweep — which is fine, the Drive menu warned about any missed shows).
export function travelAwake(days) {
  const s = getState(); const cfg = DATA.config.time;
  const tcfg = (DATA.config.travel || {});
  const perDay = tcfg.rideAlongEnergyPerDay != null ? tcfg.rideAlongEnergyPerDay : 35;
  const dayHours = (cfg.sleepDrainHours || 8) * 1.5;   // awake far longer than a night
  for (let d = 0; d < days; d++) {
    s.time.day += 1;
    addStat("energy", -perDay);
    for (const def of DATA.stats.stats) {
      if (def.kind === "need" && def.decayPerHour) addStat(def.id, -(def.decayPerHour * dayHours));
    }
    emit("day:advanced", { day: s.time.day, forced: false });
  }
  s.time.hour = tcfg.arriveHour != null ? tcfg.arriveHour : 15;   // pull in mid-afternoon
  s.time.minute = 0;
  if ((s.stats.energy || 0) <= 0) addCondition("exhausted");      // ran yourself ragged on the road
  emit("renderAll");
}

// Advance the clock by N minutes (busking, traveling, activities). Rolls hours
// (with hourly decay/conditions) but never advances the day — only sleep does.
export function advanceMinutes(mins) {
  const s = getState();
  if (!s) return;
  for (let i = 0; i < mins; i++) {
    s.time.minute += 1;
    if (s.time.minute >= 60) { s.time.minute = 0; s.time.hour += 1; onHour(); if (s.time.hour >= 24) s.time.hour = 0; }
  }
  emit("time:tick", { time: s.time });
  emit("renderAll");
  checkCurfew();
}

export function timeString() {
  const s = getState();
  if (!s) return "--:--";
  const h = s.time.hour;
  const m = String(s.time.minute).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m} ${ampm}`;
}
