import { describe, expect, it } from "vitest";
import { applyBasisPoints, divideHalfEven, percentToBps, proportion } from "../src/money";

describe("money", () => {
  it("applies basis points with half-even rounding", () => {
    expect(applyBasisPoints(10_000, 2_000)).toBe(2_000); // 20% of 100.00
    expect(applyBasisPoints(1_001, 1_250)).toBe(125); // 125.125 -> 125
    expect(applyBasisPoints(1_005, 500)).toBe(50); // 50.25 -> 50
    expect(applyBasisPoints(3, 5_000)).toBe(2); // 1.5 -> 2 (even)
    expect(applyBasisPoints(5, 5_000)).toBe(2); // 2.5 -> 2 (even)
    expect(applyBasisPoints(7, 5_000)).toBe(4); // 3.5 -> 4 (even)
  });

  it("rejects non-integer amounts", () => {
    expect(() => applyBasisPoints(10.5, 100)).toThrow(TypeError);
    expect(() => applyBasisPoints(100, -1)).toThrow(RangeError);
  });

  it("divides half-even with negatives", () => {
    expect(divideHalfEven(-5, 2)).toBe(-2);
    expect(divideHalfEven(-7, 2)).toBe(-4);
    expect(divideHalfEven(9, 3)).toBe(3);
  });

  it("computes proportions", () => {
    expect(proportion(2_000, 75_000, 100_000)).toBe(1_500);
    expect(() => proportion(100, 101, 100)).toThrow(RangeError);
  });

  it("converts percent to bps", () => {
    expect(percentToBps(20)).toBe(2_000);
    expect(percentToBps(12.5)).toBe(1_250);
  });
});
