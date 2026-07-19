/**
 * Deterministic amount → serving-multiplier math. The LLM converts whatever the
 * user said into a canonical oz (weight) or floz (volume) amount, and the server
 * only divides it by the food's saved serving size — so the LLM never silently
 * divides "6oz eaten" by a saved "2oz" serving in its head (weaker models get
 * that wrong in either direction). Only oz and floz are accepted, matching how
 * servings are stored (see types.ts); a mass/volume mismatch is refused so the
 * caller asks a clarifying question instead of guessing.
 */

import type { ServingSize } from "../../types";

/** Parses a leading number (decimal or simple fraction) + trailing unit, e.g. "6oz", "1/2 floz". */
function parseAmount(text: string): { value: number; unit: string } | null {
  const s = text.trim();

  // Simple fraction, e.g. "1/2 oz"
  let match = s.match(/^(\d+)\/(\d+)\s*(.*)$/);
  if (match) {
    const [, num, den, rest] = match;
    const denom = Number(den);
    if (denom === 0) return null;
    return { value: Number(num) / denom, unit: normalizeUnit(rest) };
  }

  // Decimal or integer, e.g. "6oz", "2.5 floz"
  match = s.match(/^(\d*\.?\d+)\s*(.*)$/);
  if (match) {
    const [, num, rest] = match;
    const value = Number(num);
    if (!isFinite(value)) return null;
    return { value, unit: normalizeUnit(rest) };
  }

  return null;
}

/** Lowercase and strip spaces/punctuation, e.g. "FL OZ" -> "floz". */
function normalizeUnit(raw: string): string {
  return raw.toLowerCase().replace(/[.\s]/g, "");
}

/**
 * Computes how many servings `amountText` represents relative to a saved
 * `serving` of the same unit, e.g. computeQuantityFromServing({ quantity: 2,
 * unit: "oz" }, "6oz") === 3. Returns null if the amount doesn't parse or its
 * unit doesn't match the serving's (oz vs floz) — callers should surface that as
 * a request for clarification rather than falling back to a guess.
 */
export function computeQuantityFromServing(
  serving: ServingSize,
  amountText: string
): number | null {
  const amount = parseAmount(amountText);
  if (!amount || amount.value <= 0 || serving.quantity <= 0) return null;
  if (amount.unit !== serving.unit) return null;
  return amount.value / serving.quantity;
}

/** Renders a structured serving back to text for error messages, e.g. "2floz". */
export function formatServing(serving: ServingSize): string {
  return `${serving.quantity}${serving.unit}`;
}
