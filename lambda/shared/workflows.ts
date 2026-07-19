/**
 * Deterministic workflows — the control flow of the app, in plain TypeScript.
 * There is one function per intent. These call the database helpers (./db), the
 * deterministic validator (./nutrition), the web search (./nutrition-search), and
 * — only when needed — the narrow sanity LLM (./sanity). They never ask a model
 * to do arithmetic, sequence CRUD, or decide correctness; all of that is here.
 *
 * Every real data operation emits a tool-chip event via `emit(name, phase)` using
 * the SAME 8 tool names the web UI already knows, so the chips render unchanged.
 * Each workflow returns a structured WorkflowResult that the responder narrates.
 *
 * Writes derived from a web lookup or estimate are never performed inline — they
 * are returned as a `proposal` and only committed on the next turn's `confirm`.
 */

import {
  addAlias,
  addFoodItem,
  addFoodToDailyCount,
  deleteDailyEntry,
  deleteFoodItem,
  findFoodItem,
  listDailyEntries,
} from "./db";
import { computeRemaining, reconcileMacros, type Macros, type MacroInput } from "./nutrition";
import { checkPlausibility } from "./sanity";
import { searchNutritionFacts, type NutritionFacts } from "./nutrition-search";
import type { FoodSpec, Intent } from "./intent";
import type { DailyTrackerEntry, FoodItem, ServingSize } from "../../types";

export type Emit = (name: string, phase: "start" | "end") => void;

export type LoggedItem = { item: string; calories: number; proteinG: number; fatG: number; carbsG: number };
export type DailyEntryView = { order: number; item: string; calories: number; proteinG: number; fatG: number; carbsG: number };
export type Totals = { calories: number; proteinG: number; fatG: number; carbsG: number };

/** A food the app wants to save+log but is waiting for the user to confirm. */
export type ProposedFood = {
  item: string;
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  serving: ServingSize | null;
  amountEaten: string | null;
  quantity: number | null;
  /** Where the numbers came from ("your numbers", "already saved", a source note). */
  sourceNote: string | null;
};

export type FactsView = {
  item: string;
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  serving: ServingSize;
  sourceNote: string;
};

export type WorkflowResult =
  | {
      kind: "result";
      action: string;
      logged?: LoggedItem[];
      saved?: LoggedItem[];
      entries?: DailyEntryView[];
      totals?: Totals;
      remaining?: Macros;
      deleted?: { item?: string; food?: string; calories?: number };
      note?: string;
    }
  | { kind: "proposal"; proposals: ProposedFood[]; note?: string }
  | { kind: "info"; note: string; facts?: FactsView }
  | { kind: "clarify"; note: string }
  | { kind: "error"; note: string };

const whole = (x: number): number => Math.round(x);
const oneDec = (x: number): number => Math.round(x * 10) / 10;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function specServing(spec: FoodSpec): ServingSize | undefined {
  if (spec.servingQuantity != null && spec.servingUnit != null) {
    return { quantity: spec.servingQuantity, unit: spec.servingUnit };
  }
  return undefined;
}

function specMacros(spec: FoodSpec): MacroInput {
  const m: MacroInput = {};
  if (spec.calories != null) m.calories = spec.calories;
  if (spec.proteinG != null) m.proteinG = spec.proteinG;
  if (spec.fatG != null) m.fatG = spec.fatG;
  if (spec.carbsG != null) m.carbsG = spec.carbsG;
  return m;
}

function hasAnyMacro(spec: FoodSpec): boolean {
  return spec.calories != null || spec.proteinG != null || spec.fatG != null || spec.carbsG != null;
}

/** A saved food is "complete" when it has all three macros and (if an amount was
 * eaten) a serving to convert that amount against. */
function isComplete(food: FoodItem, amountEaten: string | null): boolean {
  const hasMacros = food.proteinG != null && food.fatG != null && food.carbsG != null;
  const servingOk = !amountEaten || !!food.serving;
  return hasMacros && servingOk;
}

function rawMacros(f: { calories: number; proteinG: number; fatG: number; carbsG: number }): Macros {
  return { calories: f.calories, proteinG: f.proteinG, fatG: f.fatG, carbsG: f.carbsG };
}

