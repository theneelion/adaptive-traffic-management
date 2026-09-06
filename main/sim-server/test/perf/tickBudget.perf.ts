import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { TrafficController } from "../../src/vehicles/TrafficController";
import { PedestrianController } from "../../src/pedestrians/PedestrianController";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";
import { mulberry32 } from "../../src/util/mulberry32";

const TICK_MS = 50;
const TICKS = 2000; // 100 simulated seconds
const BUDGET_MS = 40; // headroom under the 50ms real-time tick interval
const RUSH_HOUR_VEHICLE_RATE_PER_MIN = 60;
const RUSH_HOUR_PEDESTRIAN_RATE_PER_MIN = 40;

function main(): void {
  const map = loadMap("../../maps/grid_1x1_v1.json");
  const world = new PhysicsWorld(map);
  // vehicleLength must match VehicleBody's real Matter.js rectangle length (36 units), not
  // IdmController.test.ts's pure-formula fixture value (4) — using 4 here packs queued vehicles
  // far closer than their real physical bodies, so Matter's collision response shoves them apart,
  // which would both misrepresent real traffic behavior and skew this script's own performance
  // reading (extra collision-resolution work that wouldn't happen with correctly-spaced traffic).
  // Same real bug already found and documented in 03-multiplayer-collisions.md.
  const idmParams = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 36 };
  const traffic = new TrafficController(world, map, idmParams, mulberry32(1), RUSH_HOUR_VEHICLE_RATE_PER_MIN, () => {});
  const pedestrians = new PedestrianController(
    world,
    new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges),
    ["far_N", "far_S", "far_E", "far_W"],
    mulberry32(2),
    RUSH_HOUR_PEDESTRIAN_RATE_PER_MIN
  );
  // Fixed NS-green/EW-red split for the whole run — this script measures raw tick cost under load,
  // not signal behavior, so a real SignalPhaseMachine (Phase 2, Task 6) isn't needed here.
  const approachSignalStates = new Map([
    ["app_N", "green"], ["app_S", "green"], ["app_E", "red"], ["app_W", "red"]
  ] as const);

  let totalMs = 0;
  for (let i = 0; i < TICKS; i++) {
    const start = performance.now();
    world.step(TICK_MS);
    traffic.step(TICK_MS, approachSignalStates);
    pedestrians.step(TICK_MS, approachSignalStates);
    totalMs += performance.now() - start;
  }

  const avgMs = totalMs / TICKS;
  console.log(
    `Average tick wall-time: ${avgMs.toFixed(2)}ms (budget ${BUDGET_MS}ms) | ` +
      `vehicles: ${traffic.vehicles.length}, pedestrians: ${pedestrians.agents.length}`
  );

  if (avgMs > BUDGET_MS) {
    console.error(`FAIL: tick budget exceeded (${avgMs.toFixed(2)}ms > ${BUDGET_MS}ms)`);
    process.exit(1);
  }
}

main();
