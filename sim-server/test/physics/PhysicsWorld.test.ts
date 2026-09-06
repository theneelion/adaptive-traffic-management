import { describe, it, expect } from "vitest";
import Matter from "matter-js";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";

describe("PhysicsWorld", () => {
  it("builds one static body per approach lane boundary pair from the map", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const solidStaticBodies = Matter.Composite.allBodies(world.engine.world).filter((b) => b.isStatic && !b.isSensor);
    // 4 approaches x 2 edges (left/right lane boundary) = 8 solid static bodies
    expect(solidStaticBodies).toHaveLength(8);
  });

  it("builds one non-solid queue-detection sensor zone per approach (Phase 2)", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const sensorZones = Matter.Composite.allBodies(world.engine.world).filter((b) => b.isSensor);
    expect(sensorZones).toHaveLength(4);
    expect(sensorZones.map((b) => b.label).sort()).toEqual(
      ["app_N_queue_zone", "app_S_queue_zone", "app_E_queue_zone", "app_W_queue_zone"].sort()
    );
  });

  it("advances physics time on step()", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const before = world.engine.timing.timestamp;
    world.step(16);
    expect(world.engine.timing.timestamp).toBeGreaterThan(before);
  });
});
