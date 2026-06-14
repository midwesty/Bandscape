// ============================================================
// worldradio.js — lo-fi radio in public spaces (Step 27.2)
//
// Auto-plays a popularity-weighted pick from YOUR released tracks
// (the only ones with real audio) at low volume, lo-fi filtered,
// whenever you're in a public space (bar/shop/arcade) and the
// "World music" setting is on. Hearing your own song is a payoff:
// a toast + a small mood/fans bump, rate-limited so it never spams.
//
// Priority (single shared songplayer): the PHONE always wins. When
// you play a track in Streamr, the radio yields silently; when phone
// playback ends / you stop it / you close the phone, the radio resumes.
//
// Two independent settings: "World music" (this radio) and "World
// sounds" (ambient bed/SFX). Neither touches phone/DAW/loop playback.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, nowHourAbs } from "../engine/state.js";
import { on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { playSong, stopSong, currentSource } from "./songplayer.js";
import { toast } from "../ui/toast.js";

function cfg() { return (DATA.config && DATA.config.radio) || {}; }
function worldMusicOn() { const st = getState(); return !(st && st.settings && st.settings.worldMusic === false); } // default ON
function isPublic(scene) { return (cfg().scenes || []).includes(scene); }
function songById(id) { return (getState().songs || []).find((s) => s.id === id) || null; }

let active = false, foreground = false, lastToastHour = -9999;

// popularity-weighted pick among your releases that actually have a playable track
function pickSong() {
  const weighted = [];
  for (const r of (getState().releases || [])) {
    const sid = (r.songIds || [])[0]; if (!sid) continue;
    const sg = songById(sid); if (!sg) continue;
    weighted.push({ sg, rel: r, w: Math.max(1, Math.round((r.streams || 0) / 100) + 1) });
  }
  if (!weighted.length) return null;
  const tot = weighted.reduce((a, x) => a + x.w, 0);
  let n = Math.random() * tot;
  for (const x of weighted) { n -= x.w; if (n <= 0) return x; }
  return weighted[weighted.length - 1];
}

async function startRadio() {
  if (!active || foreground || !worldMusicOn()) return;
  if (currentSource() === "phone") return;
  const pick = pickSong();
  if (!pick) return;                       // no playable releases -> ambient bed only, no radio
  const ok = await playSong(pick.sg, { source: "radio", lofi: true, volume: cfg().volume != null ? cfg().volume : 0.32, loop: false });
  if (!ok) return;
  const now = nowHourAbs();
  if (now - lastToastHour >= (cfg().toastMinGapHours != null ? cfg().toastMinGapHours : 3)) {
    lastToastHour = now;
    toast(`\uD83D\uDCFB On the radio: "${pick.sg.name || pick.rel.title}" — that's you.`, "good");
    if (cfg().mood) addStat("mood", cfg().mood);
    if (cfg().fans) addStat("fans", cfg().fans);
  }
}

function onLocation(scene) {
  active = isPublic(scene) && worldMusicOn();
  if (active) startRadio();
  else if (currentSource() === "radio") stopSong();
}

export function setWorldMusicEnabled(onoff) {
  const st = getState(); st.settings = st.settings || {}; st.settings.worldMusic = !!onoff;
  try { saveToSlot(st.meta.slot, st); } catch (e) {}
  if (!onoff) { if (currentSource() === "radio") stopSong(); active = false; }
  else { active = isPublic(getState().location); startRadio(); }
}
export function worldMusicEnabled() { return worldMusicOn(); }

export function initWorldRadio() {
  on("location:changed", ({ to }) => onLocation(to));
  on("song:playing", ({ source }) => { if (source === "phone") foreground = true; });
  on("song:ended", ({ source }) => {
    if (source === "phone") { foreground = false; startRadio(); }
    else if (source === "radio") { startRadio(); }   // next track
  });
  on("song:stopped", ({ source }) => { if (source === "phone") { foreground = false; startRadio(); } });
  onLocation(getState().location);   // prime for the scene we loaded into
}
