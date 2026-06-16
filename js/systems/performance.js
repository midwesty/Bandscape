// performance.js — Step 28 Performance Arc engine.
// A set is a sequence; each song costs stamina; the band tires as a unit but the
// weakest-endurance member gasses first and caps the set. Quality degrades with
// fatigue; pushing past empty risks collapse. Pure-ish: reads DATA + state only
// (no import from shows.js) so there's no circular dependency.
import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";

const PCFG = () => DATA.config.performance || {};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function playerEndurance() {
  const s = getState();
  return (s && s.stats && s.stats.endurance != null) ? s.stats.endurance : (PCFG().playerStartEndurance || 50);
}

// Prep buffs (a hot meal, coffee, a good night's sleep, a shower) add headroom.
function buffPoolBonus() {
  const s = getState(); const map = PCFG().buffPoolBonus || {}; let b = 0;
  for (const c of (s && s.conditions) || []) if (map[c.id]) b += map[c.id];
  return b;
}

// The player's stamina pool at downbeat — Energy scaled by Endurance, lifted by mood + prep.
export function playerStamina() {
  const c = PCFG(); const s = getState();
  const energy = (s && s.stats && s.stats.energy != null) ? s.stats.energy : 70;
  const mood = (s && s.stats && s.stats.mood != null) ? s.stats.mood : 55;
  const base = (c.staminaBase || 100) * (playerEndurance() / (c.enduranceRef || 50));
  const eShare = c.energyShareForPool != null ? c.energyShareForPool : 0.7;
  const energyFactor = eShare * (energy / 100) + (1 - eShare);
  const moodBonus = (c.moodPoolFactor || 0.15) * ((mood - 50) / 50);
  return Math.max(8, Math.round(base * energyFactor * (1 + moodBonus + buffPoolBonus())));
}

// An NPC member's pool — driven by their Endurance, readiness scaled by happiness.
export function memberStamina(m) {
  const c = PCFG(); const st = (m && m.stats) || {};
  const end = st.endurance != null ? st.endurance : 50;
  const happy = m && m.happiness != null ? m.happiness : 70;
  const readiness = (c.npcReadiness != null ? c.npcReadiness : 0.85) * (0.7 + 0.3 * (happy / 100));
  return Math.max(8, Math.round((c.staminaBase || 100) * (end / (c.enduranceRef || 50)) * readiness));
}

function songStaminaCost(bars) {
  const c = PCFG(); const def = c.defaultBars || 16;
  const lenFactor = 1 + (c.lengthCostScale || 0.5) * (((bars || def) / def) - 1);
  return Math.max(4, (c.songCost || 17) * lenFactor);
}

function genreFitMult(setGenre, venuePref) {
  const g = PCFG().genreFit || {};
  if (!venuePref || !setGenre) return 1;
  return String(setGenre).toLowerCase() === String(venuePref).toLowerCase()
    ? 1 + (g.match || 0.1) : 1 + (g.mismatch || -0.08);
}

// Walk the set song by song. roll=true actually gambles in the risk zone (real show);
// roll=false is the deterministic projection used by the booking planner.
export function simulateSet(opts) {
  const c = PCFG();
  const songs = opts.songs || [];
  const performers = (opts.performers || []).map((p) => ({ name: p.name, max: Math.max(8, p.max || 50), cur: Math.max(8, p.max || 50), isPlayer: !!p.isPlayer }));
  const gf = genreFitMult(opts.setGenre, opts.venuePref);
  const sloppyT = c.sloppyThreshold != null ? c.sloppyThreshold : 0.35;
  const riskT = c.riskThreshold != null ? c.riskThreshold : 0.15;
  const floor = c.fatigueFloor != null ? c.fatigueFloor : 0.45;
  const maxCC = c.maxCollapseChance != null ? c.maxCollapseChance : 0.7;
  const perSong = []; let collapsed = false, collapsedAt = -1, playedCount = 0, realizedSum = 0;

  for (let i = 0; i < songs.length; i++) {
    const cost = songStaminaCost(songs[i].bars);
    performers.forEach((p) => { p.cur -= cost; });
    let minFrac = 1, weakest = null;
    performers.forEach((p) => { const f = p.cur / p.max; if (f < minFrac) { minFrac = f; weakest = p; } });

    let fat = 1;
    if (minFrac < sloppyT) fat = floor + (1 - floor) * clamp(minFrac / sloppyT, 0, 1);
    let state = "strong", collapseChance = 0;
    if (minFrac <= 0) state = "collapse";
    else if (minFrac < riskT) { state = "risk"; collapseChance = maxCC * (1 - minFrac / riskT); }
    else if (minFrac < sloppyT) state = "sloppy";

    const q = clamp(Math.round(songs[i].q * fat * gf), 0, 100);
    const entry = { i, q, state, collapseChance: Math.round(collapseChance * 100), minFrac: Math.round(Math.max(0, minFrac) * 100), weakest: weakest && weakest.name };

    if (state === "collapse") { collapsed = true; collapsedAt = i; perSong.push(entry); break; }
    if (state === "risk" && opts.roll && Math.random() < collapseChance) {
      collapsed = true; collapsedAt = i; entry.rolledCollapse = true;
      perSong.push(entry); realizedSum += q; playedCount++; break;
    }
    perSong.push(entry); realizedSum += q; playedCount++;
  }

  let safeLimit = 0;
  for (const e of perSong) { if (e.state === "strong") safeLimit++; else break; }
  const realizedQ = playedCount ? Math.round(realizedSum / playedCount) : 0;
  return { perSong, playedCount, collapsed, collapsedAt, safeLimit, realizedQ, tier: tierFor(realizedQ, collapsed), genreFit: gf };
}

export function tierFor(q, collapsed) {
  if (collapsed) return "Collapse";
  const tiers = (PCFG().tiers || []).slice().sort((a, b) => b.min - a.min);
  for (const t of tiers) if (q >= t.min) return t.name;
  return tiers.length ? tiers[tiers.length - 1].name : "Solid";
}

export function tierMult(name) {
  if (name === "Collapse") {
    const col = PCFG().collapse || {};
    return { name, pay: col.payMult != null ? col.payMult : 0.85, fans: col.fansMult != null ? col.fansMult : 0.35, fame: col.fameMult != null ? col.fameMult : 0.4, rep: col.rep != null ? col.rep : -3, collapse: true };
  }
  const t = (PCFG().tiers || []).find((x) => x.name === name) || { pay: 1, fans: 1, fame: 1, rep: 1 };
  return { name, pay: t.pay, fans: t.fans, fame: t.fame, rep: t.rep };
}

export const TIER_FLAVOR = {
  Legendary: "Legendary set — the room lost it.",
  Great: "Great show — the crowd ate it up.",
  Solid: "Solid set, tight and clean.",
  Sloppy: "Sloppy — you ran out of gas and it showed.",
  Disaster: "Rough night. The set fell apart.",
  Collapse: "You gassed out mid-set — the show was cut short."
};
