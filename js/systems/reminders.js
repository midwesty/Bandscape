// ============================================================
// reminders.js — keeps booked nights from slipping past you
// (Step 18.5). A morning digest of today's obligations, and a
// "head over" alert the moment a slot with one of YOUR shows/
// rehearsals begins. Only for bands you're in — manager-only
// bands auto-resolve, so they don't need nagging.
// ============================================================

import { on } from "../engine/bus.js";
import { toast } from "../ui/toast.js";
import { DATA } from "../engine/data.js";
import { getState, bandById } from "../engine/state.js";
import { bookedCommitments, currentDay, currentSlot, slotLabel } from "./calendar.js";

let last = null; // last seen { day, slot }

const playerIn = (bandId) => { const b = bandById(bandId); return !!(b && b.playerIn); };
const bandName = (bandId) => { const b = bandById(bandId); return b ? (b.name || "your band") : "your band"; };
const venueName = (id) => (DATA.venues && DATA.venues.venues && DATA.venues.venues[id] && DATA.venues.venues[id].name) || "the venue";

function slotReminders(day, slot) {
  const items = bookedCommitments().filter((c) => c.day === day && c.slot === slot && playerIn(c.bandId));
  for (const c of items) {
    if (c.type === "show") toast(`Showtime — ${bandName(c.bandId)} at ${venueName(c.venue)}. Get to the venue and play.`, "warn");
    else toast(`Rehearsal now — ${bandName(c.bandId)} is waiting at the practice space.`, "warn");
  }
}

function dailyDigest() {
  const day = currentDay();
  const items = bookedCommitments().filter((c) => c.day === day && playerIn(c.bandId));
  if (!items.length) return;
  const parts = items
    .sort((a, b) => (a.slot > b.slot ? 1 : -1))
    .map((c) => `${c.type === "show" ? "show" : "rehearsal"} (${slotLabel(c.slot)})`);
  toast(`Today's lineup: ${parts.join(" · ")}. Don't be late.`, "info");
}

export function initReminders() {
  on("time:tick", () => {
    const cur = { day: currentDay(), slot: currentSlot() };
    if (last && (cur.day !== last.day || cur.slot !== last.slot)) slotReminders(cur.day, cur.slot);
    last = cur;
  });
  on("day:advanced", () => { last = { day: currentDay(), slot: currentSlot() }; dailyDigest(); });
}
