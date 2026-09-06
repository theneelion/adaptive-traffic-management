import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { buildVehiclePath } from "../../src/vehicles/TurnPaths";
import { idmAcceleration } from "../../src/vehicles/IdmController";
import { realSpeed } from "../../src/physics/realSpeed";

describe("curved-network fixture: full drive spawn -> turn -> curved road -> despawn", () => {
  it("a vehicle spawning far north of int_B, turning onto the curved b_from_c connector, reaches near int_C without ever getting stuck or flung to an unrealistic speed", () => {
    // Stays within one intersection (int_B), matching buildVehiclePath's Stage 1 single-hop
    // contract (spec §7.1's multi-hop routing across several intersections is Stage 2) — this
    // still exercises the full "far spawn -> straight approach -> turn -> curved exit segment ->
    // ends near a far point" sequence the real spec cares about, just compressed into one
    // intersection's worth of geometry instead of two.
    const map = loadMap("../../maps/fixture_curved_3int.json");
    const world = new PhysicsWorld(map);
    const IDM_PARAMS = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 36 };
    const LOOKAHEAD_DISTANCE = 20;

    const entry = map.approaches.find((a) => a.id === "b_far_north")!;
    const path = buildVehiclePath(map, "b_far_north", "b_from_c");
    const heading = Math.atan2(entry.laneEndY - entry.laneStartY, entry.laneEndX - entry.laneStartX);
    // Spawn at the path's own real starting point, not the approach's raw laneStart — the path is
    // offset LANE_OFFSET to one side of the raw centerline (see TurnPaths.ts's offsetSegment), so
    // starting at the unoffset point put the vehicle immediately off its own path.
    const spawnPoint = path.pointAt(0);
    const body = new VehicleBody(world, "e2e", { x: spawnPoint.x, y: spawnPoint.y, heading });

    let distanceTraveled = 0;
    let maxSpeedSeen = 0;
    let reachedEnd = false;
    for (let i = 0; i < 3000; i++) {
      world.step(50);
      distanceTraveled = path.closestProgress(body.body.position, distanceTraveled);
      const speed = realSpeed(body.body);
      maxSpeedSeen = Math.max(maxSpeedSeen, speed);

      const accel = idmAcceleration({ position: distanceTraveled, speed }, null, IDM_PARAMS);
      const throttle = Math.max(0, Math.min(1, accel / IDM_PARAMS.aMax));
      const brake = Math.max(0, Math.min(1, -accel / IDM_PARAMS.b));

      const lookaheadDistance = Math.min(distanceTraveled + LOOKAHEAD_DISTANCE, path.totalLength);
      const target = path.pointAt(lookaheadDistance);
      const desiredHeading = Math.atan2(target.y - body.body.position.y, target.x - body.body.position.x);
      const headingError = Math.atan2(Math.sin(desiredHeading - body.body.angle), Math.cos(desiredHeading - body.body.angle));
      const steer = Math.max(-1, Math.min(1, headingError / (Math.PI / 4)));

      body.applyInput(throttle, brake, steer, 50);

      if (distanceTraveled >= path.totalLength - 5) {
        reachedEnd = true;
        break;
      }
    }

    expect(reachedEnd).toBe(true);
    // v0=15 is the IDM target cruise speed; a well-behaved vehicle (no wall-collision energy
    // injection, no turn-geometry snap) should never exceed it by more than a small margin.
    expect(maxSpeedSeen).toBeLessThan(20);
  });
});
