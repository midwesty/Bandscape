// ============================================================
// objectives.js — tutorial + quest engine.
// Objectives complete when their trigger event fires (and any
// 'match' fields line up). Completing one can unlock others and
// grant rewards. Renders into the phone's TASKS app.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat } from "../engine/state.js";
import { on, emit } from "../engine/bus.js";
import { toast } from "../ui/toast.js";

let initialized = false;

export function initObjectives() {
  const s = getState();
  if (!s.objectives) s.objectives = { active: [], completed: [] };

  // Seed any objectives marked active in the data file (first run only).
  if (s.objectives.active.length === 0 && s.objectives.completed.length === 0) {
    for (const o of DATA.objectives.objectives) {
      if (o.active) s.objectives.active.push(o.id);
    }
  }

  if (!initialized) {
    initialized = true;
    // One global listener watches all events that objectives care about.
    const TRIGGERS = new Set(DATA.objectives.objectives.map((o) => o.trigger));
    for (const t of TRIGGERS) {
      on(t, (detail) => checkTrigger(t, detail));
    }
  }
}

function def(id) { return DATA.objectives.objectives.find((o) => o.id === id); }

function matches(o, detail) {
  if (!o.match) return true;
  return Object.entries(o.match).every(([k, v]) => detail?.[k] === v);
}

function checkTrigger(triggerName, detail) {
  const s = getState();
  if (!s) return;
  for (const id of [...s.objectives.active]) {
    const o = def(id);
    if (!o || o.trigger !== triggerName) continue;
    if (matches(o, detail)) completeObjective(id);
  }
}

export function completeObjective(id) {
  const s = getState();
  const o = def(id);
  if (!o || s.objectives.completed.includes(id)) return;

  s.objectives.active = s.objectives.active.filter((x) => x !== id);
  s.objectives.completed.push(id);

  if (o.reward) for (const [stat, val] of Object.entries(o.reward)) addStat(stat, val);

  for (const unlockId of (o.unlocks || [])) {
    if (!s.objectives.active.includes(unlockId) && !s.objectives.completed.includes(unlockId)) {
      s.objectives.active.push(unlockId);
    }
  }

  toast(`✓ ${o.title}`, "good");
  emit("objective:completed", { id });
  emit("renderAll");

  if (id === "obj_sleep") { s._step1Complete = true; emit("step:complete", { step: 1 }); }
}

// ---- TASKS app UI ----
export function renderTasksApp(container) {
  const s = getState();
  if (!container || !s) return;

  const active = s.objectives.active.map(def).filter(Boolean).filter((o) => !o.locked);
  const locked = s.objectives.active.map(def).filter(Boolean).filter((o) => o.locked);
  const done = s.objectives.completed.map(def).filter(Boolean);

  container.innerHTML = `
    <h2 class="app-title">TASKS</h2>
    ${active.length ? active.map(taskRow).join("") : `<p class="muted">Nothing pressing. Suspicious.</p>`}
    ${locked.map(lockedRow).join("")}
    ${done.length ? `<div class="task-done-head">DONE</div>${done.map(doneRow).join("")}` : ""}
  `;
}

function taskRow(o) {
  return `
    <div class="task ${o.optional ? "task-optional" : ""}">
      <div class="task-check"></div>
      <div class="task-body">
        <div class="task-title">${o.title}${o.optional ? ' <span class="tag">optional</span>' : ""}</div>
        <div class="task-desc">${o.desc}</div>
      </div>
    </div>`;
}
function lockedRow(o) {
  return `
    <div class="task task-locked">
      <div class="task-check task-check-locked">🔒</div>
      <div class="task-body">
        <div class="task-title">${o.title}</div>
        <div class="task-desc">${o.desc}</div>
      </div>
    </div>`;
}
function doneRow(o) {
  return `
    <div class="task task-completed">
      <div class="task-check task-check-done">✓</div>
      <div class="task-body"><div class="task-title">${o.title}</div></div>
    </div>`;
}
