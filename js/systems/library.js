// ============================================================
// library.js — Step 16.1: the unified file browser.
//
// One reusable browser over every loop (state.patterns) and
// finished song (state.songs), with the metadata stamped in 16.0:
// artist, band, date, type, folders, instrument/quality.
//
// renderLibrary(container, opts):
//   opts.mode      "all" | "loops" | "songs"   (default "all")
//   opts.onOpenSong(id)   called when a song's Open is tapped
//   opts.showFolders      show the artist/folder chip row (default true)
//
// The module owns its own filter/sort state so it persists across
// re-renders. Loops can be previewed in place (schedulePattern);
// opening a song is delegated to the caller (the phone wires the DAW),
// keeping this module decoupled.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, artistName, ensureLibraryMeta, bandById } from "../engine/state.js";
import { songQuality } from "./shows.js";
import { schedulePattern, stopPattern, ensureAudio, armAudio } from "./audio.js";

let cont = null, OPTS = {};
let q = "", fType = "all", fBand = "all", fFolder = "all", sortBy = "new", previewId = null;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function instName(id) { return (DATA.instruments && DATA.instruments[id] && DATA.instruments[id].name) || id || "—"; }
function bandName(id) { if (!id) return "solo"; const b = bandById(id); return b ? (b.name || "untitled band") : "—"; }

function releasedSet() {
  const set = new Set();
  (getState().releases || []).forEach((r) => (r.songIds || []).forEach((id) => set.add(id)));
  return set;
}

function normLoop(p) {
  return { id: p.id, ref: p, kind: "loop", name: p.name || "Untitled", instrument: p.instrument,
    artistId: p.artistId, bandId: p.bandId, createdAt: p.createdAt || 0, createdDay: p.createdDay,
    folders: p.folders || [], bpm: p.bpm, audio: p.type === "audio" };
}
function normSong(g, rel) {
  return { id: g.id, ref: g, kind: "song", name: g.name || "Untitled", instrument: null,
    artistId: g.artistId, bandId: g.bandId, createdAt: g.createdAt || 0, createdDay: g.createdDay,
    folders: g.folders || [], bpm: g.bpm, quality: songQuality(g, bandById(g.bandId)),
    released: rel.has(g.id), tracks: (g.tracks || []).length };
}

function gather() {
  const s = getState(); const rel = releasedSet();
  const loops = (s.patterns || []).map(normLoop);
  const songs = (s.songs || []).map((g) => normSong(g, rel));
  if (OPTS.mode === "loops") return loops;
  if (OPTS.mode === "songs") return songs;
  return loops.concat(songs);
}

function applyFilters(list) {
  let out = list.slice();
  if (fType !== "all") out = out.filter((i) => i.kind === fType);
  if (fBand !== "all") out = out.filter((i) => (fBand === "none" ? !i.bandId : i.bandId === fBand));
  if (fFolder !== "all") {
    if (fFolder.startsWith("artist:")) { const a = fFolder.slice(7); out = out.filter((i) => i.artistId === a); }
    else if (fFolder.startsWith("tag:")) { const t = fFolder.slice(4); out = out.filter((i) => (i.folders || []).includes(t)); }
  }
  if (q.trim()) {
    const needle = q.trim().toLowerCase();
    out = out.filter((i) => i.name.toLowerCase().includes(needle)
      || artistName(i.artistId).toLowerCase().includes(needle)
      || bandName(i.bandId).toLowerCase().includes(needle));
  }
  const dir = (a, b, v) => v;
  out.sort((a, b) => {
    if (sortBy === "old") return a.createdAt - b.createdAt;
    if (sortBy === "name") return a.name.localeCompare(b.name);
    if (sortBy === "quality") return (b.quality || 0) - (a.quality || 0);
    if (sortBy === "bpm") return (a.bpm || 0) - (b.bpm || 0);
    return b.createdAt - a.createdAt; // "new"
  });
  return out;
}

function preview(id) {
  const p = (getState().patterns || []).find((x) => x.id === id); if (!p) return;
  try { armAudio(); ensureAudio(); } catch (e) {}
  stopPattern();
  if (previewId === id) { previewId = null; rerender(); return; } // tap again = stop
  previewId = id;
  schedulePattern(p, () => { previewId = null; });
  rerender();
}

