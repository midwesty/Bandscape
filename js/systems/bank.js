// ============================================================
// bank.js — the BANK app (Step 20.1).
// Your wallet + a real account for each band. Move money around:
// contribute (your equity), withdraw it back, borrow from the band,
// repay loans. Every move is recorded in a transaction ledger that
// the Activity tab reads. Later steps route show/merch/streaming
// income into band accounts and pay members from them.
// ============================================================

import {
  getState, walletBalance, ledgerEntries, ensureBankAccounts,
  bankContribute, bankWithdraw, bankBorrow, bankRepay,
  bandById, bandSpend,
} from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { toast } from "../ui/toast.js";
import { saveToSlot } from "../engine/storage.js";

let tab = "overview";
let selBand = null;
let actBand = "all", actCat = "all", actSearch = "";

function num(n) { return "$" + Math.round(n || 0).toLocaleString(); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function bandName(b) { return b && b.name ? b.name : "Your band"; }
function persist() { const s = getState(); if (s && s.meta) saveToSlot(s.meta.slot, s); }

// Reusable "buy something for a band" flow. Defaults to the band's account; if it's
// short, asks whether to cover the difference from your wallet (tracked as a
// contribution). Other systems (merch now; studio rent / band gear later) call this.
// Returns { ok, contributed } | { ok:false, cancelled? }.
export function payForBand(bandId, amount, info = {}) {
  amount = Math.floor(amount);
  const b = bandById(bandId);
  if (!b) { toast("No band selected.", "warn"); return { ok: false }; }
  if (!(amount > 0)) return { ok: false };
  const have = b.account || 0;
  const short = Math.max(0, amount - have);
  const nm = bandName(b);
  if (short > 0) {
    if (walletBalance() < short) { toast(`Neither ${nm} nor your wallet can cover ${num(amount)}.`, "warn"); return { ok: false }; }
    const ok = confirm(`${nm} has ${num(have)} of the ${num(amount)} needed${info.label ? " for " + info.label : ""}.\n\nCover the ${num(short)} difference from your wallet? It's tracked as your contribution to ${nm} — you can withdraw it later.`);
    if (!ok) return { ok: false, cancelled: true };
  }
  const r = bandSpend(bandId, amount, info.category || "misc", info.note || "");
  if (r.ok) { persist(); emit("renderAll"); }
  else toast(r.msg || "Couldn't complete that.", "warn");
  return r;
}

export function renderBankApp(screenEl) {
  ensureBankAccounts();
  const s = getState();
  const bands = s.bands || [];
  if (selBand && !bands.find((b) => b.id === selBand)) selBand = null;

  const tabBtn = (id, label) => `<button class="bank-tab ${tab === id ? "on" : ""}" data-tab="${id}">${label}</button>`;
  let body = "";
  if (tab === "overview") body = overviewHTML(bands);
  else if (tab === "bands") body = bandsHTML(bands);
  else body = activityHTML(s);

  screenEl.innerHTML = `
    <h2 class="app-title">BANK</h2>
    <div class="bank-tabs">${tabBtn("overview", "Overview")}${tabBtn("bands", "Bands")}${tabBtn("activity", "Activity")}</div>
    <div class="bank-body">${body}</div>`;
  bind(screenEl);
}

function overviewHTML(bands) {
  const totalEquity = bands.reduce((a, b) => a + (b.ownerEquity || 0), 0);
  const totalLoan = bands.reduce((a, b) => a + (b.ownerLoan || 0), 0);
  const rows = bands.length
    ? bands.map((b) => `<button class="bank-row bank-row-btn" data-open="${b.id}"><span>${esc(bandName(b))}</span><strong>${num(b.account)}</strong></button>`).join("")
    : `<div class="set-note">No bands yet.</div>`;
  return `
    <div class="bank-card big"><span class="bank-card-label">Your wallet</span><span class="bank-card-amt good">${num(walletBalance())}</span></div>
    <div class="bank-sect">BAND ACCOUNTS</div>
    ${rows}
    <div class="bank-mini">
      <div><span>Your equity in bands</span><strong>${num(totalEquity)}</strong></div>
      <div><span>You owe bands (loans)</span><strong class="${totalLoan > 0 ? "warn" : ""}">${num(totalLoan)}</strong></div>
    </div>`;
}

function bandsHTML(bands) {
  if (!selBand) {
    if (!bands.length) return `<div class="set-note">No bands yet.</div>`;
    return bands.map((b) => `<button class="btn bank-pick" data-band="${b.id}"><span>${esc(bandName(b))}</span><span class="muted">${num(b.account)}</span></button>`).join("");
  }
  const b = bands.find((x) => x.id === selBand);
  if (!b) { selBand = null; return bandsHTML(bands); }
  return `
    <button class="bank-back" data-back="1">‹ All bands</button>
    <div class="bank-card"><span class="bank-card-label">${esc(bandName(b))}</span><span class="bank-card-amt good">${num(b.account)}</span></div>
    <div class="bank-mini">
      <div><span>Your equity</span><strong>${num(b.ownerEquity)}</strong></div>
      <div><span>You owe this band</span><strong class="${(b.ownerLoan || 0) > 0 ? "warn" : ""}">${num(b.ownerLoan)}</strong></div>
    </div>
    <div class="bank-amt-row"><span class="bank-amt-pre">$</span><input id="bank-amt" class="bank-amt" type="number" min="1" inputmode="numeric" placeholder="amount"></div>
    <div class="bank-actions">
      <button class="btn" data-act="contribute">Add funds</button>
      <button class="btn" data-act="withdraw">Withdraw</button>
      <button class="btn" data-act="borrow">Borrow</button>
      <button class="btn" data-act="repay">Repay loan</button>
    </div>
    <p class="set-note">Add funds moves money from your wallet into the band (tracked as your equity). Withdraw pulls your money back out. Borrow takes a loan from the band; repay it anytime, part or full.</p>`;
}

function activityHTML(s) {
  const all = ledgerEntries();
  if (!all.length) return `<div class="set-note">No transactions yet. Move some money in the Bands tab.</div>`;
  const bands = s.bands || [];
  const cats = Array.from(new Set(all.map((e) => e.category))).sort();
  const bandOpts = `<option value="all">All accounts</option>` + bands.map((b) => `<option value="${b.id}" ${actBand === b.id ? "selected" : ""}>${esc(bandName(b))}</option>`).join("");
  const catOpts = `<option value="all">All types</option>` + cats.map((c) => `<option value="${c}" ${actCat === c ? "selected" : ""}>${esc(c[0].toUpperCase() + c.slice(1))}</option>`).join("");
  return `
    <div class="bank-filters">
      <select id="act-band" class="bank-filter">${bandOpts}</select>
      <select id="act-cat" class="bank-filter">${catOpts}</select>
    </div>
    <input id="act-search" class="bank-search" type="text" placeholder="Search transactions…" value="${esc(actSearch)}">
    <div id="bank-ledger-list">${listHTML(s)}</div>`;
}

function listHTML(s) {
  const q = actSearch.trim().toLowerCase();
  const entries = ledgerEntries().filter((e) => {
    if (actBand !== "all" && e.band !== actBand) return false;
    if (actCat !== "all" && e.category !== actCat) return false;
    if (q && !(`${e.note || ""} ${e.category || ""}`.toLowerCase().includes(q))) return false;
    return true;
  });
  if (!entries.length) return `<div class="set-note">No matching transactions.</div>`;
  const label = (e) => e.account === "wallet" ? "Wallet" : bandLabel(s, e.band);
  return `<div class="bank-ledger">${entries.slice(0, 150).map((e) => {
    const pos = e.amount >= 0;
    return `<div class="bank-tx">
      <div class="bank-tx-main"><span class="bank-tx-note">${esc(e.note || e.category)}</span><span class="bank-tx-amt ${pos ? "good" : "warn"}">${pos ? "+" : "−"}${num(Math.abs(e.amount))}</span></div>
      <div class="bank-tx-sub"><span>${esc(label(e))} · ${esc(e.category)}</span><span>Day ${e.day}</span></div>
    </div>`;
  }).join("")}</div>`;
}
function bandLabel(s, id) { const b = (s.bands || []).find((x) => x.id === id); return b ? bandName(b) : "Band"; }

function refreshList(root) {
  const list = root.querySelector("#bank-ledger-list");
  if (list) list.innerHTML = listHTML(getState());
}

function bind(root) {
  root.querySelectorAll(".bank-tab").forEach((t) => t.addEventListener("click", () => {
    tab = t.dataset.tab; if (tab !== "bands") selBand = null; renderBankApp(root);
  }));
  root.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { selBand = b.dataset.open; tab = "bands"; renderBankApp(root); }));
  root.querySelectorAll(".bank-pick").forEach((p) => p.addEventListener("click", () => { selBand = p.dataset.band; renderBankApp(root); }));
  const back = root.querySelector("[data-back]");
  if (back) back.addEventListener("click", () => { selBand = null; renderBankApp(root); });

  const bandSel = root.querySelector("#act-band");
  if (bandSel) bandSel.addEventListener("change", () => { actBand = bandSel.value; refreshList(root); });
  const catSel = root.querySelector("#act-cat");
  if (catSel) catSel.addEventListener("change", () => { actCat = catSel.value; refreshList(root); });
  const search = root.querySelector("#act-search");
  if (search) search.addEventListener("input", () => { actSearch = search.value; refreshList(root); });
  root.querySelectorAll(".bank-actions [data-act]").forEach((btn) => btn.addEventListener("click", () => {
    const input = root.querySelector("#bank-amt");
    const amt = Math.floor(Number(input && input.value) || 0);
    const act = btn.dataset.act;
    let r;
    if (act === "contribute") r = bankContribute(selBand, amt);
    else if (act === "withdraw") r = bankWithdraw(selBand, amt);
    else if (act === "borrow") r = bankBorrow(selBand, amt);
    else if (act === "repay") r = bankRepay(selBand, amt);
    if (r && r.ok) { persist(); emit("renderAll"); toast(actMsg(act, r.paid != null ? r.paid : amt), "good"); renderBankApp(root); }
    else toast((r && r.msg) || "Couldn't do that.", "warn");
  }));
}

function actMsg(act, amt) {
  return ({
    contribute: `Added ${num(amt)} to the band.`,
    withdraw: `Withdrew ${num(amt)}.`,
    borrow: `Borrowed ${num(amt)}.`,
    repay: `Repaid ${num(amt)}.`,
  })[act] || "Done.";
}
