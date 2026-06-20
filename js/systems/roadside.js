// Roadside nowhere-town pickup gigs (Step 53).
// These fill the in-between nights you marked in the Tour Planner. The planning WAS the decision,
// so a marked night auto-resolves into a quick gig as you drive past it; an unmarked night just passes.
// Stops are seeded by the calendar day, so the same night always yields the same town/venue/flavor.
import { DATA } from "../engine/data.js";
import { getState, addStat } from "../engine/state.js";

// deterministic 0..1 from a seed (stable per night, no RNG state to persist)
function seeded(n) { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); }

export function roadsideStop(day) {
  const rd = DATA.roadside || {};
  const A = (rd.townNames && rd.townNames.a) || ["Lone"];
  const B = (rd.townNames && rd.townNames.b) || ["Creek"];
  const V = rd.venues || [{ name: "the only bar in town", drawMult: 0.6 }];
  const F = rd.flavor || [""];
  const base = day * 131 + 7;
  const town = `${A[Math.floor(seeded(base + 1) * A.length)]} ${B[Math.floor(seeded(base + 2) * B.length)]}`;
  const venue = V[Math.floor(seeded(base + 3) * V.length)];
  const flavor = F[Math.floor(seeded(base + 4) * F.length)];
  return { town, venue, flavor, day };
}

// Resolve one roadside gig. Modest, fame-scaled: a paycheck, a few new fans, a tick of fame,
// and it costs energy. Returns a summary for the recap card.
export function playRoadsideGig(stop) {
  const s = getState();
  const rw = (DATA.roadside && DATA.roadside.reward) || {};
  const fame = (s.stats && s.stats.fame) || 0;
  const draw = (stop.venue && stop.venue.drawMult) || 0.6;
  const wob = 0.85 + seeded(stop.day * 131 + 12) * 0.3; // small night-to-night variance
  const pay = Math.max(20, Math.round(((rw.basePay || 60) + fame * (rw.payPerFame || 1.4)) * draw * wob));
  const fans = Math.max(1, Math.round(((rw.fansBase || 4) + fame * (rw.fansPerFame || 0.15)) * draw));
  const fameUp = rw.fameUp || 1;
  addStat("money", pay);
  addStat("fans", fans);
  addStat("fame", fameUp);
  addStat("energy", -(rw.energyCost || 12));
  return { pay, fans, fameUp, town: stop.town, venue: stop.venue.name, flavor: stop.flavor };
}
