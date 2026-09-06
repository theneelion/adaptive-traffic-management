import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { VehicleBody } from "../../src/vehicles/VehicleBody";

describe("VehicleBody", () => {
  it("moves forward under positive throttle over several physics steps", () => {
    const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
    const car = new VehicleBody(world, "car_1", { x: 0, y: -300, heading: Math.PI / 2 });
    const startY = car.body.position.y;

    for (let i = 0; i < 30; i++) {
      car.applyInput(1, 0, 0);
      world.step(16);
    }

    expect(car.body.position.y).toBeGreaterThan(startY);
  });
});