export function renderLibrary(container, opts) {
  cont = container; OPTS = opts || {};
  ensureLibraryMeta();
  const prevScroll = cont.scrollTop || 0;

  const raw = gather();
  const items = applyFilters(raw);
  const s = getState();

  // folder chips: All + one per artist who has work + custom tag-folders
  const artistIds = [...new Set(raw.map((i) => i.artistId).filter(Boolean))];
  const customFolders = s.musicFolders || [];
  const chips = [{ key: "all", label: "All" }]
    .concat(artistIds.map((a) => ({ key: "artist:" + a, label: "\u{1F464} " + artistName(a) })))
    .concat(customFolders.map((f) => ({ key: "tag:" + f.id, label: "\u{1F5C2} " + f.name })));
  const chipRow = (OPTS.showFolders === false) ? "" : `<div class="lib-chips">${chips.map((c) =>
    `<button class="lib-chip ${fFolder === c.key ? "on" : ""}" data-folder="${esc(c.key)}">${esc(c.label)}</button>`).join("")}</div>`;

  // band select
  const bands = s.bands || [];
  const bandOpts = `<option value="all">All bands</option>${bands.map((b) => `<option value="${b.id}" ${fBand === b.id ? "selected" : ""}>${esc(b.name || "Untitled band")}</option>`).join("")}<option value="none" ${fBand === "none" ? "selected" : ""}>Solo / no band</option>`;
  const typeSel = OPTS.mode === "all" ? `<select class="lib-sel" id="lib-type">
      <option value="all" ${fType === "all" ? "selected" : ""}>All types</option>
      <option value="loop" ${fType === "loop" ? "selected" : ""}>Loops</option>
      <option value="song" ${fType === "song" ? "selected" : ""}>Songs</option></select>` : "";

  const rows = items.length ? items.map((i) => {
    const dayTxt = i.createdDay ? `Day ${i.createdDay}` : "";
    const metaBits = [artistName(i.artistId), bandName(i.bandId), dayTxt].filter(Boolean);
    if (i.kind === "song") metaBits.push(`Q${i.quality}`, `${i.tracks} trk`);
    else metaBits.push(instName(i.instrument));
    const badge = i.kind === "song" ? `<span class="lib-badge song">SONG</span>` : `<span class="lib-badge loop">LOOP</span>`;
    const relTag = (i.kind === "song" && i.released) ? `<span class="lib-rel">\u25CF released</span>` : "";
    const action = i.kind === "song"
      ? `<button class="lib-act" data-open="${esc(i.id)}">Open</button>`
      : `<button class="lib-act ${previewId === i.id ? "playing" : ""}" data-play="${esc(i.id)}">${previewId === i.id ? "\u25A0" : "\u25B6"}</button>`;
    return `<div class="lib-row">
      <div class="lib-info">
        <div class="lib-name">${esc(i.name)} ${badge}${relTag}</div>
        <div class="lib-meta">${esc(metaBits.join(" \u00B7 "))}</div>
      </div>
      <div class="lib-actions">${action}</div>
    </div>`;
  }).join("") : `<p class="muted" style="padding:14px 4px">Nothing here yet. ${OPTS.mode === "songs" ? "Finish a song in the DAW." : OPTS.mode === "loops" ? "Record or compose a loop in the Sound studio." : "Make some loops and songs and they'll show up here."}</p>`;

  cont.innerHTML = `
    ${OPTS.title === false ? "" : `<h2 class="app-title">FILES</h2>`}
    <input class="lib-search" id="lib-q" placeholder="Search by name, artist, band…" value="${esc(q)}">
    <div class="lib-controls">
      <select class="lib-sel" id="lib-sort">
        <option value="new" ${sortBy === "new" ? "selected" : ""}>Newest</option>
        <option value="old" ${sortBy === "old" ? "selected" : ""}>Oldest</option>
        <option value="name" ${sortBy === "name" ? "selected" : ""}>Name A–Z</option>
        <option value="quality" ${sortBy === "quality" ? "selected" : ""}>Quality</option>
        <option value="bpm" ${sortBy === "bpm" ? "selected" : ""}>BPM</option>
      </select>
      ${typeSel}
      <select class="lib-sel" id="lib-band">${bandOpts}</select>
    </div>
    ${chipRow}
    <div class="lib-count">${items.length} item${items.length === 1 ? "" : "s"}</div>
    <div class="lib-list">${rows}</div>`;

  cont.scrollTop = prevScroll;
  bind();
}

function rerender() { if (cont) renderLibrary(cont, OPTS); }

function bind() {
  const qi = cont.querySelector("#lib-q");
  if (qi) qi.addEventListener("input", () => {
    q = qi.value; rerender();
    requestAnimationFrame(() => { const n = cont.querySelector("#lib-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  });
  const ss = cont.querySelector("#lib-sort"); if (ss) ss.addEventListener("change", () => { sortBy = ss.value; rerender(); });
  const ts = cont.querySelector("#lib-type"); if (ts) ts.addEventListener("change", () => { fType = ts.value; rerender(); });
  const bs = cont.querySelector("#lib-band"); if (bs) bs.addEventListener("change", () => { fBand = bs.value; rerender(); });
  cont.querySelectorAll("[data-folder]").forEach((b) => b.addEventListener("click", () => { fFolder = b.dataset.folder; rerender(); }));
  cont.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", () => preview(b.dataset.play)));
  cont.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { stopPattern(); previewId = null; OPTS.onOpenSong && OPTS.onOpenSong(b.dataset.open); }));
}
