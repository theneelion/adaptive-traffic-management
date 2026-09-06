import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildRoadGraph } from "../../src/ev/RoadGraph";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";

describe("city_v1.json structural validation", () => {
  it("loads without throwing", () => {
    expect(() => loadMap("../../maps/city_v1.json")).not.toThrow();
  });

  const map = loadMap("../../maps/city_v1.json");

  it("has 9 intersections, each with exactly 2 phases partitioning its own approaches with no overlap and no omission", () => {
    expect(map.intersections).toHaveLength(9);
    for (const intersection of map.intersections) {
      expect(intersection.phases).toHaveLength(2);
      const ownApproachIds = map.approaches.filter((a) => a.intersectionId === intersection.id).map((a) => a.id);
      const phaseIds = intersection.phases.flatMap((p) => p.allowedApproachIds!);
      expect(new Set(phaseIds)).toEqual(new Set(ownApproachIds));
      expect(phaseIds).toHaveLength(ownApproachIds.length); // no duplicate membership across phases
    }
  });

  it("the vehicle road graph connects every pair of terminal approaches", () => {
    const graph = buildRoadGraph(map);
    const terminalApproachIds = map.approaches
      .filter((a) => !map.intersections.some((i) => Math.hypot(i.x - a.laneStartX, i.y - a.laneStartY) < 1))
      .map((a) => a.id);
    expect(terminalApproachIds.length).toBe(9);

    for (const from of terminalApproachIds) {
      for (const to of terminalApproachIds) {
        if (from === to) continue;
        expect(() => graph.shortestPath(`end_${from}`, `end_${to}`)).not.toThrow();
      }
    }
  });

  it("the pedestrian graph connects every pair of far_ terminal nodes", () => {
    const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
    const farNodeIds = map.pedestrianNodes.filter((n) => n.id.startsWith("far_")).map((n) => n.id);
    expect(farNodeIds.length).toBe(9);

    for (const from of farNodeIds) {
      for (const to of farNodeIds) {
        if (from === to) continue;
        expect(() => graph.shortestPath(from, to)).not.toThrow();
      }
    }
  });
});
