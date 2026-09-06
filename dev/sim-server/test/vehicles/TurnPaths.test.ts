import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildVehiclePath } from "../../src/vehicles/TurnPaths";

describe("buildVehiclePath", () => {
  const map = loadMap("../../maps/grid_1x1_v1.json");

  it("builds a straight path for an opposite entry/exit pair, starting and ending at the approaches' far points", () => {
    const path = buildVehiclePath(map, "app_N", "app_S");
    const start = path.pointAt(0);
    const end = path.pointAt(path.totalLength);
    // Each direction of travel is offset LANE_OFFSET to its own side of the road's raw centerline
    // (see TurnPaths.ts's offsetSegment) — this whole N->S trip travels in one consistent
    // direction (south) the entire way, so it stays on the same side throughout, exactly like a
    // real car doesn't swap sides mid-trip on a straight road. Precision loosened (rather than
    // hardcoding LANE_OFFSET's exact value) to tolerate reasonable future retuning of that constant.
    expect(Math.abs(start.x)).toBeLessThan(15);
    expect(start.y).toBeCloseTo(-300, 5);
    expect(Math.abs(end.x)).toBeLessThan(15);
    expect(end.y).toBeCloseTo(300, 5);
  });

  it("builds a curved path for an adjacent entry/exit pair that bulges toward the shared corner, not a straight line", () => {
    const path = buildVehiclePath(map, "app_N", "app_E");
    const midpoint = path.pointAt(path.totalLength / 2);
    expect(Math.hypot(midpoint.x - 150, midpoint.y - -150)).toBeGreaterThan(20);
  });

  it("reports a stopLineDistance strictly less than totalLength, positioned near the entry approach's own stop line", () => {
    const path = buildVehiclePath(map, "app_N", "app_W");
    expect(path.stopLineDistance).toBeGreaterThan(0);
    expect(path.stopLineDistance).toBeLessThan(path.totalLength);
    const stopPoint = path.pointAt(path.stopLineDistance);
    // Widened from 5 to 15 to allow for the entry lane's LANE_OFFSET (10) from the raw centerline.
    expect(Math.abs(stopPoint.x)).toBeLessThan(15);
    expect(stopPoint.y).toBeLessThan(0);
    expect(stopPoint.y).toBeGreaterThan(-30);
  });

  it("headingAt points roughly toward the next point on the path", () => {
    const path = buildVehiclePath(map, "app_W", "app_E");
    const heading = path.headingAt(0);
    expect(heading).toBeCloseTo(0, 1);
  });

  it("closestProgress recovers the correct distance for a point that lies on the path", () => {
    const path = buildVehiclePath(map, "app_N", "app_S");
    const knownDistance = 100;
    const point = path.pointAt(knownDistance);
    expect(path.closestProgress(point)).toBeCloseTo(knownDistance, 0);
  });

  it("closestProgress with a hint stays local, even when a curved path folds back near the entry segment", () => {
    const path = buildVehiclePath(map, "app_N", "app_E");
    // A point right at the start of the path is geometrically close to the corner bulge later
    // in the path too — without a hint, the global nearest-point search could latch onto that
    // far-away sample instead. With a hint near the true (small) progress, it must not.
    const nearStart = path.pointAt(5);
    const progress = path.closestProgress(nearStart, 5);
    expect(progress).toBeLessThan(path.stopLineDistance);
  });
});
