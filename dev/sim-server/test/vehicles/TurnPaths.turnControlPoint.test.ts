import { describe, it, expect } from "vitest";
import { isRoughlyOpposite, turnControlPoint } from "../../src/vehicles/TurnPaths";

describe("isRoughlyOpposite", () => {
  it("headings exactly 180 degrees apart are opposite", () => {
    expect(isRoughlyOpposite(0, Math.PI)).toBe(true);
  });
  it("headings 90 degrees apart are not opposite", () => {
    expect(isRoughlyOpposite(0, Math.PI / 2)).toBe(false);
  });
  it("headings 170 degrees apart are opposite within the default tolerance", () => {
    expect(isRoughlyOpposite(0, (170 * Math.PI) / 180)).toBe(true);
  });
});

describe("turnControlPoint", () => {
  it("for a 90-degree turn at a non-origin intersection, the control point sits near that intersection, not near (0,0)", () => {
    const point = turnControlPoint({ x: 380, y: 0 }, 0, { x: 400, y: -20 }, -Math.PI / 2, 0.4);
    const distanceFromIntersection = Math.hypot(point.x - 400, point.y - 0);
    const distanceFromOrigin = Math.hypot(point.x, point.y);
    expect(distanceFromIntersection).toBeLessThan(distanceFromOrigin);
  });

  it("does not throw for a near-parallel entry/exit (degenerate ray intersection)", () => {
    expect(() => turnControlPoint({ x: 0, y: 0 }, 0, { x: 100, y: 0.001 }, 0.0001, 0.4)).not.toThrow();
  });
});
