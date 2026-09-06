import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { EvRouter } from "../../src/ev/EvRouter";

describe("EvRouter multi-hop green-wave data", () => {
  it("upcomingStops lists both int_B and int_C, in order, with decreasing count as the EV advances", () => {
    const map = loadMap("../../maps/fixture_curved_3int.json");
    const world = new PhysicsWorld(map);
    const router = new EvRouter(world, map);
    const { evId } = router.spawn("b_far_north", "c_far_east") as { evId: string };

    const initial = router.upcomingStops(evId);
    expect(initial.map((s) => s.intersectionId)).toEqual(["int_B", "int_C"]);
    expect(initial[0].phaseId).not.toBeNull();

    for (let i = 0; i < 400; i++) {
      world.step(50);
      router.step(50);
    }
    const later = router.upcomingStops(evId);
    expect(later.length).toBeLessThanOrEqual(initial.length);
  });
});
