// ============================================================
// maps.js — the Maps phone app. Your town's venue board: each
// venue with its schedule, status (open today / next open), buzz
// meter, lock requirements, and booked shows. Undiscovered spots
// show as "leads" — head over in person to meet the booker (who
// becomes a contact) and unlock booking. Reads the calendar.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, bandById, isDiscovered, discoverVenue, addContact, townBuzz, cityUnlocked, cityDef, regionUnlocked } from "../engine/state.js";
import { ensureBills, billLineup, billOpenSlots } from "./bills.js";
import { bookedCommitments, currentDay, currentSlot, slotLabel, openScheduler, venueOpenInfo } from "./calendar.js";
import { venueEligible, venueReqText, openPerform } from "./shows.js";
import { advanceMinutes } from "./time.js";
import { saveToSlot } from "../engine/storage.js";
import { emit } from "../engine/bus.js";
import { toast } from "../ui/toast.js";

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const TOWN_NAME = { yourtown: "Your Town", rocktroit: "Rocktroit" };
const LOC_TOWN = { apartment: "yourtown", town: "yourtown", venue: "yourtown", thedive: "yourtown", rocktroit: "rocktroit", rocktroit_bar: "rocktroit", arcade: "rocktroit" };

function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function accessibleTown(t) { return cityUnlocked(t); }

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
function buzzTarget(town) {
  const vs = (DATA.venues && DATA.venues.venues) || {}; let max = 0;
  for (const id in vs) { const v = vs[id]; if (v.town === town && v.req && v.req.minBuzz) max = Math.max(max, v.req.minBuzz); }
  return max;
}

let mapsContainer = null;

function headOver(venueId) {
  const v = ((DATA.venues && DATA.venues.venues) || {})[venueId]; if (!v) return;
  advanceMinutes(75);
  discoverVenue(venueId);
  let met = "";
  if (v.booker) { const isNew = addContact(Object.assign({ venueId }, v.booker)); if (isNew) met = ` You meet ${v.booker.name}${v.booker.role ? ` (${v.booker.role})` : ""}.`; }
  persist();
  const elig = venueEligible(venueId);
  const who = (v.booker && v.booker.name) || "They";
  const tail = elig ? " You can book here now." : ` ${who} say: ${venueReqText(venueId)}.`;
  toast(`You head over to ${v.name}.${met}${tail}`, "good");
  emit("renderAll");
  if (mapsContainer) renderMapsApp(mapsContainer);
}

