import { describe, it, expect } from "vitest";
import { RoomManager } from "../../src/room/RoomManager";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";

function makeCars(n: number) {
  const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
  return Array.from({ length: n }, (_, i) => new VehicleBody(world, `car_${i}`, { x: 0, y: 0, heading: 0 }));
}

describe("RoomManager", () => {
  it("claims an available IDM-controlled car on join, flipping its controller to user", () => {
    const [car] = makeCars(1);
    const room = new RoomManager(() => (car.controller === "idm" ? car : null), 4, 3000);

    const result = room.join("client_1");
    expect(result).toEqual({ carId: "car_0" });
    expect(car.controller).toBe("user");
    expect(room.ownerOf("car_0")).toBe("client_1");
  });

  it("returns capacity_reached when no claimable car is available", () => {
    const room = new RoomManager(() => null, 4, 3000);
    expect(room.join("client_1")).toEqual({ error: "capacity_reached" });
  });

  it("does not immediately revert control on leave — waits out the grace period", () => {
    const [car] = makeCars(1);
    const room = new RoomManager(() => (car.controller === "idm" ? car : null), 4, 3000);
    room.join("client_1");

    room.leave("client_1");
    room.step(1000);
    expect(car.controller).toBe("user");

    room.step(2500); // total 3500ms > 3000ms grace
    expect(car.controller).toBe("idm");
    expect(room.ownerOf("car_0")).toBeNull();
  });
});