/** Reconcile if possible, otherwise fall back to the raw numbers. */
function reconcileToMacros(f: { calories: number; proteinG: number; fatG: number; carbsG: number }): Macros {
  const v = reconcileMacros(f);
  return v.status === "ok" || v.status === "completed" ? v.macros : rawMacros(f);
}

function makeProposed(
  spec: FoodSpec,
  macros: Macros,
  serving: ServingSize | null,
  sourceNote: string
): ProposedFood {
  return {
    item: spec.name,
    calories: whole(macros.calories),
    proteinG: oneDec(macros.proteinG),
    fatG: oneDec(macros.fatG),
    carbsG: oneDec(macros.carbsG),
    serving,
    amountEaten: spec.amountEaten,
    quantity: spec.quantity,
    sourceNote,
  };
}

function knownAsProposal(spec: FoodSpec, food: FoodItem): ProposedFood {
  return {
    item: food.item,
    calories: whole(food.calories),
    proteinG: oneDec(food.proteinG ?? 0),
    fatG: oneDec(food.fatG ?? 0),
    carbsG: oneDec(food.carbsG ?? 0),
    serving: food.serving ?? null,
    amountEaten: spec.amountEaten,
    quantity: spec.quantity,
    sourceNote: "already saved",
  };
}

function toLoggedItem(entry: DailyTrackerEntry): LoggedItem {
  return {
    item: entry.item,
    calories: whole(entry.calories),
    proteinG: oneDec(entry.proteinG),
    fatG: oneDec(entry.fatG),
    carbsG: oneDec(entry.carbsG),
  };
}

function cumulativeToTotals(entry: DailyTrackerEntry): Totals {
  return {
    calories: whole(entry.cumulativeCalories),
    proteinG: oneDec(entry.cumulativeProteinG),
    fatG: oneDec(entry.cumulativeFatG),
    carbsG: oneDec(entry.cumulativeCarbsG),
  };
}

function totalsFromEntries(entries: DailyTrackerEntry[]): Totals {
  const last = entries[entries.length - 1];
  if (!last) return { calories: 0, proteinG: 0, fatG: 0, carbsG: 0 };
  return cumulativeToTotals(last);
}

async function currentTotals(userId: string, day?: string): Promise<Totals> {
  const entries = await listDailyEntries(userId, day);
  return totalsFromEntries(entries);
}

type Acquired = { ok: true; food: ProposedFood } | { ok: false; result: WorkflowResult };

/** Search the web, validate, and (once) let the sanity LLM push a retry. Returns
 * the best numbers we could obtain, with a caution note if still shaky. */
async function searchViaWeb(
  name: string,
  emit: Emit
): Promise<
  | { ok: true; macros: Macros; serving: ServingSize; sourceNote: string }
  | { ok: false; result: WorkflowResult }
> {
  emit("search_nutrition_facts", "start");
  let facts: NutritionFacts;
  try {
    facts = await searchNutritionFacts(name);
  } catch {
    emit("search_nutrition_facts", "end");
    return { ok: false, result: { kind: "error", note: `I couldn't look up "${name}" right now. Try again in a moment.` } };
  }
  emit("search_nutrition_facts", "end");

  const v = reconcileMacros(facts);
  if (v.status === "invalid") {
    const verdict = await checkPlausibility({
      name,
      calories: facts.calories,
      proteinG: facts.proteinG,
      fatG: facts.fatG,
      carbsG: facts.carbsG,
      deterministicVerdict: `stated ${v.statedCalories} cal vs computed ${v.computedCalories} cal; suspect ${v.suspect.field}`,
    });
    if (verdict.action === "search") {
      emit("search_nutrition_facts", "start");
      try {
        const facts2 = await searchNutritionFacts(`${name} nutrition facts per serving`);
        emit("search_nutrition_facts", "end");
        const v2 = reconcileMacros(facts2);
        if (v2.status === "ok" || v2.status === "completed") {
          return { ok: true, macros: v2.macros, serving: facts2.serving, sourceNote: facts2.sourceNote };
        }
        return { ok: true, macros: rawMacros(facts2), serving: facts2.serving, sourceNote: `${facts2.sourceNote} (please double-check these)` };
      } catch {
        emit("search_nutrition_facts", "end");
      }
    }
    return { ok: true, macros: rawMacros(facts), serving: facts.serving, sourceNote: `${facts.sourceNote} (please double-check these)` };
  }

  return { ok: true, macros: reconcileToMacros(facts), serving: facts.serving, sourceNote: facts.sourceNote };
}

