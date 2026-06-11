// ============================================================
// maps.js — the Maps phone app (Step 18.4). A schematic of your
// world: each city's venues, with markers for booked shows
// color-coded by urgency, a "next up" banner, and a "you are
// here" tag. Reads the calendar; no navigation yet.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, bandById } from "../engine/state.js";
import { bookedCommitments, currentDay, slotLabel } from "./calendar.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const TOWN_NAME = { yourtown: "Your Town", rocktroit: "Rocktroit" };
const LOC_TOWN = { apartment: "yourtown", town: "yourtown", venue: "yourtown", thedive: "yourtown", rocktroit: "rocktroit", rocktroit_bar: "rocktroit", arcade: "rocktroit" };

function urgency(day) {
  const dd = day - currentDay();
  if (dd <= 0) return { cls: "u-now", label: "tonight" };
  if (dd === 1) return { cls: "u-soon", label: "tomorrow" };
  if (dd <= 3) return { cls: "u-soon", label: `in ${dd} days` };
  return { cls: "u-later", label: `Day ${day}` };
}

function evtRow(c) {
  const u = urgency(c.day); const b = bandById(c.bandId);
  return `<div class="mp-evt ${u.cls}"><span class="mp-dot ${u.cls}"></span><span class="mp-evt-band">${esc(b ? b.name : "\u2014")}</span><span class="mp-evt-when">${u.label}, ${esc(slotLabel(c.slot))}</span></div>`;
}

export function renderMapsApp(container) {
  const booked = bookedCommitments();
  const shows = booked.filter((c) => c.type === "show");
  const rehs = booked.filter((c) => c.type === "rehearse");
  const here = LOC_TOWN[getState().location] || "yourtown";
  const next = booked[0];
  const venues = (DATA.venues && DATA.venues.venues) || {};

  const byTown = {};
  for (const id in venues) { const t = venues[id].town; (byTown[t] = byTown[t] || []).push(Object.assign({ id }, venues[id])); }
  const showsAtVenue = (vid) => shows.filter((c) => c.venue === vid || (vid === "thedive" && (c.venue === "venue" || c.venue == null)));

  const townHTML = ["yourtown", "rocktroit"].filter((t) => byTown[t]).map((t) => {
    const vrows = byTown[t].map((v) => {
      const vs = showsAtVenue(v.id);
      const body = vs.length ? vs.map(evtRow).join("") : `<div class="mp-evt mp-empty">no shows booked</div>`;
      const lock = v.open ? "" : `<span class="mp-lock">locked</span>`;
      return `<div class="mp-venue"><div class="mp-venue-h"><strong>${esc(v.name)}</strong>${lock}</div>${body}</div>`;
    }).join("");
    return `<div class="mp-town ${t === here ? "here" : ""}"><div class="mp-town-h">${esc(TOWN_NAME[t] || t)}${t === here ? ` <span class="mp-here">you are here</span>` : ""}</div>${vrows}</div>`;
  }).join("");

  const rehHTML = rehs.length
    ? `<div class="mp-town"><div class="mp-town-h">Rehearsals</div>${rehs.map(evtRow).join("")}</div>`
    : "";

  let nextHTML;
  if (next) {
    const u = urgency(next.day); const bn = bandById(next.bandId);
    const where = next.type === "show" ? ((venues[next.venue] && venues[next.venue].name) || "a venue") : "rehearsal";
    nextHTML = `<div class="mp-next ${u.cls}">Next up: <strong>${esc(bn ? bn.name : "\u2014")}</strong> · ${esc(where)} · ${u.label}, ${esc(slotLabel(next.slot))}</div>`;
  } else {
    nextHTML = `<p class="muted">Nothing booked. Line up shows from the BAND app.</p>`;
  }

  container.innerHTML = `
    <h2 class="app-title">MAPS</h2>
    ${nextHTML}
    <p class="mp-legend"><span class="mp-dot u-now"></span> tonight <span class="mp-dot u-soon"></span> soon <span class="mp-dot u-later"></span> later</p>
    ${townHTML}
    ${rehHTML}`;
}
