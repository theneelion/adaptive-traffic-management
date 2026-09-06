import Matter from "matter-js";
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { buildVehiclePath } from "../../src/vehicles/TurnPaths";

describe("curved wall-chain physics", () => {
  it("a vehicle driving along the curved b_from_c connector never registers a wall collision", () => {
    const map = loadMap("../../maps/fixture_curved_3int.json");
    const world = new PhysicsWorld(map);
    const entry = map.approaches.find((a) => a.id === "b_from_a")!;
    // Exiting via b_from_c routes the vehicle backward along that same curve (see Task 5's
    // exit-segment reversal) — end-to-end this covers the exact same physical curved road the
    // wall-chain in Task 6 builds for b_from_c, regardless of which direction traverses it.
    const path = buildVehiclePath(map, "b_from_a", "b_from_c");
    const heading = Math.atan2(entry.laneEndY - entry.laneStartY, entry.laneEndX - entry.laneStartX);
    // Spawn at the path's own real starting point, not the approach's raw laneStart — the path is
    // offset LANE_OFFSET to one side of the raw centerline (see TurnPaths.ts's offsetSegment), so
    // starting at the unoffset point put the vehicle immediately off its own path.
    const spawnPoint = path.pointAt(0);
    const body = new VehicleBody(world, "probe", { x: spawnPoint.x, y: spawnPoint.y, heading });

    let wallCollisions = 0;
    Matter.Events.on(world.engine, "collisionStart", (event) => {
      for (const pair of event.pairs) {
        const a = pair.bodyA, b = pair.bodyB;
        if (a.isSensor || b.isSensor) continue;
        const aIsVehicle = a.label.startsWith("vehicle_");
        const bIsVehicle = b.label.startsWith("vehicle_");
        if ((aIsVehicle && !bIsVehicle) || (!aIsVehicle && bIsVehicle)) wallCollisions++;
      }
    });

    // A curved exit is a real curve — driving with a fixed steer (e.g. always straight) diverges
    // from the corridor as it bends, which isn't a wall-placement bug, just an unrealistic driver.
    // Steer via the same lookahead-point/heading-error approach TrafficController actually drives
    // vehicles with (src/vehicles/TrafficController.ts), so this test exercises a vehicle that
    // follows the road the way the real simulation does.
    const LOOKAHEAD_DISTANCE = 20;
    let distanceTraveled = 0;
    for (let i = 0; i < 1200; i++) {
      distanceTraveled = path.closestProgress(body.body.position, distanceTraveled);
      const lookaheadDistance = Math.min(distanceTraveled + LOOKAHEAD_DISTANCE, path.totalLength);
      const targetPoint = path.pointAt(lookaheadDistance);
      const desiredHeading = Math.atan2(targetPoint.y - body.body.position.y, targetPoint.x - body.body.position.x);
      const headingError = Math.atan2(Math.sin(desiredHeading - body.body.angle), Math.cos(desiredHeading - body.body.angle));
      const steer = Math.max(-1, Math.min(1, headingError / (Math.PI / 4)));
      body.applyInput(1, 0, steer, 50);
      world.step(50);
      if (distanceTraveled >= path.totalLength - 5) break;
    }

    expect(wallCollisions).toBe(0);
  });

  it("grid_1x1_v1.json still produces exactly 2 wall bodies per approach (unchanged straight-wall behavior)", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const bodies = Matter.Composite.allBodies(world.engine.world);
    const nWalls = bodies.filter((b) => b.label.endsWith("_left_edge") || b.label.endsWith("_right_edge"));
    expect(nWalls).toHaveLength(map.approaches.length * 2);
  });
});
