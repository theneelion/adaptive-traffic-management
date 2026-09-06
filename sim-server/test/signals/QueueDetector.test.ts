import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { QueueDetector } from "../../src/signals/QueueDetector";

describe("QueueDetector", () => {
  it("detects a stationary vehicle inside the queue zone as queued, with growing wait time", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    // app_N's queue zone sits just north of the intersection (laneEndY=0, laneStartY=-300, so zone center is near y=-30)
    const car = new VehicleBody(world, "car_1", { x: 0, y: -30, heading: Math.PI / 2 });
    const detector = new QueueDetector(world, map.approaches);

    for (let i = 0; i < 10; i++) {
      world.step(16);
      detector.step(16, [car]);
    }

    const state = detector.getApproachState("app_N");
    expect(state.queueLength).toBe(1);
    expect(state.waitS).toBeGreaterThan(0);
  });

  it("reports zero queue length once the vehicle leaves the zone", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const car = new VehicleBody(world, "car_1", { x: 200, y: -300, heading: Math.PI / 2 });
    const detector = new QueueDetector(world, map.approaches);

    for (let i = 0; i < 5; i++) {
      world.step(16);
      detector.step(16, [car]);
    }

    expect(detector.getApproachState("app_N").queueLength).toBe(0);
  });
});
