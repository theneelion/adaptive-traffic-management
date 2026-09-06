import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { headingIntoIntersection, headingOutOfIntersection } from "../../src/vehicles/TurnPaths";

describe("heading computation", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");

  it("a straight (non-waypoint) approach's heading matches its laneStart->laneEnd direction", () => {
    const approach = map.approaches.find((a) => a.id === "a_far_west")!;
    // laneStart=(-300,0) -> laneEnd=(0,0): heading 0 (facing +x)
    expect(headingIntoIntersection(approach)).toBeCloseTo(0, 5);
  });

  it("a curved approach's heading-into-intersection matches the tangent of its final waypoint segment, not the straight laneStart->laneEnd line", () => {
    const approach = map.approaches.find((a) => a.id === "b_from_c")!;
    // waypoints: (700,250) -> (550,40) -> (400,0) (this approach belongs to int_B and represents
    // arriving there from C's direction, so its waypoints run C->B). Final segment tangent
    // (550,40)->(400,0) != the overall laneStart(700,250)->laneEnd(400,0) straight-line angle,
    // because the curve bends more sharply in its final stretch.
    const straightLineHeading = Math.atan2(0 - 250, 400 - 700);
    const tangentHeading = headingIntoIntersection(approach);
    expect(Math.abs(tangentHeading - straightLineHeading)).toBeGreaterThan(0.01);
  });

  it("headingOutOfIntersection points away from the intersection for an approach leaving it", () => {
    const approach = map.approaches.find((a) => a.id === "b_from_a")!;
    // b_from_a: laneStart=(0,0) [at int_A's position] -> laneEnd=(400,0) [at int_B]. This approach
    // is int_B's *entry* from A, so "out of intersection" here means away from int_B, i.e. back
    // toward A: heading pi (facing -x).
    expect(Math.abs(headingOutOfIntersection(approach))).toBeCloseTo(Math.PI, 1);
  });
});
