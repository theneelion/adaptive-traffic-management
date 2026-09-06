import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildApproachCenterline } from "../../src/vehicles/TurnPaths";

describe("buildApproachCenterline", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");

  it("a straight approach's centerline has length equal to the direct laneStart-laneEnd distance", () => {
    const approach = map.approaches.find((a) => a.id === "a_far_west")!;
    const centerline = buildApproachCenterline(approach);
    expect(centerline.length).toBeCloseTo(300, 5);
    const start = centerline.pointAtDistance(0);
    expect(start.x).toBeCloseTo(-300, 5);
    expect(start.y).toBeCloseTo(0, 5);
  });

  it("a curved approach's centerline is longer than the direct laneStart-laneEnd distance (it bends, so it isn't the shortest path)", () => {
    const approach = map.approaches.find((a) => a.id === "b_from_c")!;
    const centerline = buildApproachCenterline(approach);
    const directDistance = Math.hypot(400 - 700, 0 - 250);
    expect(centerline.length).toBeGreaterThan(directDistance);
  });

  it("a curved approach's centerline starts and ends at its laneStart/laneEnd exactly", () => {
    const approach = map.approaches.find((a) => a.id === "b_from_c")!;
    const centerline = buildApproachCenterline(approach);
    const start = centerline.pointAtDistance(0);
    const end = centerline.pointAtDistance(centerline.length);
    expect(start.x).toBeCloseTo(700, 1);
    expect(start.y).toBeCloseTo(250, 1);
    expect(end.x).toBeCloseTo(400, 1);
    expect(end.y).toBeCloseTo(0, 1);
  });

  it("grid_1x1_v1.json's approaches (no waypoints) produce a centerline identical to a plain straight line", () => {
    const gridMap = loadMap("../../maps/grid_1x1_v1.json");
    const approach = gridMap.approaches.find((a) => a.id === "app_N")!;
    const centerline = buildApproachCenterline(approach);
    expect(centerline.length).toBeCloseTo(Math.hypot(approach.laneEndX - approach.laneStartX, approach.laneEndY - approach.laneStartY), 5);
  });
});
