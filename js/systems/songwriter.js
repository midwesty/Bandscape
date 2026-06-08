// ============================================================
// songwriter.js — NPC / band songwriting generator (Step 13).
//
// Produces real loops in the canonical note model (notes.js), so
// everything a band writes is playable in the DAW and editable in
// the piano roll. Output quality/complexity scales with the best
// songwriter's stat and the band's genre (which picks a scale).
// Leaf-ish: imports only engine + notes, never band/shows/calendar.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, performingMembers } from "../engine/state.js";
import { midiOf } from "./notes.js";

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10]
};
const GENRE_FEEL = { punk: "minor", pop: "major", rock: "mixolydian", jazz: "dorian", folk: "major", metal: "minor", funk: "dorian", electronic: "minor", country: "major", blues: "minor" };
const PROGS = [[0, 3, 4, 3], [0, 4, 5, 3], [0, 5, 3, 4], [0, 0, 3, 4], [5, 3, 0, 4], [0, 4, 0, 4]]; // diatonic degrees
const ROLE_INST = { guitar: "guitar", bass: "bass", drums: "drums", piano: "piano", vocals: null };

function triad(scale, deg) {
  return [0, 2, 4].map((i) => { const idx = deg + i; return scale[idx % scale.length] + 12 * Math.floor(idx / scale.length); });
}
function genMelodic(rootBase, scale, prog, bars, spb, bpb, skill) {
  const notes = [];
  for (let b = 0; b < bars; b++) {
    const deg = prog[b % prog.length], tri = triad(scale, deg), bs = b * bpb * spb;
    tri.forEach((semi, i) => notes.push({ start: bs, length: spb, pitch: rootBase + semi, vel: i === 0 ? 0.7 : 0.5 }));
    for (let beat = 1; beat < bpb; beat++) {
      if (Math.random() < 0.35 + skill * 0.5) {
        const semi = tri[Math.floor(Math.random() * tri.length)] + (Math.random() < skill * 0.5 ? 12 : 0);
        const len = Math.random() < skill ? Math.max(1, Math.floor(spb / 2)) : spb;
        notes.push({ start: bs + beat * spb, length: len, pitch: rootBase + 12 + semi, vel: 0.85 });
      }
    }
  }
  return notes;
}
function genBass(rootBase, scale, prog, bars, spb, bpb, skill) {
  const notes = [];
  for (let b = 0; b < bars; b++) {
    const deg = prog[b % prog.length], root = scale[deg % scale.length], bs = b * bpb * spb;
    notes.push({ start: bs, length: spb * 2, pitch: rootBase + root, vel: 0.9 });
    notes.push({ start: bs + spb * 2, length: spb * 2, pitch: rootBase + root + (Math.random() < skill ? 7 : 0), vel: 0.8 });
  }
  return notes;
}
function genDrums(bars, spb, bpb, skill) {
  const notes = [], half = Math.max(1, Math.floor(spb / 2));
  for (let b = 0; b < bars; b++) {
    const bs = b * bpb * spb;
    for (let beat = 0; beat < bpb; beat++) {
      const t = bs + beat * spb;
      notes.push({ start: t, length: 1, piece: beat % 2 === 0 ? "kick" : "snare" });
      for (let h = 0; h < spb; h += half) notes.push({ start: t + h, length: 1, piece: "hihat" });
      if (Math.random() < skill * 0.3) notes.push({ start: t + half, length: 1, piece: "kick" });
    }
    if (Math.random() < skill * 0.5) notes.push({ start: bs + bpb * spb - 1, length: 1, piece: "crash" });
  }
  return notes;
}
function bandInstruments(band) {
  const set = new Set();
  for (const m of performingMembers(band.id)) { const inst = ROLE_INST[m.role]; if (inst) set.add(inst); }
  if (band.playerIn) { const eq = getState().equipped?.instrumentId; if (eq && DATA.instruments?.[eq]?.kind !== "audio") set.add(eq); }
  if (!set.size) { set.add("guitar"); set.add("drums"); }
  return [...set];
}

// Generate a session's worth of loops for a band (one per instrument present).
export function writeSession(band) {
  const ms = getState().musicSettings || {};
  const key = ms.key || "C", bpm = ms.bpm || 110;
  const bpb = 4, spb = 4, bars = 2, length = bars * bpb * spb;
  const feel = GENRE_FEEL[(band.genre || "").toLowerCase()] || (Math.random() < 0.5 ? "major" : "minor");
  const scale = SCALES[feel] || SCALES.minor;
  const prog = PROGS[Math.floor(Math.random() * PROGS.length)];
  let best = performingMembers(band.id).reduce((a, m) => Math.max(a, m.stats?.songwriting || 0), 0);
  if (band.playerIn) best = Math.max(best, DATA.config.band?.playerStats?.songwriting || 55);
  const skill = Math.min(1, best / 100);
  const loops = [];
  for (const inst of bandInstruments(band)) {
    const kind = DATA.instruments?.[inst]?.kind;
    let notes;
    if (kind === "percussion") notes = genDrums(bars, spb, bpb, skill);
    else if (inst === "bass") notes = genBass(midiOf(key, 3), scale, prog, bars, spb, bpb, skill);
    else notes = genMelodic(midiOf(key, 4), scale, prog, bars, spb, bpb, skill);
    loops.push({
      id: "pat_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: `${band.name || "Band"} — ${DATA.instruments?.[inst]?.name || inst} idea`,
      instrument: inst, length, bpm, stepsPerBeat: spb, timeSig: "4/4",
      notes, createdAt: Date.now(), by: band.name || "the band", generated: true
    });
  }
  return loops;
}
