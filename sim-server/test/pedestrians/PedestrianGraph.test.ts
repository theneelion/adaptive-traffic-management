import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";

describe("PedestrianGraph", () => {
  const map = loadMap("../../maps/grid_1x1_v1.json");
  const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);

  it("finds a sidewalk path via the intermediate bend node", () => {
    expect(graph.shortestPath("far_N", "corner_NW")).toEqual(["far_N", "bend_N_NW", "corner_NW"]);
  });

  it("finds a path crossing the intersection via a crosswalk", () => {
    const path = graph.shortestPath("far_N", "far_S");
    expect(path[0]).toBe("far_N");
    expect(path.at(-1)).toBe("far_S");
    expect(path.some((id) => id.startsWith("corner_"))).toBe(true);
  });

  it("exposes the crossing/approach metadata for a crosswalk edge", () => {
    const edge = graph.edgeBetween("corner_NW", "corner_NE");
    expect(edge?.kind).toBe("crosswalk");
    expect(edge?.crossingId).toBe("cross_N");
    expect(edge?.approachId).toBe("app_N");
  });

  it("throws for an unreachable or unknown node", () => {
    expect(() => graph.shortestPath("far_N", "does_not_exist")).toThrow();
  });
});
