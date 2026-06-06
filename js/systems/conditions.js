// ============================================================
// conditions.js — buffs / debuffs / statuses
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, nowHourAbs } from "../engine/state.js";
import { toast } from "../ui/toast.js";

export function addCondition(conditionId, { silent = false } = {}) {
  const def = DATA.conditions.conditions[conditionId];
  const s = getState();
  if (!def || !s) return;

  // refresh if already active
  s.conditions = s.conditions.filter((c) => c.id !== conditionId);
  s.conditions.push({ id: conditionId, untilHourAbs: nowHourAbs() + (def.durationHours || 1) });

  if (def.onApply) {
    for (const [stat, val] of Object.entries(def.onApply)) addStat(stat, val);
  }
  if (!silent && def.toast) toast(def.toast, def.kind === "debuff" ? "warn" : "good");
}

export function removeCondition(conditionId) {
  const s = getState();
  if (!s) return;
  s.conditions = s.conditions.filter((c) => c.id !== conditionId);
}

// called once per game hour by time.js
export function tickConditionsHour() {
  const s = getState();
  if (!s) return;
  for (const c of s.conditions) {
    const def = DATA.conditions.conditions[c.id];
    if (!def || !def.perHour) continue;
    for (const [stat, val] of Object.entries(def.perHour)) addStat(stat, val);
  }
}

export function pruneConditions() {
  const s = getState();
  if (!s) return;
  const now = nowHourAbs();
  s.conditions = s.conditions.filter((c) => c.untilHourAbs > now);
}

export function activeConditions() {
  const s = getState();
  if (!s) return [];
  return s.conditions.map((c) => ({ ...c, def: DATA.conditions.conditions[c.id] })).filter((c) => c.def);
}
