// ============================================================
// notes.js — canonical NOTE model (Step 11.2). Leaf module.
//
// A note is absolute: { start, length, pitch, vel } for melodic
// material (pitch = MIDI int) or { start, length, piece } for a
// drum hit. start/length are in STEPS. This is the representation
// the piano roll (Step 12) edits and that NPC songwriting (Step
// 13) generates — so the whole game speaks one note language.
//
// patternNotes() returns a pattern's notes, lazily MIGRATING the
// old { events:[{step,code,oct}] } schema on first access. The
// migration is behaviour-preserving: pitches, timing, durations,
// and per-voice loudness all reproduce the old playback exactly.
// ============================================================

const PC = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };

// MIDI number for a note letter (e.g. "C", "Fs") at an octave (C4 = 60).
export function midiOf(letter, octave) { return (octave + 1) * 12 + (PC[letter] ?? 0); }

// Default note length (in steps) that reproduces the old fixed synth
// release (chord 0.9s, single note 0.5s) at the pattern's tempo.
export function noteLength(kind, bpm, stepsPerBeat) {
  const secPerStep = (60 / (bpm || 120)) / (stepsPerBeat || 4);
  const rel = kind === "chord" ? 0.9 : 0.5;
  return Math.max(1, Math.round(rel / secPerStep));
}

// Return canonical notes for a pattern, migrating legacy events if needed.
export function patternNotes(p) {
  if (!p) return [];
  if (Array.isArray(p.notes)) return p.notes;
  const notes = [];
  const bpm = p.bpm || 120, spb = p.stepsPerBeat || 4;
  for (const e of (p.events || [])) {
    const code = e.code || "";
    const us = code.indexOf("_");
    const kind = us < 0 ? "drum" : code.slice(0, us);
    const letter = us < 0 ? "" : code.slice(us + 1);
    if (kind === "chord") {
      const root = midiOf(letter, e.oct ?? 3);
      const L = noteLength("chord", bpm, spb);
      // root + major triad + octave; vels reproduce old peaks (0.16 / 0.11).
      [0, 4, 7, 12].forEach((iv, i) => notes.push({ start: e.step, length: L, pitch: root + iv, vel: i === 0 ? 0.8 : 0.55 }));
    } else if (kind === "note") {
      notes.push({ start: e.step, length: noteLength("note", bpm, spb), pitch: midiOf(letter, e.oct ?? 4), vel: 1 });
    } else {
      notes.push({ start: e.step, length: 1, piece: code });
    }
  }
  p.notes = notes; // cache on the pattern; persists on next save
  return notes;
}
