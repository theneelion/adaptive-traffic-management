import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildRoadGraph } from "../../src/ev/RoadGraph";

describe("buildRoadGraph on a multi-intersection fixture", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");
  const graph = buildRoadGraph(map);

  it("routes from a far approach at int_B to a far approach at int_C via the b_from_c/c_from_b connector", () => {
    const route = graph.shortestPath("end_b_far_north", "end_c_far_east");
    expect(route.nodeIds).toEqual(["end_b_far_north", "int_B", "int_C", "end_c_far_east"]);
    expect(route.edges.map((e) => e.approachId)).toEqual(["b_far_north", "c_from_b", "c_far_east"]);
  });

  it("routes the other direction, using the opposite connector approach", () => {
    const route = graph.shortestPath("end_c_far_east", "end_b_far_north");
    expect(route.edges.map((e) => e.approachId)).toEqual(["c_far_east", "b_from_c", "b_far_north"]);
  });
});
