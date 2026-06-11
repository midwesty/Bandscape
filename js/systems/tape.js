// ============================================================
// tape.js — cassettes (Step 18.1). Burn a loop / song / release
// to a portable "BANDSCAPE TAPE" file: audio + arrangement +
// credits, NO save data. Load a tape to add those items to your
// own library (audio restored to IndexedDB). Bandscape-to-
// Bandscape for now; a standalone mixed .wav comes with the
// later audio-mixdown feature.
// ============================================================

import { getState, playerArtistName, artistName, bandById, PLAYER_ARTIST } from "../engine/state.js";
import { getAudio, putAudio } from "../engine/audiostore.js";

const patById = (id) => (getState().patterns || []).find((p) => p.id === id);
const songById = (id) => (getState().songs || []).find((s) => s.id === id);
const relById = (id) => (getState().releases || []).find((r) => r.id === id);

function songPatternIds(song) {
  const ids = new Set();
  (song.tracks || []).forEach((tr) => (tr || []).forEach((c) => { if (c && c.patternId) ids.add(c.patternId); }));
  return [...ids];
}

async function collectAudio(patterns) {
  const audio = {};
  for (const p of patterns) {
    if (p.type === "audio") {
      let d = p.audio;
      if (!d) { try { d = await getAudio(p.id); } catch {} }
      if (d) audio[p.id] = d;
    }
  }
  return audio;
}

function download(obj, title) {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `bandscape-TAPE-${(title || "audio").replace(/\s+/g, "_")}-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// kind: "loop" | "song" | "release"
export async function burnTape(kind, id) {
  const s = getState();
  let songs = [], patterns = [], releases = [], title = "", band = null;
  if (kind === "loop") {
    const p = patById(id); if (!p) return { ok: false, err: "Loop not found." };
    patterns = [p]; title = p.name || "Loop"; band = bandById(p.bandId);
  } else if (kind === "song") {
    const sg = songById(id); if (!sg) return { ok: false, err: "Song not found." };
    songs = [sg]; patterns = songPatternIds(sg).map(patById).filter(Boolean);
    title = sg.name || "Song"; band = bandById(sg.bandId);
  } else if (kind === "release") {
    const r = relById(id); if (!r) return { ok: false, err: "Release not found." };
    releases = [r]; songs = (r.songIds || []).map(songById).filter(Boolean);
    const pids = new Set(); songs.forEach((sg) => songPatternIds(sg).forEach((x) => pids.add(x)));
    patterns = [...pids].map(patById).filter(Boolean); title = r.title || "Release"; band = bandById(r.bandId);
  } else return { ok: false, err: "Unknown kind." };

  const audio = await collectAudio(patterns);
  const creator = (songs[0] && songs[0].artistId) || (patterns[0] && patterns[0].artistId) || PLAYER_ARTIST;
  const credits = {
    artist: artistName(creator),
    band: band ? (band.name || "") : "",
    day: (songs[0] && songs[0].createdDay) || (patterns[0] && patterns[0].createdDay) || (s.time && s.time.day) || 1,
    burnedBy: playerArtistName()
  };
  download({ _bandscapeTape: 1, kind, title, credits, songs, patterns, releases, audio }, title);
  return { ok: true, title, counts: { songs: songs.length, loops: patterns.length } };
}

// Load a tape file → add its items to this player's library (new ids; refs remapped).
export async function loadTape(file) {
  const data = JSON.parse(await file.text());
  if (!data || !data._bandscapeTape) throw new Error("not-a-tape");
  const s = getState();
  s.patterns = s.patterns || []; s.songs = s.songs || []; s.releases = s.releases || [];
  const newId = (pre) => pre + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const credit = (data.credits && data.credits.artist) || "Unknown";
  const pmap = {}, smap = {};

  for (const p of (data.patterns || [])) {
    const np = JSON.parse(JSON.stringify(p)); const nid = newId("pat_"); pmap[p.id] = nid;
    np.id = nid; np.createdAt = Date.now(); np.folders = Array.isArray(np.folders) ? np.folders : [];
    np.by = credit; np.fromTape = true; delete np.audio;
    s.patterns.push(np);
    if (data.audio && data.audio[p.id] != null) { try { await putAudio(nid, data.audio[p.id]); } catch {} }
  }
  for (const sg of (data.songs || [])) {
    const ns = JSON.parse(JSON.stringify(sg)); const nid = newId("song_"); smap[sg.id] = nid;
    ns.id = nid; ns.createdAt = Date.now(); ns.folders = Array.isArray(ns.folders) ? ns.folders : [];
    ns.by = credit; ns.fromTape = true;
    (ns.tracks || []).forEach((tr) => (tr || []).forEach((c) => { if (c && c.patternId && pmap[c.patternId]) c.patternId = pmap[c.patternId]; }));
    s.songs.push(ns);
  }
  let relCount = 0;
  for (const r of (data.releases || [])) {
    const nr = JSON.parse(JSON.stringify(r)); nr.id = newId("rel_");
    nr.songIds = (nr.songIds || []).map((x) => smap[x] || x).filter((id) => s.songs.some((z) => z.id === id));
    if (nr.songIds.length) { s.releases.push(nr); relCount++; }
  }
  return { songs: (data.songs || []).length, loops: (data.patterns || []).length, releases: relCount, artist: credit };
}