/** Turn a food the user mentioned but that we can't log as-is into a confirmable
 * proposal: prefer the user's own numbers, else look them up on the web. */
async function acquire(
  userId: string,
  spec: FoodSpec,
  existing: FoodItem | undefined,
  emit: Emit
): Promise<Acquired> {
  const serving = specServing(spec) ?? existing?.serving ?? null;

  // (1) The user gave their own numbers — trust them if they reconcile.
  if (hasAnyMacro(spec)) {
    const v = reconcileMacros(specMacros(spec));
    if (v.status === "ok" || v.status === "completed") {
      return { ok: true, food: makeProposed(spec, v.macros, serving, "your numbers") };
    }
    if (v.status === "invalid") {
      const verdict = await checkPlausibility({
        name: spec.name,
        calories: v.statedCalories,
        proteinG: spec.proteinG ?? 0,
        fatG: spec.fatG ?? 0,
        carbsG: spec.carbsG ?? 0,
        deterministicVerdict: `stated ${v.statedCalories} cal vs computed ${v.computedCalories} cal; suspect ${v.suspect.field}`,
      });
      if (verdict.action === "ask") {
        return {
          ok: false,
          result: { kind: "clarify", note: `Those numbers for "${spec.name}" don't add up — ${verdict.note}. Can you double-check them?` },
        };
      }
      // action "search"/"accept": fall through to a web lookup for better numbers.
    }
    // "incomplete": not enough of the user's numbers to reconcile — look it up.
  }

  // (2) Web lookup.
  const searched = await searchViaWeb(spec.name, emit);
  if (!searched.ok) return searched;
  return { ok: true, food: makeProposed(spec, searched.macros, searched.serving, searched.sourceNote) };
}

async function logFood(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  const items = intent.items ?? [];
  if (items.length === 0) return { kind: "clarify", note: "What did you eat?" };

  const ready: { spec: FoodSpec; food: FoodItem }[] = [];
  const proposals: ProposedFood[] = [];

  for (const spec of items) {
    emit("find_food_item", "start");
    const matches = await findFoodItem(userId, spec.name, 1);
    emit("find_food_item", "end");
    const food = matches[0];

    if (food && isComplete(food, spec.amountEaten) && !hasAnyMacro(spec)) {
      ready.push({ spec, food });
    } else {
      const acq = await acquire(userId, spec, food, emit);
      if (!acq.ok) return acq.result;
      proposals.push(acq.food);
    }
  }

  // If any item needs confirmation, propose the whole turn atomically (no writes).
  if (proposals.length > 0) {
    for (const r of ready.reverse()) proposals.unshift(knownAsProposal(r.spec, r.food));
    return { kind: "proposal", proposals };
  }

  // Everything is known & complete → log directly.
  const logged: LoggedItem[] = [];
  let last: DailyTrackerEntry | undefined;
  for (const r of ready) {
    emit("add_food_to_daily_count", "start");
    try {
      last = await addFoodToDailyCount(userId, r.food.item, r.spec.quantity ?? 1, specServing(r.spec), r.spec.amountEaten ?? undefined);
    } catch (e) {
      emit("add_food_to_daily_count", "end");
      return { kind: "clarify", note: errMsg(e) };
    }
    emit("add_food_to_daily_count", "end");
    logged.push(toLoggedItem(last));
  }

  const totals = last ? cumulativeToTotals(last) : await currentTotals(userId);
  return { kind: "result", action: "logged", logged, totals, remaining: computeRemaining(totals) };
}

