import { describe, it, expect } from "vitest";
import { computeQuantityFromServing, formatServing } from "./units";

describe("computeQuantityFromServing", () => {
  it("divides the eaten amount by the serving size", () => {
    expect(computeQuantityFromServing({ quantity: 2, unit: "oz" }, "6oz")).toBe(3);
  });

  it("handles decimals", () => {
    expect(computeQuantityFromServing({ quantity: 4, unit: "oz" }, "2.5 oz")).toBe(0.625);
  });

  it("handles simple fractions", () => {
    expect(computeQuantityFromServing({ quantity: 2, unit: "floz" }, "1/2 floz")).toBe(0.25);
  });

  it("normalizes spaced/punctuated units", () => {
    expect(computeQuantityFromServing({ quantity: 8, unit: "floz" }, "16 FL OZ")).toBe(2);
  });

  it("refuses a weight/volume mismatch instead of guessing", () => {
    expect(computeQuantityFromServing({ quantity: 2, unit: "oz" }, "6floz")).toBeNull();
  });

  it("returns null when the amount does not parse", () => {
    expect(computeQuantityFromServing({ quantity: 2, unit: "oz" }, "a bunch")).toBeNull();
  });

  it("returns null for a non-positive amount", () => {
    expect(computeQuantityFromServing({ quantity: 2, unit: "oz" }, "0oz")).toBeNull();
  });

  it("returns null for a divide-by-zero fraction", () => {
    expect(computeQuantityFromServing({ quantity: 2, unit: "oz" }, "1/0 oz")).toBeNull();
  });
});

describe("formatServing", () => {
  it("renders quantity + unit", () => {
    expect(formatServing({ quantity: 2, unit: "floz" })).toBe("2floz");
  });
});
