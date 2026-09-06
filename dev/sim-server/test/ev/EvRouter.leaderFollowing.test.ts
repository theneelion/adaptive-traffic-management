import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { EvRouter } from "../../src/ev/EvRouter";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { realSpeed } from "../../src/physics/realSpeed";

describe("EvRouter leader-following", () => {
  it("brakes for a stationary obstacle directly ahead instead of colliding with it and getting wedged", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);
    const { evId } = router.spawn("app_N", "app_S") as { evId: string };

    // A stopped vehicle sitting directly in the EV's path, well before the intersection.
    const blocker = new VehicleBody(world, "blocker", { x: 0, y: -100, heading: Math.PI / 2 });

    let minGapSeen = Infinity;
    for (let i = 0; i < 400; i++) {
      world.step(50);
      router.step(50, [blocker]);
      const ev = router.activeVehicle();
      if (!ev) break;
      const gap = Math.hypot(ev.body.position.x - blocker.body.position.x, ev.body.position.y - blocker.body.position.y);
      minGapSeen = Math.min(minGapSeen, gap);
    }

    // A real following gap, not a near-zero collision distance — proves the EV actually slowed
    // down for the obstacle rather than driving straight through it.
    expect(minGapSeen).toBeGreaterThan(20);
    expect(router.requiredPhaseId(evId)).not.toBeNull(); // sanity: EV is still tracked, not despawned by an early crash
  });

  it("still reaches full speed and completes its route when the road ahead is clear", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);
    router.spawn("app_N", "app_S");

    let maxSpeedSeen = 0;
    for (let i = 0; i < 700; i++) {
      world.step(50);
      router.step(50, []);
      const ev = router.activeVehicle();
      if (ev) maxSpeedSeen = Math.max(maxSpeedSeen, realSpeed(ev.body));
      if (!ev) break;
    }

    expect(maxSpeedSeen).toBeGreaterThan(18); // reaches close to its v0=22 cruise speed
    expect(router.activeVehicle()).toBeNull(); // completed and despawned
  });
});
