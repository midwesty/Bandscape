// ============================================================
// hud.js — the minimal always-on HUD.
// Reads stats.json to decide which stats show + their colors.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";
import { timeString } from "./time.js";

export function renderHUD() {
  const s = getState();
  if (!s) return;

  // clock
  const clock = document.getElementById("hud-clock");
  if (clock) clock.innerHTML = `<span class="hud-day">DAY ${s.time.day}</span><span class="hud-time">${timeString()}</span>`;

  // cash (resource flagged hud)
  const cashWrap = document.getElementById("hud-cash");
  const moneyDef = DATA.stats.stats.find((d) => d.id === "money");
  if (cashWrap && moneyDef) {
    cashWrap.textContent = `${moneyDef.prefix || ""}${Math.floor(s.stats.money ?? 0)}`;
  }

  // need pips
  const pips = document.getElementById("hud-pips");
  if (pips) {
    const needs = DATA.stats.stats
      .filter((d) => d.hud && d.kind !== "resource")
      .sort((a, b) => (a.hudOrder ?? 99) - (b.hudOrder ?? 99));

    pips.innerHTML = needs.map((d) => {
      const val = Math.round(s.stats[d.id] ?? 0);
      const pct = Math.max(0, Math.min(100, (val / (d.max || 100)) * 100));
      const low = d.lowWarn >= 0 && val <= d.lowWarn;
      return `
        <div class="pip ${low ? "pip-low" : ""}" title="${d.label}: ${val}">
          <div class="pip-label">${d.label}</div>
          <div class="pip-track"><div class="pip-fill" style="width:${pct}%;background:${d.color}"></div></div>
        </div>`;
    }).join("");
  }
}
