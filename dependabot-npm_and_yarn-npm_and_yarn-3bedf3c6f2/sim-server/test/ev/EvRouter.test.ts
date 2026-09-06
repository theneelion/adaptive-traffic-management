import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { EvRouter } from "../../src/ev/EvRouter";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { buildVehiclePath } from "../../src/vehicles/TurnPaths";

describe("EvRouter", () => {
  it("spawns an EV at the origin approach, heading toward the given destination", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);

    const result = router.spawn("app_N", "app_S");
    expect(result).toHaveProperty("evId");
    expect(router.requiredPhaseId((result as any).evId)).toBe("NS_through");
  });

  it("supports routing to an adjacent (turning) destination, not just the opposite approach", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);

    const result = router.spawn("app_N", "app_E");
    expect(result).toHaveProperty("evId");
    // Still requires the N approach's phase (NS_through) to get there, regardless of exit direction.
    expect(router.requiredPhaseId((result as any).evId)).toBe("NS_through");
  });

  it("rejects a second spawn while one EV is already active", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);

    router.spawn("app_N", "app_S");
    expect(router.spawn("app_E", "app_W")).toEqual({ error: "already_active" });
  });

  it("rejects an invalid destination (same as origin, or unknown)", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);

    expect(router.spawn("app_N", "app_N")).toEqual({ error: "invalid_destination" });
  });

  it("reports a decreasing ETA to the intersection as it drives, then null once passed, and despawns at the far end", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);
    const { evId } = router.spawn("app_N", "app_S") as { evId: string };

    // 700 ticks (35s) gives margin over the ~32s the EV needs to clear its full path under the
    // kinematic acceleration model (VehicleBody.applyInput).
    const etaSamples: (number | null)[] = [];
    for (let i = 0; i < 700; i++) {
      world.step(50);
      router.step(50);
      etaSamples.push(router.etaToIntersection(evId, "int_1"));
    }

    const firstDefined = etaSamples.find((e) => e !== null) as number;
    const lastBeforePassing = [...etaSamples].reverse().find((e) => e !== null && e > 0);
    expect(lastBeforePassing).toBeLessThan(firstDefined);
    expect(router.hasPassedIntersection(evId)).toBe(true);
    expect(router.activeVehicle()).toBeNull(); // despawned after reaching the far end
  });

  it("refuses to spawn directly on top of an existing regular vehicle at the same origin", () => {
    // Found directly from a user report: pressing the EV-spawn key while ordinary traffic
    // happened to be sitting at that approach's spawn point produced an instant, unrecoverable
    // collision — the EV materialized inside a vehicle that was already there, since neither
    // spawn path checked the other's occupancy.
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);

    const path = buildVehiclePath(map, "app_N", "app_S");
    const spawnPoint = path.pointAt(0);
    const blockingVehicle = new VehicleBody(world, "blocker", { x: spawnPoint.x, y: spawnPoint.y, heading: Math.PI / 2 });

    expect(router.spawn("app_N", "app_S", [blockingVehicle])).toEqual({ error: "spawn_blocked" });
    expect(router.activeVehicle()).toBeNull();
  });

  it("still spawns normally when the blocking vehicle is well clear of the origin's spawn point", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);

    const farAwayVehicle = new VehicleBody(world, "far", { x: 10_000, y: 10_000, heading: 0 });

    const result = router.spawn("app_N", "app_S", [farAwayVehicle]);
    expect(result).toHaveProperty("evId");
  });
});
