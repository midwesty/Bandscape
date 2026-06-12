// ============================================================
// main.js — boot + orchestration.
// Loads data, runs the title screen, and wires the systems for
// a running game. This is the conductor; systems do the work.
// ============================================================

import { loadAllData, DATA } from "./engine/data.js";
import { newGameState, setState, getState, ensureLibraryMeta, ensureContracts, ensureProperties } from "./engine/state.js";
import { saveToSlot, loadFromSlot, slotSummary } from "./engine/storage.js";
import { putAudio } from "./engine/audiostore.js";
import { ensureGear } from "./systems/gear.js";
import { on, emit } from "./engine/bus.js";

import { startClock, stopClock, initTimeControls } from "./systems/time.js";
import { renderHUD } from "./systems/hud.js";
import { renderStage, pauseStage } from "./systems/stage.js";
import { initPhone } from "./systems/phone.js";
import { initInventory } from "./systems/inventory.js";
import { initDAW } from "./systems/daw.js";
import { initCalendar } from "./systems/calendar.js";
import { initReminders } from "./systems/reminders.js";
import { initRentSchedule } from "./systems/properties.js";
import { initObjectives } from "./systems/objectives.js";
import { startCharCreate } from "./systems/charcreate.js";
import { toast } from "./ui/toast.js";

const $ = (id) => document.getElementById(id);

boot();

async function boot() {
  const bootEl = $("boot");
  const status = $("boot-status");

  const res = await loadAllData();
  if (!res.ok) {
    status.innerHTML = `<span class="boot-error">Couldn't load data files:</span><br>${res.errors.join("<br>")}
      <br><br><span class="muted">Run a local server (python -m http.server 8000) and open via http://localhost:8000 — opening index.html directly blocks fetch().</span>`;
    return;
  }

  $("boot-title").textContent = DATA.config.title;
  $("boot-tagline").textContent = DATA.config.tagline;
  status.textContent = "";

  renderTitle();
  bootEl.classList.remove("loading");
}

function renderTitle() {
  const slots = [];
  for (let i = 1; i <= DATA.config.save.slots; i++) slots.push(slotSummary(i));
  const hasAny = slots.some(Boolean);

  const menu = $("boot-menu");
  menu.innerHTML = `
    <button class="btn btn-big" id="btn-new">NEW GAME</button>
    ${hasAny ? `<div class="slot-list">${slots.map(slotRow).join("")}</div>` : `<p class="muted">No saved games yet.</p>`}
  `;

  $("btn-new").addEventListener("click", chooseSlotThenCreate);
  menu.querySelectorAll("[data-load]").forEach((b) =>
    b.addEventListener("click", () => loadSlot(parseInt(b.dataset.load, 10))));
  menu.querySelectorAll("[data-newslot]").forEach((b) =>
    b.addEventListener("click", () => createInSlot(parseInt(b.dataset.newslot, 10))));
}

function slotRow(s, i) {
  const slot = i + 1;
  if (!s) return `<button class="slot slot-empty" data-newslot="${slot}"><span>Slot ${slot}</span><span class="muted">empty — new game</span></button>`;
  const when = s.lastSaved ? new Date(s.lastSaved).toLocaleDateString() : "";
  return `<button class="slot" data-load="${slot}">
      <span class="slot-name">${s.name}</span>
      <span class="slot-info">Day ${s.day} · $${s.money} <span class="muted">${when}</span></span>
      <span class="slot-cta">CONTINUE →</span>
    </button>`;
}

function chooseSlotThenCreate() {
  // pick first empty slot, else slot 1
  let target = 1;
  for (let i = 1; i <= DATA.config.save.slots; i++) {
    if (!loadFromSlot(i)) { target = i; break; }
  }
  createInSlot(target);
}

function createInSlot(slot) {
  if (loadFromSlot(slot) && !confirm(`Slot ${slot} has a game. Overwrite it?`)) return;
  startCharCreate((char) => {
    const state = newGameState(slot, char);
    setState(state);
    saveToSlot(slot, state);
    enterGame(true);
  });
}

function loadSlot(slot) {
  const data = loadFromSlot(slot);
  if (!data) return toast("That slot is empty.", "warn");
  setState(data);
  enterGame(false);
}

// ---- enter the running game ----
let wired = false;

// Step 18.0: relocate legacy inline audio (data-URLs saved in localStorage) into
// IndexedDB, then strip it from the save so the 5MB quota stops rejecting recordings.
async function migrateInlineAudio() {
  const s = getState(); if (!s || !Array.isArray(s.patterns)) return;
  let moved = 0;
  for (const p of s.patterns) {
    if (p && p.type === "audio" && typeof p.audio === "string" && p.audio) {
      try { await putAudio(p.id, p.audio); delete p.audio; moved++; } catch {}
    }
  }
  if (moved > 0) { try { saveToSlot(s.meta.slot, s); } catch {} }
}

function enterGame(isNew) {
  $("boot").classList.add("hidden");
  $("charcreate").classList.add("hidden");
  $("game").classList.remove("hidden");

  ensureLibraryMeta();   // Step 16: backfill library metadata on older saves
  ensureContracts();     // Step 17.1: default contracts + owed balances
  ensureGear(); ensureProperties();          // Step 19.0: default instrument tiers
  migrateInlineAudio();  // Step 18.0: move any inline audio into IndexedDB (off the localStorage quota)
  initObjectives();
  initPhone();
  initInventory();
  initDAW();
  initCalendar();
  initReminders(); initRentSchedule();
  renderHUD();
  renderStage();

  if (!wired) {
    wired = true;

    on("renderAll", () => { renderHUD(); });

    on("day:advanced", ({ day, forced }) => {
      renderStage();
      if (DATA.config.save.autosaveOnSleep) saveToSlot(getState().meta.slot, getState());
      toast(forced ? `You passed out. Day ${day}.` : `Morning. Day ${day}.`, forced ? "warn" : "good");
    });

    on("save:imported", ({ data }) => {
      if (!data || !data.player) return toast("That didn't look like a Bandscape save.", "warn");
      setState(data);
      ensureLibraryMeta();
      saveToSlot(data.meta?.slot || 1, data);
      renderHUD(); renderStage();
      toast(`Loaded ${data.player.name}.`, "good");
    });

    on("game:requestNew", () => {
      stopClock();
      pauseStage();
      $("game").classList.add("hidden");
      $("boot").classList.remove("hidden");
      renderTitle();
    });

    on("player:collapsed", () => showCollapse());

    on("step:complete", ({ step }) =>
      toast(`Step ${step} loop complete — that's the tutorial slice. Nice.`, "good", 4200));
  }

  startClock();
  initTimeControls();
  if (isNew) emit("game:started", { name: getState().player.name });

  // first-time nudge
  if (isNew) setTimeout(() => toast("Tap the phone (bottom-right) to begin.", "info", 4200), 800);
}

function showCollapse() {
  stopClock();
  const el = $("collapse");
  el.classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("collapse-msg").textContent = "You collapsed from sheer poor decision-making.";
  $("collapse-btn").onclick = () => {
    const s = getState();
    s.stats.health = 50; s.stats.hunger = 40; s.stats.thirst = 40;
    el.classList.add("hidden");
    document.body.classList.remove("modal-open");
    startClock();
  initTimeControls();
    renderHUD();
  };
}
