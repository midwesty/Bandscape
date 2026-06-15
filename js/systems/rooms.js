// ============================================================
// rooms.js — functional item uses for the home (Step 27.3)
//
// Bathroom: shower/tub (Fresh buff), sink (drink), toilet (comfort).
// Living room: seating (sit & rest -> energy top-up).
// Mirror: primp (Primped buff). Sleeping in a bed reuses time.sleep().
//
// Buffs (Fresh, Primped) carry a showDrawMult in conditions.json, so
// freshening up / primping before a gig actually lifts the crowd.
// All numbers live in items/conditions data — editable without code.
// ============================================================

import { getState, addStat } from "../engine/state.js";
import { addCondition } from "./conditions.js";
import { toast } from "../ui/toast.js";
import { saveToSlot } from "../engine/storage.js";

function commit() { const s = getState(); try { saveToSlot(s.meta.slot, s); } catch (e) {} }

export function shower() { addStat("mood", 4); addStat("health", 2); addCondition("fresh"); commit(); }
export function soak() { addStat("mood", 8); addStat("energy", 10); addStat("health", 3); addCondition("fresh", { silent: true }); toast("A long soak. Worth every minute.", "good"); commit(); }
export function primp() { addCondition("primped"); commit(); }
export function drinkWater() { addStat("thirst", 25); toast("Cold tap water. Hits the spot.", "good"); commit(); }
export function restSeat() { addStat("energy", 14); addStat("mood", 2); toast("You take a load off for a bit.", "info"); commit(); }
export function useToilet() { addStat("mood", 2); toast("Ahh. A rare moment of peace.", "info"); commit(); }
