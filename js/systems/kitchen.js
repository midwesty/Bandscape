// ============================================================
// kitchen.js — functional food & drink (Step 27.0)
//
// All numbers come from DATA.config.cooking, items.json, and
// conditions.json, so the whole loop is editable without code.
//
//  • Fridge   → cook a hot meal (uses groceries) or open food storage
//  • Stove    → cook a hot meal (leftovers go to the property fridge)
//  • Espresso → free, endless coffee into your pockets
//  • Microwave→ heat cheap cold food for the Hot Meal bonus
//  • Mini fridge → a beer stash you can stock, fill, and pull from
//
// "Property-wide" simplification: each home has one fridge key
// (passed in by the object), and cooking/leftovers/groceries all
// resolve to that key regardless of which room you're standing in.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat } from "../engine/state.js";
import { addCondition } from "./conditions.js";
import { giveItem, countItem, takeItem, consumeUse, openContainerView } from "./inventory.js";
import { toast } from "../ui/toast.js";

function cfg() { return (DATA.config && DATA.config.cooking) || {}; }
function money() { return (getState().stats || {}).money || 0; }

// property-level grocery stock, keyed by the home's fridge key
function stock(key) {
  const s = getState();
  s.kitchens = s.kitchens || {};
  if (typeof s.kitchens[key] !== "number") s.kitchens[key] = cfg().startGroceries || 0;
  return s.kitchens[key];
}
export function groceryCount(key) { return stock(key); }

export function restockGroceries(key) {
  const c = cfg(), qty = c.restockQty || 6, cost = c.restockCost || 60, cap = c.groceryCap || 24;
  if (money() < cost) { toast(`Groceries run $${cost} — you're short.`, "warn"); return false; }
  if (!confirm(`Restock the fridge: +${qty} groceries for $${cost}?`)) return false;
  addStat("money", -cost);
  const s = getState();
  s.kitchens[key] = Math.min(cap, stock(key) + qty);
  toast(`Fridge restocked — ${s.kitchens[key]} groceries.`, "good");
  return true;
}

// Cook one meal: consumes groceries, yields `servings` hot meals,
// offers eat-one-now vs store-all-as-leftovers. Prompts a restock if empty.
export function cookMeal(key) {
  const c = cfg(), per = c.groceriesPerMeal || 1, serv = c.servings || 2;
  if (stock(key) < per) {
    if (!restockGroceries(key)) return;
    if (stock(key) < per) return;
  }
  const s = getState();
  s.kitchens[key] = stock(key) - per;
  let store = serv;
  if (confirm(`Hot meal's ready (${serv} servings). OK = eat one now, Cancel = store all as leftovers.`)) {
    consumeUse("hot_meal");
    store = serv - 1;
    toast("You dig in. \uD83C\uDF72", "good");
  }
  if (store > 0) {
    const left = giveItem(key, "hot_meal", store);
    if (left > 0) toast("Fridge is full — some leftovers didn't fit.", "warn");
    else toast(`${store} serving(s) stored as leftovers (${stock(key)} groceries left).`, "info");
  }
}

// Fridge tap: choose to cook, otherwise open the food/leftovers storage.
export function useFridge(key) {
  const c = cfg(), qty = c.restockQty || 6, cost = c.restockCost || 60;
  if (confirm(`Fridge — ${groceryCount(key)} groceries on hand.\n\nOK = cook a hot meal   ·   Cancel = more options`)) { cookMeal(key); return; }
  if (confirm(`OK = restock groceries (+${qty} for $${cost})   ·   Cancel = open the fridge`)) restockGroceries(key);
  else openContainerView(key);
}

export function makeCoffee() {
  const left = giveItem("inventory", "coffee", 1);
  if (left > 0) { toast("Your pockets are full.", "warn"); return; }
  toast("Fresh espresso. \u2615 (in your bag)", "good");
}

export function microwaveFood() {
  const c = cfg(), heat = c.heatable || ["pizza_slice", "ramen_cup", "cold_fries", "gas_station_burrito"];
  const have = heat.find((id) => countItem(id) > 0);
  if (!have) { toast("Nothing to heat — grab some cold food first.", "info"); return; }
  const def = (DATA.items.items || {})[have] || {};
  if (!confirm(`Microwave your ${def.name || have}? Heating gives the Hot Meal bonus.`)) return;
  takeItem(have, 1);
  addStat("hunger", c.microwaveHunger || 38);
  addStat("thirst", 4);
  addCondition("hot_meal");
  toast(`Piping hot ${def.name || have}. \uD83D\uDD25`, "good");
}

// Mini fridge: buy a six-pack, or open the beer stash to pull/stash beers.
export function useBeerFridge(key) {
  const c = cfg(), qty = c.beerPackQty || 6, cost = c.beerPackCost || 18;
  if (confirm(`Mini fridge. OK = buy a ${qty}-pack of beer ($${cost}), Cancel = open it.`)) {
    if (money() < cost) { toast(`That's $${cost} — you're short.`, "warn"); return; }
    addStat("money", -cost);
    const left = giveItem(key, "beer", qty);
    if (left > 0) toast("Mini fridge is full.", "warn");
    else toast(`Stocked ${qty} beers. \uD83C\uDF7A`, "good");
  } else {
    openContainerView(key);
  }
}
