/**
 * Daily targets — plain data, no LLM. Lifted out of the old monolithic system
 * prompt so that "how much is left today" is computed deterministically
 * (see computeRemaining in ./nutrition), never by asking a model to subtract.
 *
 * EDIT THESE TO YOUR OWN NUMBERS and redeploy.
 */
export type DailyTargets = {
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
};

export const TARGETS: DailyTargets = {
  calories: 2200, // hard cap
  proteinG: 170, // protect — aim to hit this
  fatG: 70, // a ceiling to flex under
  carbsG: 220, // the flexible remainder
};
