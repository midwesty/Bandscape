// ============================================================
// contacts.js — the People phone app (Step 23.1). The people you
// know in the scene: bookers you've met by heading over to venues,
// friends, and the folks who get you gigs. Groundwork — relationship
// depth (favors, better slots, calls) comes in a later step.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const venueName = (id) => (DATA.venues && DATA.venues.venues && DATA.venues.venues[id] && DATA.venues.venues[id].name) || null;

export function renderContactsApp(container) {
  const cs = (getState().contacts || []).slice().sort((a, b) => (a.metDay || 0) - (b.metDay || 0));
  const rows = cs.length
    ? cs.map((c) => {
        const vn = c.venueId ? venueName(c.venueId) : null;
        const sub = [c.role, vn].filter(Boolean).join(" \u00B7 ");
        return `<div class="ct-row"><div class="ct-av">${esc((c.name || "?").slice(0, 1).toUpperCase())}</div><div class="ct-info"><strong>${esc(c.name)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</div><span class="ct-met">Day ${c.metDay || "?"}</span></div>`;
      }).join("")
    : `<p class="muted" style="padding:10px 4px">No contacts yet. Open <strong>Maps</strong> and head over to a venue to meet the person who books it.</p>`;
  container.innerHTML = `
    <h2 class="app-title">PEOPLE</h2>
    <p class="muted ct-note">The people you know in the scene \u2014 bookers, friends, and the folks who get you gigs.</p>
    <div class="ct-list">${rows}</div>`;
}
