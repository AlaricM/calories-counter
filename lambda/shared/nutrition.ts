/**
 * Deterministic nutrition validation — the reliability core. NO LLM, no I/O, no
 * arithmetic delegated to a model. Everything here is pure functions that enforce
 * the physical relationship
 *
 *     calories ≈ 4·protein_g + 4·carbs_g + 9·fat_g
 *
 * and compute "what's left today" against the daily targets. The old design only
 * stated this rule in prose in the system prompt and hoped the model followed it;
 * now it is executed in code, so an impossible combination can never be stored.
 */

import { TARGETS, type DailyTargets } from "./targets";

const PROTEIN_KCAL = 4;
const CARB_KCAL = 4;
const FAT_KCAL = 9;

/** The four fields we reason about. */
export type MacroField = "calories" | "proteinG" | "fatG" | "carbsG";

/** Any subset of the four values (what a user/search may have provided). */
export type MacroInput = {
  calories?: number;
  proteinG?: number;
  fatG?: number;
  carbsG?: number;
};

/** A complete, reconciled set of numbers. */
export type Macros = {
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
};

export type ValidationResult =
  /** All four present and they add up within tolerance. */
  | { status: "ok"; macros: Macros }
  /** Exactly one field was missing and we solved it unambiguously. */
  | { status: "completed"; macros: Macros; filled: MacroField }
  /** The numbers cannot physically coexist. `suspect` is the field most likely wrong. */
  | {
      status: "invalid";
      statedCalories: number;
      computedCalories: number;
      suspect: { field: MacroField; suggested?: number };
    }
  /** Too little information to reconcile (fewer than 3 of the 4 values). */
  | { status: "incomplete"; have: MacroField[]; missing: MacroField[] };

const MACRO_FIELDS: Exclude<MacroField, "calories">[] = ["proteinG", "carbsG", "fatG"];

