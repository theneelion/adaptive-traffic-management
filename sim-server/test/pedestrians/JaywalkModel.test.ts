import { describe, it, expect } from "vitest";
import { jaywalkProbability } from "../../src/pedestrians/JaywalkModel";

describe("jaywalkProbability", () => {
  it("is zero while wait time is within patience", () => {
    expect(jaywalkProbability(3, 10)).toBe(0);
    expect(jaywalkProbability(10, 10)).toBe(0);
  });

  it("rises above zero once wait exceeds patience", () => {
    expect(jaywalkProbability(15, 10)).toBeGreaterThan(0);
  });

  it("is monotonically increasing in wait time beyond patience", () => {
    const p1 = jaywalkProbability(12, 10);
    const p2 = jaywalkProbability(20, 10);
    const p3 = jaywalkProbability(40, 10);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
  });

  it("never exceeds 0.95", () => {
    expect(jaywalkProbability(10_000, 10)).toBeLessThanOrEqual(0.95);
  });
});
