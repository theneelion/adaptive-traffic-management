import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";

describe("loadMap with curved-road fixture", () => {
  it("loads fixture_curved_3int.json with 3 intersections and a waypoints-bearing approach", () => {
    const map = loadMap("../../maps/fixture_curved_3int.json");
    expect(map.intersections).toHaveLength(3);
    const curved = map.approaches.find((a) => a.id === "b_from_c");
    expect(curved?.waypoints).toHaveLength(3);
  });

  it("grid_1x1_v1.json still loads with no approach ever having waypoints", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    expect(map.approaches.every((a) => a.waypoints === undefined)).toBe(true);
  });
});