export function renderMapsApp(container) {
  mapsContainer = container;
  ensureBills();
  const booked = bookedCommitments();
  const shows = booked.filter((c) => c.type === "show");
  const rehs = booked.filter((c) => c.type === "rehearse");
  const here = LOC_TOWN[getState().location] || "yourtown";
  const next = booked[0];
  const venues = (DATA.venues && DATA.venues.venues) || {};
  const byTown = {};
  for (const id in venues) { const t = venues[id].town; (byTown[t] = byTown[t] || []).push(Object.assign({ id }, venues[id])); }
  const showsAtVenue = (vid) => shows.filter((c) => c.venue === vid || (vid === "thedive" && (c.venue === "venue" || c.venue == null)));

  const orderedTowns = [];
  const _regs = (DATA.regions && DATA.regions.regions) || {};
  Object.keys(_regs).sort((a, b) => (_regs[a].order || 99) - (_regs[b].order || 99)).forEach((rid) => (_regs[rid].cities || []).forEach((c) => { if (byTown[c] && accessibleTown(c) && orderedTowns.indexOf(c) < 0) orderedTowns.push(c); }));
  Object.keys(byTown).forEach((t) => { if (accessibleTown(t) && orderedTowns.indexOf(t) < 0) orderedTowns.push(t); });
  const townHTML = orderedTowns.map((t) => {
    const tgt = buzzTarget(t); const buzz = townBuzz(t);
    const meter = tgt ? `<div class="mp-buzz"><div class="mp-buzz-h">Local buzz <span>${buzz} / ${tgt}</span></div><div class="mp-buzz-bar"><i style="width:${Math.min(100, Math.round(buzz / tgt * 100))}%"></i></div></div>` : "";
    const vrows = byTown[t].map((v) => {
      if (!isDiscovered(v.id)) {
        return `<div class="mp-venue lead"><div class="mp-venue-h"><strong>${esc(v.name)}</strong><span class="mp-lead-tag">lead</span></div>${v.blurb ? `<p class="mp-blurb">${esc(v.blurb)}</p>` : ""}<button class="mp-go" data-discover="${v.id}">Head over \u25B8</button></div>`;
      }
      const info = venueOpenInfo(v.id);
      const sched = info.dayLabels ? `${info.dayLabels.join("/")} \u00B7 ${info.slotLabel}` : info.slotLabel;
      const elig = venueEligible(v.id);
      const vs = showsAtVenue(v.id);
      const evts = vs.length ? vs.map(evtRow).join("") : "";
      const status = info.openToday ? `<span class="mp-open">open today</span>` : (info.nextLabel ? `<span class="mp-next-open">next: ${esc(info.nextLabel)}</span>` : "");
      const _bd = info.openToday ? currentDay() : info.nextDay;
      const _lineup = _bd ? billLineup(v.id, _bd) : []; const _open = _bd ? billOpenSlots(v.id, _bd) : 0;
      const billHTML = _lineup.length ? `<div class="mp-bill"><span class="mp-bill-h">On the bill:</span> ${_lineup.map((a) => esc(a.name) + (a.headliner ? " (headliner)" : "") + (a.touring ? " \u2605" : "")).join(", ")}${_open > 0 ? ` <span class="mp-bill-open">· ${_open} slot${_open > 1 ? "s" : ""} open</span>` : " <span class=\"mp-bill-full\">· full</span>"}</div>` : (_bd ? `<div class="mp-bill"><span class="mp-bill-open">Bill wide open \u2014 ${billOpenSlots(v.id, _bd)} slots</span></div>` : "");
      const readyNow = vs.some((c) => c.day === currentDay() && c.slot === currentSlot());
      const action = readyNow
        ? `<button class="mp-go mp-play" data-play="${v.id}">\u25B6 Play tonight\u2019s show</button>`
        : elig
          ? `<button class="mp-go" data-book="${v.id}">Book a show \u25B8</button>`
          : `<div class="mp-lock-req">${esc(venueReqText(v.id))}</div>`;
      return `<div class="mp-venue"><div class="mp-venue-h"><strong>${esc(v.name)}</strong>${status}</div>${v.blurb ? `<p class="mp-blurb">${esc(v.blurb)}</p>` : ""}<p class="mp-sched">${esc(sched)}</p>${billHTML}${evts}${action}</div>`;
    }).join("");
    return `<div class="mp-town ${t === here ? "here" : ""}"><div class="mp-town-h">${esc((cityDef(t) && cityDef(t).name) || TOWN_NAME[t] || t)}${t === here ? ` <span class="mp-here">you are here</span>` : ""}</div>${meter}${vrows}</div>`;
  }).join("");

  const rehHTML = rehs.length
    ? `<div class="mp-town"><div class="mp-town-h">Rehearsals</div>${rehs.map(evtRow).join("")}</div>`
    : "";

  let nextHTML;
  if (next) {
    const u = urgency(next.day); const bn = bandById(next.bandId);
    const where = next.type === "show" ? ((venues[next.venue] && venues[next.venue].name) || "a venue") : "rehearsal";
    nextHTML = `<div class="mp-next ${u.cls}">Next up: <strong>${esc(bn ? bn.name : "\u2014")}</strong> \u00B7 ${esc(where)} \u00B7 ${u.label}, ${esc(slotLabel(next.slot))}</div>`;
  } else {
    nextHTML = `<p class="muted">Nothing booked. Find a spot below, then book from here or the BAND app.</p>`;
  }

  // "Coming up" — regions/cities not yet open, with how to unlock them
  let lockedHTML = "";
  { const rows = [];
    Object.keys(_regs).sort((a, b) => (_regs[a].order || 99) - (_regs[b].order || 99)).forEach((rid) => {
      const r = _regs[rid];
      if (!regionUnlocked(rid)) {
        const u = r.unlock || {}; let how = "";
        if (u.type === "masterRegion") how = `Master ${(_regs[u.region] && _regs[u.region].name) || u.region}`;
        else if (u.type === "masterAllUS") how = "Master the US regions";
        rows.push(`<div class="mp-lockreg"><strong>${esc(r.name)}</strong><span>${esc(how)}</span></div>`);
      } else {
        (r.cities || []).forEach((c) => { const cd = cityDef(c); if (cd && !cityUnlocked(c) && !byTown[c]) rows.push(`<div class="mp-lockreg sub"><strong>${esc(cd.name)}</strong><span>${esc(r.name)} \u2014 not yet open</span></div>`); });
      }
    });
    if (rows.length) lockedHTML = `<div class="mp-town mp-coming"><div class="mp-town-h">Coming up</div>${rows.join("")}</div>`;
  }
  container.innerHTML = `
    <h2 class="app-title">MAPS</h2>
    ${nextHTML}
    <p class="mp-legend"><span class="mp-dot u-now"></span> tonight <span class="mp-dot u-soon"></span> soon <span class="mp-dot u-later"></span> later</p>
    ${townHTML}
    ${rehHTML}
    ${lockedHTML}`;
  container.querySelectorAll("[data-discover]").forEach((b) => b.addEventListener("click", () => headOver(b.dataset.discover)));
  container.querySelectorAll("[data-book]").forEach((b) => b.addEventListener("click", () => openScheduler("show", b.dataset.book)));
  container.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", () => { document.getElementById("phone-close")?.click(); openPerform(b.dataset.play); }));
}
