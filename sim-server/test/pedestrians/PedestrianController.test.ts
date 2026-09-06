import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";
import { PedestrianController } from "../../src/pedestrians/PedestrianController";
import { mulberry32 } from "../../src/util/mulberry32";

const ALL_CLEAR_FOR_PEDESTRIANS = new Map([
  ["app_N", "red"], ["app_S", "red"], ["app_E", "red"], ["app_W", "red"]
] as const);

describe("PedestrianController", () => {
  it("spawns pedestrians over time at the far nodes and moves them toward their destination", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
    const controller = new PedestrianController(world, graph, ["far_N", "far_S", "far_E", "far_W"], mulberry32(1), 60);

    for (let i = 0; i < 400; i++) {
      world.step(50);
      controller.step(50, ALL_CLEAR_FOR_PEDESTRIANS);
    }

    expect(controller.agents.length).toBeGreaterThan(0);
  });

  it("despawns a pedestrian once it reaches its destination node", () => {
    // A full far-to-far journey routes through an extra "bend" node at each end (added so
    // sidewalk paths stay outside the solid vehicle-lane walls instead of cutting diagonally
    // through them — see maps/grid_1x1_v1.json), so each journey is 5 hops (far->bend->corner
    // ->corner->bend->far). Empirically (bare-controller probe, mulberry32(2)) the first
    // pedestrian despawns at ~155-165s, and population grows with rising crowding (the
    // separation steering term slows agents down as density increases, extending average transit
    // time well beyond a single uncongested pedestrian's baseline) — at the previous 3/min/node
    // rate, population saturates the 60-agent cap by t=390s and never recovers, regardless of
    // whether despawn itself works. 1/min/node keeps steady-state demand comfortably below the
    // cap: empirically 10-15 agents through the full 300s (6000-tick) window used here.
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
    const controller = new PedestrianController(world, graph, ["far_N", "far_S", "far_E", "far_W"], mulberry32(2), 1);

    for (let i = 0; i < 6000; i++) {
      world.step(50);
      controller.step(50, ALL_CLEAR_FOR_PEDESTRIANS);
    }

    expect(controller.agents.length).toBeLessThan(40);
  });
});
