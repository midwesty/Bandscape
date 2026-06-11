// ============================================================
// library.js — Step 16.1/16.2: the unified file browser + manager.
//
// Browses every loop (state.patterns) and finished song (state.songs)
// with the metadata stamped in 16.0 (artist / band / date / type /
// folders / instrument / quality), and manages them: tag into custom
// folders, rename, duplicate, delete. A separate folder-manager view
// handles creating / renaming / deleting folders.
//
// renderLibrary(container, opts):
//   opts.mode      "all" | "loops" | "songs"   (default "all")
//   opts.onOpenSong(id)   called when a song's Open is tapped
//   opts.showFolders      show the artist/folder chip row (default true)
// ============================================================

import { DATA } from "../engine/data.js";
import {
  getState, artistName, ensureLibraryMeta, bandById,
  createFolder, renameFolder, deleteFolder, toggleItemFolder,
  renameLibItem, deleteLibItem, duplicateLibItem
} from "../engine/state.js";
import { songQuality } from "./shows.js";
import { schedulePattern, stopPattern, ensureAudio, armAudio } from "./audio.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { countItem, takeItem } from "./inventory.js";
import { burnTape } from "./tape.js";

let cont = null, OPTS = {};
let q = "", fType = "all", fBand = "all", fFolder = "all", sortBy = "new";
let previewId = null, expandedId = null, view = "list", lastView = null;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function persist() { const s = getState(); if (s && s.meta) saveToSlot(s.meta.slot, s); }
function instName(id) { return (DATA.instruments && DATA.instruments[id] && DATA.instruments[id].name) || id || "—"; }
function bandName(id) { if (!id) return "solo"; const b = bandById(id); return b ? (b.name || "untitled band") : "—"; }
function folders() { return getState().musicFolders || []; }

function releasedSet() {
  const set = new Set();
  (getState().releases || []).forEach((r) => (r.songIds || []).forEach((id) => set.add(id)));
  return set;
}
function normLoop(p) {
  return { id: p.id, ref: p, kind: "loop", name: p.name || "Untitled", instrument: p.instrument,
    artistId: p.artistId, bandId: p.bandId, createdAt: p.createdAt || 0, createdDay: p.createdDay,
    folders: p.folders || [], bpm: p.bpm };
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
  out.sort((a, b) => {
    if (sortBy === "old") return a.createdAt - b.createdAt;
    if (sortBy === "name") return a.name.localeCompare(b.name);
    if (sortBy === "quality") return (b.quality || 0) - (a.quality || 0);
    if (sortBy === "bpm") return (a.bpm || 0) - (b.bpm || 0);
    return b.createdAt - a.createdAt;
  });
  return out;
}
function preview(id) {
  const p = (getState().patterns || []).find((x) => x.id === id); if (!p) return;
  try { armAudio(); ensureAudio(); } catch (e) {}
  stopPattern();
  if (previewId === id) { previewId = null; rerender(); return; }
  previewId = id;
  schedulePattern(p, () => { previewId = null; });
  rerender();
}

// ---- detail panel for an expanded item ----
function detailHTML(i) {
  const fchips = folders().map((f) =>
    `<button class="lib-fchip ${(i.folders || []).includes(f.id) ? "on" : ""}" data-tag="${esc(f.id)}" data-item="${esc(i.id)}">\u{1F5C2} ${esc(f.name)}</button>`).join("");
  return `<div class="lib-detail">
    <div class="lib-fchips">${fchips}<button class="lib-fchip new" data-newfld="${esc(i.id)}">+ New folder</button></div>
    <div class="lib-detail-acts">
      <button class="lib-mini" data-rename="${esc(i.id)}">Rename</button>
      <button class="lib-mini" data-dup="${esc(i.id)}">Duplicate</button>
      <button class="lib-mini danger" data-del="${esc(i.id)}" data-kind="${i.kind}" data-rel="${i.released ? 1 : 0}">Delete</button>
    </div>
    <button class="lib-mini lib-burn" data-burn="${esc(i.id)}" data-bkind="${i.kind}">▣ Burn to tape</button>
  </div>`;
}

// ---- folder manager view ----
function countInFolder(id) {
  const s = getState();
  let n = 0;
  for (const p of (s.patterns || [])) if ((p.folders || []).includes(id)) n++;
  for (const g of (s.songs || [])) if ((g.folders || []).includes(id)) n++;
  return n;
}
function renderFolderManager() {
  const fs = folders();
  const rows = fs.length ? fs.map((f) => {
    const n = countInFolder(f.id);
    return `<div class="lib-row"><div class="lib-info" data-fopen="${esc(f.id)}"><div class="lib-name">\u{1F5C2} ${esc(f.name)} <span class="lib-open-hint">open \u25B8</span></div><div class="lib-meta">${n} item${n === 1 ? "" : "s"}</div></div>
      <div class="lib-actions"><button class="lib-mini" data-fren="${esc(f.id)}">Rename</button><button class="lib-mini danger" data-fdel="${esc(f.id)}">Delete</button></div></div>`;
  }).join("") : `<p class="muted" style="padding:14px 4px">No folders yet. Create one to start tagging tracks and songs.</p>`;
  cont.innerHTML = `<h2 class="app-title">FOLDERS</h2>
    <div class="lib-controls"><button class="lib-sel" id="fm-back">\u2039 Back to files</button><button class="lib-sel" id="fm-new">+ New folder</button></div>
    <div class="lib-list">${rows}</div>`;
  cont.querySelector("#fm-back").addEventListener("click", () => { view = "list"; rerender(); });
  cont.querySelectorAll("[data-fopen]").forEach((b) => b.addEventListener("click", () => { fFolder = "tag:" + b.dataset.fopen; view = "list"; rerender(); }));
  cont.querySelector("#fm-new").addEventListener("click", () => { const nm = (prompt("Folder name:", "") || "").trim(); if (nm) { createFolder(nm); persist(); rerender(); } });
  cont.querySelectorAll("[data-fren]").forEach((b) => b.addEventListener("click", () => { const f = folders().find((x) => x.id === b.dataset.fren); const nm = (prompt("Rename folder:", f ? f.name : "") || "").trim(); if (nm) { renameFolder(b.dataset.fren, nm); persist(); rerender(); } }));
  cont.querySelectorAll("[data-fdel]").forEach((b) => b.addEventListener("click", () => { if (confirm("Delete this folder? Tracks stay; they're just un-tagged.")) { deleteFolder(b.dataset.fdel); persist(); toast("Folder deleted.", "info"); rerender(); } }));
}

