import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { TrafficController } from "../../src/vehicles/TrafficController";
import { mulberry32 } from "../../src/util/mulberry32";
import { realSpeed } from "../../src/physics/realSpeed";

// vehicleLength must match (or exceed) VehicleBody's real Matter.js rectangle length (36 units) —
// using IdmController.test.ts's smaller example value here caused IDM to pack queued vehicles far
// closer together than their actual physical bodies, so Matter's collision response shoved
// overlapping cars apart, punching the front one through a red light. Real bug, found by running
// this test with actual physics rather than trusting the formula-level unit test's fixture value.
const IDM_PARAMS = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 40 };
const ALL_GREEN = new Map([
  ["app_N", "green"], ["app_S", "green"], ["app_E", "green"], ["app_W", "green"]
] as const);
const RED_FOR_N = new Map([
  ["app_N", "red"], ["app_S", "green"], ["app_E", "green"], ["app_W", "green"]
] as const);
const YELLOW_FOR_N = new Map([
  ["app_N", "yellow"], ["app_S", "red"], ["app_E", "red"], ["app_W", "red"]
] as const);

describe("TrafficController", () => {
  it("spawns vehicles over time and assigns each a real entry/exit movement, not just straight-through", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(1), 200, () => {});

    for (let i = 0; i < 200; i++) {
      world.step(50);
      controller.step(50, ALL_GREEN);
    }

    const movements = controller.vehicleMovements();
    expect(movements.length).toBeGreaterThan(0);
    const distinctExitsFromN = new Set(movements.filter((m) => m.entryApproachId === "app_N").map((m) => m.exitApproachId));
    expect(distinctExitsFromN.size).toBeGreaterThan(1);
  });

  it("holds a vehicle at the stop line when its approach's phase is red, with no real leader ahead", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(2), 120, () => {});

    // 1200 ticks (60s), not the original 400 (20s): at the real (post-velocity-unit-fix) v0=15,
    // a car queued behind a red light doesn't drop below the <1 speed threshold until roughly
    // t~27-30s (pure-IDM estimate), so 20s wasn't enough time for it to actually have stopped yet.
    for (let i = 0; i < 1200; i++) {
      world.step(50);
      controller.step(50, RED_FOR_N);
    }

    const nCar = controller.vehicles.find((v) => v.id.startsWith("car_app_N_"));
    expect(nCar).toBeDefined();
    expect(nCar!.body.position.y).toBeLessThan(-10);
    expect(realSpeed(nCar!.body)).toBeLessThan(1);
  });

  it("on yellow, a vehicle still far from the stop line brakes rather than committing to the intersection", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(4), 120, () => {});

    world.step(50);
    controller.step(50, YELLOW_FOR_N);
    // 1000 ticks (50s), not the original 300 (~15s) — same ~27-30s convergence floor as the
    // red-light test above, since the virtual stop-line leader is set from the very first yellow
    // tick (canStopSafely is true immediately at this distance).
    for (let i = 0; i < 1000; i++) {
      world.step(50);
      controller.step(50, YELLOW_FOR_N);
    }

    const nCar = controller.vehicles.find((v) => v.id.startsWith("car_app_N_"));
    expect(nCar).toBeDefined();
    expect(realSpeed(nCar!.body)).toBeLessThan(1);
  });

  it("despawns a vehicle once it reaches the far end of its assigned exit approach, not the intersection center", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(3), 120, () => {});

    for (let i = 0; i < 1500; i++) {
      world.step(50);
      controller.step(50, ALL_GREEN);
    }

    expect(controller.vehicles.length).toBeLessThan(40);
  });
});
