import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildMultiHopVehiclePath } from "../../src/vehicles/TurnPaths";

describe("buildMultiHopVehiclePath across two intersections", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");

  it("a 3-approach route (enter int_B, cross into int_C via the connector, exit) has 2 stop lines, in order", () => {
    const path = buildMultiHopVehiclePath(map, ["b_far_north", "c_from_b", "c_far_east"]);
    expect(path.stopLines).toHaveLength(2);
    expect(path.stopLines[0].approachId).toBe("b_far_north");
    expect(path.stopLines[1].approachId).toBe("c_from_b");
    expect(path.stopLines[0].distance).toBeLessThan(path.stopLines[1].distance);
    expect(path.stopLines[1].distance).toBeLessThan(path.totalLength);
  });

  it("ends near c_far_east's far point (1000, 250)", () => {
    const path = buildMultiHopVehiclePath(map, ["b_far_north", "c_from_b", "c_far_east"]);
    const end = path.pointAt(path.totalLength);
    // Precision loosened to -2 (tolerance ~50) to allow for LANE_OFFSET (10) shifting the path off
    // the raw centerline/far point — see TurnPaths.ts's offsetSegment.
    expect(end.x).toBeCloseTo(1000, -2);
    expect(end.y).toBeCloseTo(250, -2);
  });

  it("approachIdAt reports the correct approach for known points along the route", () => {
    const path = buildMultiHopVehiclePath(map, ["b_far_north", "c_from_b", "c_far_east"]);
    expect(path.approachIdAt(10)).toBe("b_far_north");
    expect(path.approachIdAt(path.totalLength - 10)).toBe("c_far_east");
  });
});
