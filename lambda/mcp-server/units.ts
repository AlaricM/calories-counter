/**
 * Deterministic amount → serving-multiplier math, so the LLM never has to
 * silently divide "2oz" by a saved "1oz" serving in its head (weaker models
 * routinely get this wrong, in either direction). The LLM passes the amount it
 * heard from the user verbatim (e.g. "2oz", "1/2 cup") and the server computes
 * the multiplier — or refuses if the units can't be reconciled, forcing a
 * clarifying question instead of a silent guess.
 */

type UnitDimension = "mass" | "volume";

/** Canonical unit code -> conversion factor into the dimension's base unit (g or ml). */
const UNIT_FACTORS: Record<string, { dimension: UnitDimension; factor: number }> = {
  g: { dimension: "mass", factor: 1 },
  kg: { dimension: "mass", factor: 1000 },
  oz: { dimension: "mass", factor: 28.3495 },
  lb: { dimension: "mass", factor: 453.592 },
  ml: { dimension: "volume", factor: 1 },
  l: { dimension: "volume", factor: 1000 },
  tsp: { dimension: "volume", factor: 4.92892 },
  tbsp: { dimension: "volume", factor: 14.7868 },
  cup: { dimension: "volume", factor: 236.588 },
  floz: { dimension: "volume", factor: 29.5735 },
};

/** Raw unit spellings (already lowercased, punctuation-free) -> canonical unit code. */
const UNIT_SYNONYMS: Record<string, string> = {
  g: "g", gram: "g", grams: "g",
  kg: "kg", kilogram: "kg", kilograms: "kg",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  ml: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  l: "l", liter: "l", liters: "l", litre: "l", litres: "l",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  cup: "cup", cups: "cup",
  floz: "floz", "fl oz": "floz", "fluid ounce": "floz", "fluid ounces": "floz",
};

function extractNumber(input: string): { value: number; rest: string } | null {
  const s = input.trim();

  // Mixed number, e.g. "1 1/2 cups"
  let match = s.match(/^(\d+)\s+(\d+)\/(\d+)\s*(.*)$/);
  if (match) {
    const [, whole, num, den, rest] = match;
    const denom = Number(den);
    if (denom === 0) return null;
    return { value: Number(whole) + Number(num) / denom, rest: rest.trim() };
  }

  // Simple fraction, e.g. "1/2 cup" or "1/2cup"
  match = s.match(/^(\d+)\/(\d+)\s*(.*)$/);
  if (match) {
    const [, num, den, rest] = match;
    const denom = Number(den);
    if (denom === 0) return null;
    return { value: Number(num) / denom, rest: rest.trim() };
  }

  // Decimal or integer, e.g. "2.5 oz", "2oz", "100g"
  match = s.match(/^(\d*\.?\d+)\s*(.*)$/);
  if (match) {
    const [, num, rest] = match;
    const value = Number(num);
    if (!isFinite(value)) return null;
    return { value, rest: rest.trim() };
  }

  return null;
}

/** Normalizes a unit string to a canonical code, singularizing unrecognized words on a best-effort basis. */
function normalizeUnit(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "count"; // bare number with no unit, e.g. "2"
  if (cleaned in UNIT_SYNONYMS) return UNIT_SYNONYMS[cleaned];
  if (cleaned.endsWith("ies") && cleaned.length > 3) return `${cleaned.slice(0, -3)}y`;
  if (cleaned.endsWith("s") && cleaned.length > 1) return cleaned.slice(0, -1);
  return cleaned;
}

export function parseAmount(text: string): { value: number; unit: string } | null {
  const extracted = extractNumber(text);
  if (!extracted || extracted.value <= 0) return null;
  return { value: extracted.value, unit: normalizeUnit(extracted.rest) };
}

/**
 * Computes how many servings `requestedText` represents relative to
 * `servingText` (the food's saved serving size), e.g.
 * computeQuantityFromAmounts("1oz", "2oz") === 2. Returns null if either
 * string doesn't parse, or if the units are for incompatible dimensions
 * (e.g. grams vs. cups) — callers should surface that as a request for
 * clarification rather than falling back to a guess.
 */
export function computeQuantityFromAmounts(
  servingText: string,
  requestedText: string
): number | null {
  const serving = parseAmount(servingText);
  const requested = parseAmount(requestedText);
  if (!serving || !requested || serving.value === 0) return null;

  if (serving.unit === requested.unit) {
    return requested.value / serving.value;
  }

  const servingFactor = UNIT_FACTORS[serving.unit];
  const requestedFactor = UNIT_FACTORS[requested.unit];
  if (servingFactor && requestedFactor && servingFactor.dimension === requestedFactor.dimension) {
    const servingBase = serving.value * servingFactor.factor;
    const requestedBase = requested.value * requestedFactor.factor;
    return requestedBase / servingBase;
  }

  return null;
}
