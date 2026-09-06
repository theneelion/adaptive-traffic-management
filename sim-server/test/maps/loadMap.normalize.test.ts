import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { isTerminalApproach } from "../../src/maps/MapDefinition";

describe("loadMap phase normalization", () => {
  it("derives allowedApproachIds from legacy allowedDirections for grid_1x1_v1.json", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const nsPhase = map.intersections[0].phases.find((p) => p.id === "NS_through")!;
    expect(new Set(nsPhase.allowedApproachIds)).toEqual(new Set(["app_N", "app_S"]));
  });

  it("passes through explicit allowedApproachIds unchanged for fixture_curved_3int.json", () => {
    const map = loadMap("../../maps/fixture_curved_3int.json");
    for (const intersection of map.intersections) {
      for (const phase of intersection.phases) {
        expect(phase.allowedApproachIds!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("isTerminalApproach", () => {
  it("every grid_1x1_v1.json approach is terminal (all 4 laneStarts are far spawn points)", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    for (const a of map.approaches) expect(isTerminalApproach(map, a)).toBe(true);
  });

  it("connector approaches in fixture_curved_3int.json are not terminal; true far approaches are", () => {
    const map = loadMap("../../maps/fixture_curved_3int.json");
    const byId = (id: string) => map.approaches.find((a) => a.id === id)!;
    expect(isTerminalApproach(map, byId("a_from_b"))).toBe(false); // laneStart = int_B
    expect(isTerminalApproach(map, byId("b_from_c"))).toBe(false); // laneStart = int_C
    expect(isTerminalApproach(map, byId("a_far_west"))).toBe(true);
    expect(isTerminalApproach(map, byId("c_far_east"))).toBe(true);
  });
});
