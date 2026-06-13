// ============================================================
// contacts.js — the People phone app. Everyone you know in the scene:
// bookers met via Maps, and anyone you've talked to. Shows your rapport
// (♥) and the perk that person offers once you're close enough — fans
// bring a crowd, owners cut you deals, connectors share tips.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, getRapport, npcPerk } from "../engine/state.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const venueName = (id) => (DATA.venues && DATA.venues.venues && DATA.venues.venues[id] && DATA.venues.venues[id].name) || null;
const pips = (r) => { const f = Math.max(0, Math.min(5, Math.round(r / 20))); return "\u2665".repeat(f) + "\u2661".repeat(5 - f); };

function perkLine(id, rap) {
  const pk = npcPerk(id); if (!pk) return "";
  const labels = { draw: "Brings a crowd", booking: "Cuts you a deal", tip: "Shares tips" };
  const label = labels[pk.type] || "Helps out";
  const need = pk.minRapport || 0;
  return rap >= need
    ? `<span class="ct-perk on">${esc(label)} \u2713</span>`
    : `<span class="ct-perk off">${esc(label)} \u00B7 rapport ${rap}/${need}</span>`;
}

export function renderContactsApp(container) {
  const cs = (getState().contacts || []).slice().sort((a, b) => getRapport(b.id) - getRapport(a.id) || (a.metDay || 0) - (b.metDay || 0));
  const rows = cs.length
    ? cs.map((c) => {
        const vn = c.venueId ? venueName(c.venueId) : null;
        const sub = [c.role, vn].filter(Boolean).join(" \u00B7 ");
        const rap = getRapport(c.id);
        return `<div class="ct-row"><div class="ct-av">${esc((c.name || "?").slice(0, 1).toUpperCase())}</div>` +
          `<div class="ct-info"><strong>${esc(c.name)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}${perkLine(c.id, rap)}</div>` +
          `<span class="ct-rap" title="rapport ${rap}">${pips(rap)}</span></div>`;
      }).join("")
    : `<p class="muted" style="padding:10px 4px">No contacts yet. Talk to people around town, or head over to a venue in <strong>Maps</strong> to meet who books it.</p>`;
  container.innerHTML = `
    <h2 class="app-title">PEOPLE</h2>
    <p class="muted ct-note">Talk to people and play their rooms to build rapport (\u2665). Get close and they start helping \u2014 crowds, deals, tips.</p>
    <div class="ct-list">${rows}</div>`;
}
