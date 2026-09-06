import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildRoadGraph } from "../../src/ev/RoadGraph";

describe("buildRoadGraph / RoadGraph", () => {
  const map = loadMap("../../maps/grid_1x1_v1.json");
  const graph = buildRoadGraph(map);

  it("derives one end node per approach plus one node per intersection", () => {
    expect(graph.node("end_app_N")).toBeDefined();
    expect(graph.node("int_1")).toBeDefined();
  });

  it("routes from one approach's end node to the opposite approach's end node via the intersection", () => {
    const route = graph.shortestPath("end_app_N", "end_app_S");
    expect(route.nodeIds).toEqual(["end_app_N", "int_1", "end_app_S"]);
    expect(route.edges).toHaveLength(2);
    expect(route.edges[0].approachId).toBe("app_N");
    expect(route.edges[1].approachId).toBe("app_S");
  });

  it("throws for an unknown node", () => {
    expect(() => graph.shortestPath("end_app_N", "does_not_exist")).toThrow();
  });
});
