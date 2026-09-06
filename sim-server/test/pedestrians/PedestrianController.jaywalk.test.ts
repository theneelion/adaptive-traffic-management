import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";
import { PedestrianController } from "../../src/pedestrians/PedestrianController";
import { mulberry32 } from "../../src/util/mulberry32";

// A far_W<->far_E pedestrian's only two routes cross via corner_NW/corner_NE (cross_N) or
// corner_SW/corner_SE (cross_S) — never cross_W/cross_E. Both app_N and app_S must be blocked
// (green = unsafe) to force a wait/jaywalk regardless of which of the two equally-short routes
// A* happens to pick. An earlier version of this test used far_N/far_S with only app_N blocked —
// a real topology bug: a far_N<->far_S journey only ever needs cross_W or cross_E, so it never
// waited at cross_N at all, and the "eventually jaywalks" assertion silently never triggered.
const NEITHER_CROSSWALK_SAFE = new Map([
  ["app_N", "green"], ["app_S", "green"], ["app_E", "red"], ["app_W", "red"]
] as const);

describe("PedestrianController jaywalking", () => {
  it("reports a nonzero queue at one of the two blocked crossings at some point during the run", () => {
    // Checked across the whole run, not just at the final tick — "waiting" is a transient state
    // (an agent either hasn't reached the corner yet, is waiting, or has already jaywalked and
    // moved on), so a single end-of-run snapshot can legitimately catch a moment when the queue
    // happens to be empty even though queuing clearly happened earlier. An earlier version of
    // this test asserted only on the final snapshot and was flaky for exactly that reason.
    // Arrival rate lowered from an original 300/min/node: at that rate, the 60-agent population
    // cap is reached within ~10s and the crowd's own separation steering term reaches a permanent
    // gridlock equilibrium near the spawn points (empirically verified: agent positions freeze by
    // ~t=60s and never move again) — nobody ever reaches a corner to register as "waiting",
    // regardless of whether crossing/queue detection itself works. 30/min/node reliably reaches a
    // real queued-and-waiting state (~50s empirically) without over-saturating local density.
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
    const controller = new PedestrianController(world, graph, ["far_W", "far_E"], mulberry32(5), 30);

    let everQueued = false;
    for (let i = 0; i < 2000; i++) {
      world.step(50);
      controller.step(50, NEITHER_CROSSWALK_SAFE);
      const stateN = controller.getCrossingState("cross_N");
      const stateS = controller.getCrossingState("cross_S");
      if (stateN.queueLength + stateS.queueLength > 0) everQueued = true;
    }

    expect(everQueued).toBe(true);
  });

  it("eventually marks at least one long-waiting pedestrian as jaywalking, at high spawn rate and a permanently-unsafe crossing", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
    const controller = new PedestrianController(world, graph, ["far_W", "far_E"], mulberry32(6), 600);

    let anyJaywalking = false;
    for (let i = 0; i < 4000 && !anyJaywalking; i++) {
      world.step(50);
      controller.step(50, NEITHER_CROSSWALK_SAFE);
      anyJaywalking = controller.agents.some((a) => controller.isJaywalking(a.id));
    }

    expect(anyJaywalking).toBe(true);
  });
});
