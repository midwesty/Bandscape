// ============================================================
// time.js — the clock.
//
// Schedule-I model: time advances in real time WHILE you're awake,
// but the DAY only rolls forward when you SLEEP. If you push past
// the curfew hour (small hours of the morning) you pass out and
// lose the rest of the night.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, statDef } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { tickConditionsHour, pruneConditions, addCondition } from "./conditions.js";
import { toast } from "../ui/toast.js";

let timer = null;
let running = false;

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

  for (const def of DATA.stats.stats) {
    if (def.decayPerHour) addStat(def.id, -def.decayPerHour);
  }

  const starving = (s.stats.hunger ?? 99) <= (rules.starvingHungerAt ?? 0)
                 || (s.stats.thirst ?? 99) <= (rules.starvingThirstAt ?? 0);
  if (starving) addStat("health", -(rules.healthLossPerHourWhenStarving ?? 6));
  else addStat("health", rules.healthGainPerHourWhenOk ?? 1);

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
export function sleep({ forced = false } = {}) {
  const s = getState();
  const cfg = DATA.config.time;

  s.time.day += 1;
  s.time.hour = cfg.dayStartHour;
  s.time.minute = 0;

  const energyDef = statDef("energy");
  s.stats.energy = energyDef ? energyDef.max : 100;

  if (forced) addCondition("exhausted");
  else addCondition("well_rested");

  emit("day:advanced", { day: s.time.day, forced });
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
