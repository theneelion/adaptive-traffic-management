import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";

describe("loadMap", () => {
  it("loads grid_1x1_v1 and exposes one intersection with two phases", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    expect(map.id).toBe("grid_1x1_v1");
    expect(map.intersections).toHaveLength(1);
    expect(map.intersections[0].phases).toHaveLength(2);
    expect(map.approaches).toHaveLength(4);
    expect(map.pedestrianNodes).toHaveLength(16);
    expect(map.pedestrianEdges).toHaveLength(20);
  });

  it("throws on a map missing required fields", () => {
    expect(() => loadMap("../maps/does_not_exist.json")).toThrow();
  });
});