async function confirmProposal(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  const items = intent.items ?? [];
  if (items.length === 0) {
    return { kind: "clarify", note: "There's nothing pending to confirm. What would you like to log?" };
  }

  const logged: LoggedItem[] = [];
  let last: DailyTrackerEntry | undefined;

  for (const spec of items) {
    // Final deterministic guard: the numbers copied from the proposal must still add up.
    const v = reconcileMacros(specMacros(spec));
    if (v.status !== "ok" && v.status !== "completed") {
      return { kind: "error", note: `I couldn't confirm "${spec.name}" — the numbers didn't validate, so nothing was saved.` };
    }
    const macros = v.macros;
    const serving = specServing(spec);

    emit("add_food_item", "start");
    try {
      await addFoodItem(userId, {
        item: spec.name,
        calories: macros.calories,
        proteinG: macros.proteinG,
        fatG: macros.fatG,
        carbsG: macros.carbsG,
        serving,
      });
    } catch (e) {
      emit("add_food_item", "end");
      return { kind: "error", note: errMsg(e) };
    }
    emit("add_food_item", "end");

    emit("add_food_to_daily_count", "start");
    try {
      last = await addFoodToDailyCount(userId, spec.name, spec.quantity ?? 1, serving, spec.amountEaten ?? undefined);
    } catch (e) {
      emit("add_food_to_daily_count", "end");
      return { kind: "clarify", note: errMsg(e) };
    }
    emit("add_food_to_daily_count", "end");
    logged.push(toLoggedItem(last));
  }

  const totals = last ? cumulativeToTotals(last) : await currentTotals(userId);
  return { kind: "result", action: "logged", logged, totals, remaining: computeRemaining(totals) };
}

async function addOrUpdateFood(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  const items = intent.items ?? [];
  if (items.length === 0) return { kind: "clarify", note: "Which food should I save, and what are its numbers?" };

  const saved: LoggedItem[] = [];
  const proposals: ProposedFood[] = [];

  for (const spec of items) {
    const v = reconcileMacros(specMacros(spec));
    if (hasAnyMacro(spec) && (v.status === "ok" || v.status === "completed")) {
      // Explicit save with numbers that add up → write directly (explicitly requested).
      emit("add_food_item", "start");
      try {
        await addFoodItem(userId, {
          item: spec.name,
          calories: v.macros.calories,
          proteinG: v.macros.proteinG,
          fatG: v.macros.fatG,
          carbsG: v.macros.carbsG,
          serving: specServing(spec),
        });
      } catch (e) {
        emit("add_food_item", "end");
        return { kind: "error", note: errMsg(e) };
      }
      emit("add_food_item", "end");
      saved.push({ item: spec.name, calories: whole(v.macros.calories), proteinG: oneDec(v.macros.proteinG), fatG: oneDec(v.macros.fatG), carbsG: oneDec(v.macros.carbsG) });
    } else {
      emit("find_food_item", "start");
      const existing = (await findFoodItem(userId, spec.name, 1))[0];
      emit("find_food_item", "end");
      const acq = await acquire(userId, spec, existing, emit);
      if (!acq.ok) return acq.result;
      proposals.push(acq.food);
    }
  }

  if (proposals.length > 0) {
    const note = saved.length ? `Saved: ${saved.map((s) => s.item).join(", ")}.` : undefined;
    return { kind: "proposal", proposals, note };
  }
  return { kind: "result", action: "saved", saved };
}

async function addAliasWorkflow(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  if (!intent.food || !intent.alias) {
    return { kind: "clarify", note: "Tell me the saved food and the new name for it." };
  }
  emit("add_alias", "start");
  try {
    await addAlias(userId, intent.food, intent.alias);
  } catch (e) {
    emit("add_alias", "end");
    return { kind: "clarify", note: errMsg(e) };
  }
  emit("add_alias", "end");
  return { kind: "result", action: "added_alias", note: `"${intent.alias}" now points to "${intent.food}".` };
}

async function deleteFood(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  if (!intent.food) return { kind: "clarify", note: "Which saved food should I delete?" };
  emit("delete_food_item", "start");
  try {
    await deleteFoodItem(userId, intent.food);
  } catch (e) {
    emit("delete_food_item", "end");
    return { kind: "clarify", note: errMsg(e) };
  }
  emit("delete_food_item", "end");
  return { kind: "result", action: "deleted_food", deleted: { food: intent.food } };
}

async function deleteEntry(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  if (intent.order == null) {
    return { kind: "clarify", note: "Which entry number should I remove? Say the number from today's log." };
  }
  emit("delete_daily_entry", "start");
  let deleted: DailyTrackerEntry;
  try {
    deleted = await deleteDailyEntry(userId, intent.day ?? undefined, intent.order);
  } catch (e) {
    emit("delete_daily_entry", "end");
    return { kind: "clarify", note: errMsg(e) };
  }
  emit("delete_daily_entry", "end");
  const totals = await currentTotals(userId, intent.day ?? undefined);
  return {
    kind: "result",
    action: "deleted_entry",
    deleted: { item: deleted.item, calories: whole(deleted.calories) },
    totals,
    remaining: computeRemaining(totals),
  };
}

