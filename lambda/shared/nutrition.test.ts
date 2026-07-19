import { describe, it, expect } from "vitest";
import { reconcileMacros, computeRemaining } from "./nutrition";
import { TARGETS } from "./targets";

describe("reconcileMacros — completing a missing value", () => {
  it("fills the remaining carbs (worked example: 150 cal, 30g protein, 3g fat)", () => {
    // 30*4 + 3*9 = 147; the missing carbs account for the other 3 cal → ~0.75 g.
    const r = reconcileMacros({ calories: 150, proteinG: 30, fatG: 3 });
    expect(r.status).toBe("completed");
    if (r.status !== "completed") throw new Error("expected completed");
    expect(r.filled).toBe("carbsG");
    expect(r.macros.carbsG).toBeCloseTo(0.8, 1);
    expect(r.macros.calories).toBe(150);
  });

  it("computes calories from three macros", () => {
    const r = reconcileMacros({ proteinG: 10, carbsG: 20, fatG: 10 });
    expect(r.status).toBe("completed");
    if (r.status !== "completed") throw new Error("expected completed");
    expect(r.filled).toBe("calories");
    expect(r.macros.calories).toBe(210); // 40 + 80 + 90
  });

  it("clamps a slightly-negative computed macro to zero (rounding noise)", () => {
    const r = reconcileMacros({ calories: 118, proteinG: 30, fatG: 0 });
    expect(r.status).toBe("completed");
    if (r.status !== "completed") throw new Error("expected completed");
    expect(r.filled).toBe("carbsG");
    expect(r.macros.carbsG).toBe(0);
  });
});

describe("reconcileMacros — flagging impossible data", () => {
  it("flags implausible data and blames fat (worked example: 110 cal, 70g fat, 3g protein, 20g carbs)", () => {
    const r = reconcileMacros({ calories: 110, fatG: 70, proteinG: 3, carbsG: 20 });
    expect(r.status).toBe("invalid");
    if (r.status !== "invalid") throw new Error("expected invalid");
    expect(r.statedCalories).toBe(110);
    expect(r.computedCalories).toBe(722); // 12 + 80 + 630
    expect(r.suspect.field).toBe("fatG");
    // Refitting fat from the rest: (110 - 12 - 80) / 9 ≈ 2 g.
    expect(r.suspect.suggested).toBeCloseTo(2, 0);
  });

  it("flags two provided macros that already overshoot the stated calories", () => {
    // 20g protein (80) + 5g fat (45) = 125 cal, but only 100 stated; carbs would be negative.
    const r = reconcileMacros({ calories: 100, proteinG: 20, fatG: 5 });
    expect(r.status).toBe("invalid");
    if (r.status !== "invalid") throw new Error("expected invalid");
    expect(r.computedCalories).toBe(125);
  });

  it("flags a mismatch beyond tolerance when all four are present", () => {
    // 10p + 10c + 5f = 40 + 40 + 45 = 125 vs stated 100 → 25 off, tol = 15.
    const r = reconcileMacros({ calories: 100, proteinG: 10, carbsG: 10, fatG: 5 });
    expect(r.status).toBe("invalid");
  });
});

describe("reconcileMacros — ok and incomplete", () => {
  it("accepts a consistent set within tolerance", () => {
    const r = reconcileMacros({ calories: 210, proteinG: 10, carbsG: 20, fatG: 10 });
    expect(r.status).toBe("ok");
  });

  it("accepts normal label rounding within ~10%", () => {
    // 10p + 10c + 2f = 40 + 40 + 18 = 98 vs stated 100 → within tolerance.
    const r = reconcileMacros({ calories: 100, proteinG: 10, carbsG: 10, fatG: 2 });
    expect(r.status).toBe("ok");
  });

  it("reports incomplete when only calories are known", () => {
    const r = reconcileMacros({ calories: 200 });
    expect(r.status).toBe("incomplete");
    if (r.status !== "incomplete") throw new Error("expected incomplete");
    expect(r.have).toEqual(["calories"]);
    expect(r.missing).toEqual(["proteinG", "fatG", "carbsG"]);
  });

  it("reports incomplete with only two of four values", () => {
    const r = reconcileMacros({ calories: 200, proteinG: 10 });
    expect(r.status).toBe("incomplete");
  });

  it("ignores negative/non-finite fields as absent", () => {
    const r = reconcileMacros({ calories: 200, proteinG: -5, fatG: NaN });
    expect(r.status).toBe("incomplete");
  });
});

describe("computeRemaining", () => {
  it("subtracts consumed totals from the daily targets", () => {
    const remaining = computeRemaining({ calories: 500, proteinG: 40, fatG: 20, carbsG: 60 });
    expect(remaining.calories).toBe(TARGETS.calories - 500);
    expect(remaining.proteinG).toBe(TARGETS.proteinG - 40);
    expect(remaining.fatG).toBe(TARGETS.fatG - 20);
    expect(remaining.carbsG).toBe(TARGETS.carbsG - 60);
  });

  it("goes negative when over a target", () => {
    const remaining = computeRemaining({ calories: 2500, proteinG: 0, fatG: 0, carbsG: 0 });
    expect(remaining.calories).toBe(TARGETS.calories - 2500);
    expect(remaining.calories).toBeLessThan(0);
  });
});
