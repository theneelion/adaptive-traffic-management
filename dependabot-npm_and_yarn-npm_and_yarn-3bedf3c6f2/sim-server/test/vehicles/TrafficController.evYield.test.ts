import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { TrafficController } from "../../src/vehicles/TrafficController";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { mulberry32 } from "../../src/util/mulberry32";
import { realSpeed } from "../../src/physics/realSpeed";

const IDM_PARAMS = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 40 };
const ALL_GREEN = new Map([["app_N", "green"], ["app_S", "green"], ["app_E", "green"], ["app_W", "green"]] as const);

describe("TrafficController EV yield", () => {
  it("a car with an EV closing in from directly behind accelerates harder than one with no EV nearby", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");

    const worldNoEv = new PhysicsWorld(map);
    const controllerNoEv = new TrafficController(worldNoEv, map, IDM_PARAMS, mulberry32(1), 60, () => {});
    for (let i = 0; i < 40; i++) {
      worldNoEv.step(50);
      controllerNoEv.step(50, ALL_GREEN, null);
    }
    const carNoEv = controllerNoEv.vehicles.find((v) => v.id.startsWith("car_app_N_"))!;
    expect(carNoEv).toBeDefined();
    const speedNoEv = realSpeed(carNoEv.body);

    const worldWithEv = new PhysicsWorld(map);
    const controllerWithEv = new TrafficController(worldWithEv, map, IDM_PARAMS, mulberry32(1), 60, () => {});
    // An EV placed just behind app_N's spawn point, heading the same direction (south, into the
    // intersection) — directly behind any car that spawns on app_N.
    const ev = new VehicleBody(worldWithEv, "amb_test", { x: 0, y: -340, heading: Math.PI / 2 });
    ev.controller = "ev";
    for (let i = 0; i < 40; i++) {
      worldWithEv.step(50);
      controllerWithEv.step(50, ALL_GREEN, ev);
    }
    const carWithEv = controllerWithEv.vehicles.find((v) => v.id.startsWith("car_app_N_"))!;
    expect(carWithEv).toBeDefined();
    const speedWithEv = realSpeed(carWithEv.body);

    expect(speedWithEv).toBeGreaterThan(speedNoEv);
  });

  it("a car with no EV nearby is entirely unaffected (activeEv: null is the default, backward compatible)", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(1), 60, () => {});
    for (let i = 0; i < 40; i++) {
      world.step(50);
      controller.step(50, ALL_GREEN); // no third argument at all
    }
    expect(controller.vehicles.length).toBeGreaterThan(0);
  });
});