function present(x: number | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function kcalFor(field: MacroField): number {
  return field === "fatG" ? FAT_KCAL : PROTEIN_KCAL; // protein and carbs are both 4
}

/** kcal implied by a full macro triple. */
function caloriesFromMacros(m: { proteinG: number; carbsG: number; fatG: number }): number {
  return PROTEIN_KCAL * m.proteinG + CARB_KCAL * m.carbsG + FAT_KCAL * m.fatG;
}

/**
 * Reconciliation slack. Real labels are off from a strict 4/4/9 by rounding,
 * fiber/sugar-alcohol accounting, and alcohol, so we allow ~10% (min 15 kcal)
 * before calling a combination impossible. This is wide enough to accept normal
 * foods and the user's own numbers, but still catches gross errors like 70 g of
 * fat in a 110-calorie serving.
 */
function tolerance(calories: number): number {
  return Math.max(calories * 0.1, 15);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Given stated calories that don't match a macro triple, decide which single
 * field is most likely wrong. For each macro, refit it from calories minus the
 * other two contributions; a non-negative refit is a candidate, and the field
 * whose current value deviates most from its refit is the prime suspect (its
 * refit is offered as `suggested`). If no single field can be refit to a
 * non-negative value the data is badly broken — flag the largest calorie
 * contributor with no suggestion.
 */
function pickSuspect(
  calories: number,
  m: { proteinG: number; carbsG: number; fatG: number }
): { field: MacroField; suggested?: number } {
  const candidates: { field: MacroField; suggested: number; deviation: number }[] = [];
  for (const field of MACRO_FIELDS) {
    const otherContribution = MACRO_FIELDS.filter((f) => f !== field).reduce(
      (sum, f) => sum + kcalFor(f) * m[f],
      0
    );
    const refit = (calories - otherContribution) / kcalFor(field);
    if (refit >= 0) {
      candidates.push({ field, suggested: round1(refit), deviation: Math.abs(m[field] - refit) });
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.deviation - a.deviation);
    return { field: candidates[0].field, suggested: candidates[0].suggested };
  }
  // No single-field fix reconciles — point at the biggest contributor.
  let biggest: MacroField = MACRO_FIELDS[0];
  let best = -1;
  for (const f of MACRO_FIELDS) {
    const contrib = kcalFor(f) * m[f];
    if (contrib > best) {
      best = contrib;
      biggest = f;
    }
  }
  return { field: biggest };
}

/**
 * Enforce the 4/4/9 relationship on whatever subset of values we have:
 * - 4 present → reconcile (ok) or flag (invalid, with the suspect field).
 * - exactly 3 present → solve the 4th (completed) or flag if it comes out
 *   impossibly negative (invalid).
 * - fewer than 3 → incomplete (needs a lookup or the user's numbers).
 */
export function reconcileMacros(input: MacroInput): ValidationResult {
  const hasCal = present(input.calories);
  const presentMacros = MACRO_FIELDS.filter((f) => present(input[f]));
  const knownCount = (hasCal ? 1 : 0) + presentMacros.length;

  if (knownCount <= 2) {
    const have: MacroField[] = [
      ...(hasCal ? (["calories"] as MacroField[]) : []),
      ...presentMacros,
    ];
    const all: MacroField[] = ["calories", "proteinG", "fatG", "carbsG"];
    return { status: "incomplete", have, missing: all.filter((f) => !have.includes(f)) };
  }

  // knownCount is 3 or 4 from here on.
  const p = input.proteinG ?? 0;
  const c = input.carbsG ?? 0;
  const f = input.fatG ?? 0;

  // All four present → reconcile.
  if (knownCount === 4) {
    const computed = caloriesFromMacros({ proteinG: p, carbsG: c, fatG: f });
    if (Math.abs(input.calories! - computed) <= tolerance(input.calories!)) {
      return { status: "ok", macros: { calories: input.calories!, proteinG: p, fatG: f, carbsG: c } };
    }
    return {
      status: "invalid",
      statedCalories: input.calories!,
      computedCalories: round1(computed),
      suspect: pickSuspect(input.calories!, { proteinG: p, carbsG: c, fatG: f }),
    };
  }

  // Exactly 3 present → one field is missing; solve it.
  if (!hasCal) {
    // Missing calories: always derivable and non-negative.
    const calories = round1(caloriesFromMacros({ proteinG: p, carbsG: c, fatG: f }));
    return { status: "completed", filled: "calories", macros: { calories, proteinG: p, fatG: f, carbsG: c } };
  }

  // Missing exactly one macro; solve it from calories.
  const missing = MACRO_FIELDS.find((fld) => !present(input[fld]))!;
  const otherContribution = MACRO_FIELDS.filter((fld) => fld !== missing).reduce(
    (sum, fld) => sum + kcalFor(fld) * (input[fld] ?? 0),
    0
  );
  const value = (input.calories! - otherContribution) / kcalFor(missing);

  // A small negative (within the calorie tolerance) is rounding noise → clamp to 0.
  if (value * kcalFor(missing) >= -tolerance(input.calories!)) {
    const filledValue = Math.max(0, round1(value));
    const macros: Macros = { calories: input.calories!, proteinG: p, fatG: f, carbsG: c, [missing]: filledValue };
    return { status: "completed", filled: missing, macros };
  }

  // The two provided macros already overshoot the stated calories → impossible.
  return {
    status: "invalid",
    statedCalories: input.calories!,
    computedCalories: round1(otherContribution),
    suspect: pickSuspect(input.calories!, { proteinG: p, carbsG: c, fatG: f }),
  };
}

/** Consumed-so-far totals (from the daily tracker's cumulative fields). */
export type Consumed = {
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
};

/** What's left against the day's targets — negative means over. */
export function computeRemaining(consumed: Consumed, targets: DailyTargets = TARGETS): Macros {
  return {
    calories: Math.round(targets.calories - consumed.calories),
    proteinG: Math.round(targets.proteinG - consumed.proteinG),
    fatG: Math.round(targets.fatG - consumed.fatG),
    carbsG: Math.round(targets.carbsG - consumed.carbsG),
  };
}