async function listDay(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  emit("list_daily_entries", "start");
  const entries = await listDailyEntries(userId, intent.day ?? undefined);
  emit("list_daily_entries", "end");
  const totals = totalsFromEntries(entries);
  return {
    kind: "result",
    action: "day_list",
    entries: entries.map((e) => ({
      order: e.order,
      item: e.item,
      calories: whole(e.calories),
      proteinG: oneDec(e.proteinG),
      fatG: oneDec(e.fatG),
      carbsG: oneDec(e.carbsG),
    })),
    totals,
    remaining: computeRemaining(totals),
    note: entries.length === 0 ? "Nothing logged yet." : undefined,
  };
}

async function searchNutrition(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  if (!intent.food) return { kind: "clarify", note: "Which food do you want me to look up?" };
  const searched = await searchViaWeb(intent.food, emit);
  if (!searched.ok) return searched.result;
  return {
    kind: "info",
    note: "lookup",
    facts: {
      item: intent.food,
      calories: whole(searched.macros.calories),
      proteinG: oneDec(searched.macros.proteinG),
      fatG: oneDec(searched.macros.fatG),
      carbsG: oneDec(searched.macros.carbsG),
      serving: searched.serving,
      sourceNote: searched.sourceNote,
    },
  };
}

async function validateEntry(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  if (!intent.food) return { kind: "clarify", note: "Which saved food should I check?" };
  emit("find_food_item", "start");
  const food = (await findFoodItem(userId, intent.food, 1))[0];
  emit("find_food_item", "end");
  if (!food) return { kind: "clarify", note: `I don't have a saved food called "${intent.food}".` };

  const v = reconcileMacros({ calories: food.calories, proteinG: food.proteinG, fatG: food.fatG, carbsG: food.carbsG });
  if (v.status === "ok") {
    return {
      kind: "info",
      note: `"${food.item}" checks out: ${whole(food.calories)} cal from ${food.proteinG ?? 0}g protein, ${food.carbsG ?? 0}g carbs, ${food.fatG ?? 0}g fat.`,
    };
  }
  if (v.status === "completed") {
    return {
      kind: "proposal",
      proposals: [makeProposed({ name: food.item, amountEaten: null, quantity: null, calories: null, proteinG: null, fatG: null, carbsG: null, servingQuantity: food.serving?.quantity ?? null, servingUnit: food.serving?.unit ?? null }, v.macros, food.serving ?? null, `filled in the missing ${v.filled}`)],
      note: `"${food.item}" was missing a value; I can fill it in.`,
    };
  }
  // invalid or incomplete → look up better numbers and propose a fix.
  const acq = await acquire(userId, { name: food.item, amountEaten: null, quantity: null, calories: null, proteinG: null, fatG: null, carbsG: null, servingQuantity: null, servingUnit: null }, food, emit);
  if (!acq.ok) return acq.result;
  return { kind: "proposal", proposals: [acq.food], note: `"${food.item}" doesn't add up; here's a corrected set.` };
}

/** Route an intent to its workflow. Never throws — failures become an error result. */
export async function runWorkflow(userId: string, intent: Intent, emit: Emit): Promise<WorkflowResult> {
  try {
    switch (intent.intent) {
      case "log_food":
        return await logFood(userId, intent, emit);
      case "confirm":
        return await confirmProposal(userId, intent, emit);
      case "add_or_update_food":
        return await addOrUpdateFood(userId, intent, emit);
      case "add_alias":
        return await addAliasWorkflow(userId, intent, emit);
      case "delete_food":
        return await deleteFood(userId, intent, emit);
      case "delete_entry":
        return await deleteEntry(userId, intent, emit);
      case "list_day":
        return await listDay(userId, intent, emit);
      case "search_nutrition":
        return await searchNutrition(userId, intent, emit);
      case "validate_entry":
        return await validateEntry(userId, intent, emit);
      case "cancel":
        return { kind: "info", note: "Okay, cancelled — nothing was saved." };
      case "smalltalk":
        return { kind: "info", note: intent.message ?? "" };
      default:
        return { kind: "info", note: intent.message ?? "" };
    }
  } catch (e) {
    console.error("workflow error", e);
    return { kind: "error", note: "Something went wrong handling that. Please try again." };
  }
}
