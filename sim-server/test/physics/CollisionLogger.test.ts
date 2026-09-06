import { describe, it, expect, vi } from "vitest";
import Matter from "matter-js";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { CollisionLogger } from "../../src/physics/CollisionLogger";

describe("CollisionLogger", () => {
  it("reports the two vehicle ids when their bodies collide", () => {
    const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
    const onCollision = vi.fn();
    new CollisionLogger(world, onCollision);

    const carA = new VehicleBody(world, "car_a", { x: -20, y: 0, heading: 0 });
    const carB = new VehicleBody(world, "car_b", { x: 20, y: 0, heading: Math.PI });

    // Vehicle motion is a per-tick kinematic velocity update (see VehicleBody.applyInput), not a
    // one-time impulse — it must be called every tick to keep driving, matching how the real
    // controllers (TrafficController, EvRouter) call it once per step(). 150 ticks (2.4s) gives
    // margin over the ~1.3s a constant 2.5 u/s^2 acceleration needs to close this 4-unit gap.
    for (let i = 0; i < 150; i++) {
      carA.applyInput(1, 0, 0, 16);
      carB.applyInput(1, 0, 0, 16);
      world.step(16);
    }

    expect(onCollision).toHaveBeenCalled();
    const [entities, kind] = onCollision.mock.calls[0];
    expect(new Set(entities)).toEqual(new Set(["car_a", "car_b"]));
    expect(kind).toBe("vehicle_vehicle");
  });

  it("does not fire for a vehicle passing over a non-solid queue-detection sensor", () => {
    const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
    const onCollision = vi.fn();
    new CollisionLogger(world, onCollision);

    const car = new VehicleBody(world, "car_1", { x: 0, y: -30, heading: Math.PI / 2 });
    for (let i = 0; i < 30; i++) {
      car.applyInput(1, 0, 0, 16);
      world.step(16);
    }

    expect(onCollision).not.toHaveBeenCalled();
  });

  it("reports vehicle_pedestrian for a vehicle-pedestrian overlap", () => {
    const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
    const onCollision = vi.fn();
    new CollisionLogger(world, onCollision);

    const car = new VehicleBody(world, "car_1", { x: -20, y: 0, heading: 0 });
    const ped = Matter.Bodies.circle(20, 0, 6, { label: "pedestrian_ped_1" });
    Matter.Composite.add(world.engine.world, ped);

    // 300 ticks (4.8s) gives margin over the ~3.6s needed to close this 16-unit gap.
    for (let i = 0; i < 300; i++) {
      car.applyInput(1, 0, 0, 16);
      world.step(16);
    }

    const call = onCollision.mock.calls.find((c) => c[1] === "vehicle_pedestrian");
    expect(call).toBeDefined();
    expect(new Set(call![0])).toEqual(new Set(["car_1", "ped_1"]));
  });
});
