import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";
import { PedestrianController } from "../../src/pedestrians/PedestrianController";
import { mulberry32 } from "../../src/util/mulberry32";

function runAndCollectPositions(seed: number): { id: string; x: number; y: number }[] {
  const map = loadMap("../../maps/grid_1x1_v1.json");
  const world = new PhysicsWorld(map);
  const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
  const controller = new PedestrianController(world, graph, ["far_N", "far_S", "far_E", "far_W"], mulberry32(seed), 60);
  const neverSafeForN = new Map([
    ["app_N", "green"], ["app_S", "green"], ["app_E", "red"], ["app_W", "red"]
  ] as const);

  for (let i = 0; i < 500; i++) {
    world.step(50);
    controller.step(50, neverSafeForN);
  }
  return controller.agents;
}

describe("pedestrian determinism", () => {
  it("produces identical agent positions run-to-run given the same seed", () => {
    expect(runAndCollectPositions(4242)).toEqual(runAndCollectPositions(4242));
  });
});