export function renderLibrary(container, opts) {
  cont = container; OPTS = opts || {};
  ensureLibraryMeta();
  if (view === "folders") { renderFolderManager(); lastView = view; return; }

  const prevScroll = (view === lastView) ? (cont.scrollTop || 0) : 0;
  lastView = view;

  const raw = gather();
  const items = applyFilters(raw);
  const s = getState();

  const artistIds = [...new Set(raw.map((i) => i.artistId).filter(Boolean))];
  const customFolders = folders();
  const chips = [{ key: "all", label: "All" }]
    .concat(artistIds.map((a) => ({ key: "artist:" + a, label: "\u{1F464} " + artistName(a) })))
    .concat(customFolders.map((f) => ({ key: "tag:" + f.id, label: "\u{1F5C2} " + f.name })));
  const chipRow = (OPTS.showFolders === false) ? "" : `<div class="lib-chips">${chips.map((c) =>
    `<button class="lib-chip ${fFolder === c.key ? "on" : ""}" data-folder="${esc(c.key)}">${esc(c.label)}</button>`).join("")}<button class="lib-chip manage" id="lib-managefld">\u2699 Folders</button></div>`;

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
    const isOpen = expandedId === i.id;
    return `<div class="lib-row ${isOpen ? "open" : ""}">
      <div class="lib-info" data-expand="${esc(i.id)}">
        <div class="lib-name">${esc(i.name)} ${badge}${relTag}</div>
        <div class="lib-meta">${esc(metaBits.join(" \u00B7 "))}</div>
      </div>
      <div class="lib-actions">${action}</div>
    </div>${isOpen ? detailHTML(i) : ""}`;
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
  const mf = cont.querySelector("#lib-managefld"); if (mf) mf.addEventListener("click", () => { view = "folders"; rerender(); });
  cont.querySelectorAll("[data-folder]").forEach((b) => b.addEventListener("click", () => { fFolder = b.dataset.folder; rerender(); }));
  cont.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", () => preview(b.dataset.play)));
  cont.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { stopPattern(); previewId = null; OPTS.onOpenSong && OPTS.onOpenSong(b.dataset.open); }));
  cont.querySelectorAll("[data-expand]").forEach((b) => b.addEventListener("click", () => { expandedId = expandedId === b.dataset.expand ? null : b.dataset.expand; rerender(); }));
  cont.querySelectorAll("[data-tag]").forEach((b) => b.addEventListener("click", () => { toggleItemFolder(b.dataset.item, b.dataset.tag); persist(); rerender(); }));
  cont.querySelectorAll("[data-newfld]").forEach((b) => b.addEventListener("click", () => { const nm = (prompt("Folder name:", "") || "").trim(); if (nm) { const f = createFolder(nm); toggleItemFolder(b.dataset.newfld, f.id); persist(); rerender(); } }));
  cont.querySelectorAll("[data-rename]").forEach((b) => b.addEventListener("click", () => { const cur = (getState().patterns || []).concat(getState().songs || []).find((x) => x.id === b.dataset.rename); const nm = (prompt("New name:", cur ? cur.name : "") || "").trim(); if (nm) { renameLibItem(b.dataset.rename, nm); persist(); rerender(); } }));
  cont.querySelectorAll("[data-dup]").forEach((b) => b.addEventListener("click", () => { const id = duplicateLibItem(b.dataset.dup); persist(); expandedId = id; toast("Duplicated.", "good"); rerender(); }));
  cont.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    const released = b.dataset.rel === "1";
    const msg = released ? "Delete this released song? It stays released and keeps earning streams, but the recording leaves your library." : "Delete this " + (b.dataset.kind === "song" ? "song" : "loop") + "? This can't be undone.";
    if (confirm(msg)) { stopPattern(); previewId = null; deleteLibItem(b.dataset.del); expandedId = null; persist(); toast("Deleted.", "info"); rerender(); }
  }));
  cont.querySelectorAll("[data-burn]").forEach((b) => b.addEventListener("click", async () => {
    if (countItem("blank_tape") < 1) { toast("You need a blank tape — grab one at the pawn shop.", "warn"); return; }
    const res = await burnTape(b.dataset.bkind, b.dataset.burn);
    if (!res.ok) { toast(res.err || "Couldn't burn that.", "bad"); return; }
    takeItem("blank_tape", 1); persist();
    toast(`Burned "${res.title}" to tape. ${countItem("blank_tape")} left.`, "good");
    rerender();
  }));
}
