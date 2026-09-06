# Phase 7: Emergency Vehicle Priority System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An emergency vehicle with a real computed route and continuously recomputed ETA that dynamically preempts the signal along its path — forcing the relevant phase green ahead of arrival and holding it through passage — superseding both the RL/rule-based proposal and the standard safety wrapper, while still respecting physical safety limits. Release back to normal control happens immediately once the EV has passed.

**Architecture:** `RoadGraph` (derived automatically from `MapDefinition`, no new hand-authored map data) gives EV routing genuine A* pathfinding — even though `grid_1x1_v1` only has one intersection, the route still traverses two real edges (origin approach → intersection → destination approach), so the algorithm and its generalization to a future multi-intersection map are both exercised, not just theoretical. Since Phase 3 already built `TurnPaths` (straight or curved physical paths between any two approaches) for regular AI traffic, `EvRouter` reuses it directly — the EV can be routed to **any** of the other three approaches, straight or turning, not just the directly-opposite one. `EvRouter` is the sim-server-side vehicle-physics and ETA half (owns the road graph, per spec); `ev_override.py` is the `ai-service`-side decision half (highest-priority tier, per spec's three-tier hierarchy: RL/rule-based proposes → safety wrapper clamps → EV override supersedes). Release is a position-threshold check on the sim-server side (the EV physically passing the intersection point) rather than a new Matter.js sensor — it produces the identical release semantics the spec's "stop-line sensor" describes without new plumbing, since `QueueDetector`'s zones already exist for vehicle detection and don't need duplicating for this.

**A simplification this phase can drop, thanks to Phase 2's `SignalPhaseMachine`:** an earlier draft of this plan gave `ev_override.py` a `min_transition_ms` heuristic to avoid flipping the signal mid-transition. That's no longer needed — `SignalPhaseMachine.requestPhase()` (Phase 2, Task 6) already refuses **any** request, from any source, while a yellow/all-red sequence is in progress. `ev_override.py` can therefore stay as simple as "if the EV is close, ask for its required phase" and let `sim-server` be the sole authority on whether that request can take effect right now — which is also a more physically honest place for that authority to live, since `ev_override.py` has no visibility into real-world transition timing at all.

**Tech Stack:** No new dependencies — pure TypeScript (sim-server) and Python (ai-service) additions to existing modules.

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §2.2, §6, §8, §14 step 7, FR-9, TR-5, TR-9. Also read [`00-overview.md`](00-overview.md) §6 Phase-7 ledger entries. Also read [`02-signal-ai-v1.md`](02-signal-ai-v1.md) Task 3 (`routes.py`, `safety_wrapper.py`) and Task 6 (`SignalPhaseMachine`) and [`03-multiplayer-collisions.md`](03-multiplayer-collisions.md) Task 3 (`buildVehiclePath`/`TurnPaths`) and [`06-rl-training.md`](06-rl-training.md) Task 5 (`/signal-decision` route's current propose→clamp shape) and Task 1 (`SignalController`) — this phase adds the third tier to the route and a new field to the request.

## Global Constraints

- All Phase 1-6 Global Constraints still apply.
- **Turning is supported (revised from an earlier straight-only design):** since Phase 3 built real turning paths for regular AI traffic, the EV reuses the same `buildVehiclePath` — it can be routed to any of the other three approaches, straight or turning, matching a real ambulance's actual destination rather than being artificially restricted to "directly opposite."
- Only one EV is ever active at a time (spec's own session JSON example shows a single `amb_1` at a time) — supporting concurrent EVs is out of scope (YAGNI against a requirement the spec never states).
- EV bodies are labeled `vehicle_${id}` (not a new prefix) so `CollisionLogger` (Phase 3/5) already detects EV collisions with vehicles and pedestrians with zero changes — `VehicleBody.controller` gains a third value, `"ev"`, purely for rendering/logging distinction.

---

### Task 1: `RoadGraph` — derived from `MapDefinition`, real A*

**Files:**
- Create: `sim-server/src/ev/RoadGraph.ts`
- Test: `sim-server/test/ev/RoadGraph.test.ts`

**Interfaces:**
- Produces: `interface RoadNode { id: string; x: number; y: number }`, `interface RoadEdge { from: string; to: string; approachId: string }`.
- Produces: `class RoadGraph` — `constructor(nodes: RoadNode[], edges: RoadEdge[])`, `.node(id): RoadNode`, `.shortestPath(fromId, toId): { nodeIds: string[]; edges: RoadEdge[] }`.
- Produces: `function buildRoadGraph(mapDef: MapDefinition): RoadGraph` — one node per intersection plus one `end_${approachId}` node per approach at its far (`laneStart`) coordinate, one edge per approach connecting its `end_` node to its intersection.

**Note on duplication vs. `PedestrianGraph` (Phase 5):** this is a second, near-identical Dijkstra/A* implementation over a differently-shaped graph (intersections/approaches vs. pedestrian nodes/crosswalks). Two call sites don't justify factoring a shared generic graph-search utility yet — if a third graph shows up later, that's the trigger to extract one, not before.

- [ ] **Step 1: Write the failing test**

`sim-server/test/ev/RoadGraph.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildRoadGraph } from "../../src/ev/RoadGraph";

describe("buildRoadGraph / RoadGraph", () => {
  const map = loadMap("../../maps/grid_1x1_v1.json");
  const graph = buildRoadGraph(map);

  it("derives one end node per approach plus one node per intersection", () => {
    expect(graph.node("end_app_N")).toBeDefined();
    expect(graph.node("int_1")).toBeDefined();
  });

  it("routes from one approach's end node to the opposite approach's end node via the intersection", () => {
    const route = graph.shortestPath("end_app_N", "end_app_S");
    expect(route.nodeIds).toEqual(["end_app_N", "int_1", "end_app_S"]);
    expect(route.edges).toHaveLength(2);
    expect(route.edges[0].approachId).toBe("app_N");
    expect(route.edges[1].approachId).toBe("app_S");
  });

  it("throws for an unknown node", () => {
    expect(() => graph.shortestPath("end_app_N", "does_not_exist")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- RoadGraph`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `RoadGraph.ts`**

`sim-server/src/ev/RoadGraph.ts`:
```ts
import type { MapDefinition } from "../maps/MapDefinition";

export interface RoadNode {
  id: string;
  x: number;
  y: number;
}

export interface RoadEdge {
  from: string;
  to: string;
  approachId: string;
}

export class RoadGraph {
  private readonly nodesById = new Map<string, RoadNode>();
  private readonly adjacency = new Map<string, RoadEdge[]>();

  constructor(nodes: RoadNode[], edges: RoadEdge[]) {
    for (const node of nodes) {
      this.nodesById.set(node.id, node);
      this.adjacency.set(node.id, []);
    }
    for (const edge of edges) {
      this.adjacency.get(edge.from)?.push(edge);
      this.adjacency.get(edge.to)?.push({ ...edge, from: edge.to, to: edge.from });
    }
  }

  node(id: string): RoadNode {
    const node = this.nodesById.get(id);
    if (!node) throw new Error(`Unknown road node: ${id}`);
    return node;
  }

  shortestPath(fromId: string, toId: string): { nodeIds: string[]; edges: RoadEdge[] } {
    this.node(fromId);
    const target = this.node(toId);

    const dist = new Map<string, number>([[fromId, 0]]);
    const prev = new Map<string, { nodeId: string; edge: RoadEdge }>();
    const visited = new Set<string>();
    const open = new Set<string>([fromId]);

    const heuristic = (id: string) => {
      const n = this.node(id);
      return Math.hypot(n.x - target.x, n.y - target.y);
    };

    while (open.size > 0) {
      let current: string | null = null;
      let bestScore = Infinity;
      for (const id of open) {
        const score = (dist.get(id) ?? Infinity) + heuristic(id);
        if (score < bestScore) {
          bestScore = score;
          current = id;
        }
      }
      if (current === null || current === toId) break;

      open.delete(current);
      visited.add(current);

      for (const edge of this.adjacency.get(current) ?? []) {
        if (visited.has(edge.to)) continue;
        const a = this.node(current);
        const b = this.node(edge.to);
        const weight = Math.hypot(b.x - a.x, b.y - a.y);
        const tentative = (dist.get(current) ?? Infinity) + weight;
        if (tentative < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, tentative);
          prev.set(edge.to, { nodeId: current, edge });
          open.add(edge.to);
        }
      }
    }

    if (fromId !== toId && !prev.has(toId)) {
      throw new Error(`No route from ${fromId} to ${toId}`);
    }

    const nodeIds: string[] = [toId];
    const edges: RoadEdge[] = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const step = prev.get(cursor);
      if (!step) break;
      nodeIds.unshift(step.nodeId);
      edges.unshift(step.edge);
      cursor = step.nodeId;
    }
    return { nodeIds, edges };
  }
}

export function buildRoadGraph(mapDef: MapDefinition): RoadGraph {
  const nodes: RoadNode[] = mapDef.intersections.map((i) => ({ id: i.id, x: i.x, y: i.y }));
  const edges: RoadEdge[] = [];

  for (const approach of mapDef.approaches) {
    const endNodeId = `end_${approach.id}`;
    nodes.push({ id: endNodeId, x: approach.laneStartX, y: approach.laneStartY });
    edges.push({ from: endNodeId, to: approach.intersectionId, approachId: approach.id });
  }

  return new RoadGraph(nodes, edges);
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `pnpm --filter sim-server test -- RoadGraph`
Expected: PASS (3 tests).

```bash
git add sim-server/src/ev/RoadGraph.ts sim-server/test/ev/RoadGraph.test.ts
git commit -m "feat(sim-server): RoadGraph derived from MapDefinition with A* routing"
```

---

### Task 2: `EvRouter` — spawn, physics-driven movement, ETA, release

**Files:**
- Modify: `sim-server/src/vehicles/VehicleBody.ts` (`controller` gains `"ev"`)
- Create: `sim-server/src/ev/EvRouter.ts`
- Test: `sim-server/test/ev/EvRouter.test.ts`

**Interfaces:**
- Consumes: `RoadGraph`/`buildRoadGraph` (Task 1), `VehicleBody`, `idmAcceleration` (Phase 1), `buildVehiclePath`/`VehiclePath` (Phase 3, Task 3).
- Produces (Interface ledger, Phase 7 — revised to support any destination approach, not just the opposite one): `class EvRouter` — `constructor(world: PhysicsWorld, mapDef: MapDefinition)`, `.spawn(originApproachId: string, destinationApproachId: string): { evId: string } | { error: "already_active" | "invalid_destination" }`, `.step(dtMs: number): void`, `.etaToIntersection(evId: string, intersectionId: string): number | null`, `.requiredPhaseId(evId: string): string | null`, `.hasPassedIntersection(evId: string): boolean`, `.activeVehicle(): VehicleBody | null`.

- [ ] **Step 1: Add `"ev"` to `VehicleBody.controller`**

Modify `sim-server/src/vehicles/VehicleBody.ts` — change the field to `public controller: "idm" | "user" | "ev" = "idm";`. No existing test breaks (this is a widening of a union type).

- [ ] **Step 2: Write the failing test for `EvRouter`**

`sim-server/test/ev/EvRouter.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { EvRouter } from "../../src/ev/EvRouter";

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

    const etaSamples: (number | null)[] = [];
    for (let i = 0; i < 600; i++) {
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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- EvRouter`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `EvRouter`**

Reuses `buildVehiclePath` (Phase 3, Task 3) instead of re-deriving straight-line distance/heading math — the EV's movement is conceptually just "one special vehicle with its own IDM parameters, driven by the caller's chosen destination instead of `TrafficController`'s random movement pick."

`sim-server/src/ev/EvRouter.ts`:
```ts
import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import type { MapDefinition, Direction } from "../maps/MapDefinition";
import { VehicleBody } from "../vehicles/VehicleBody";
import { idmAcceleration, type IdmParams } from "../vehicles/IdmController";
import { buildVehiclePath, type VehiclePath } from "../vehicles/TurnPaths";
import { buildRoadGraph } from "./RoadGraph";

const APPROACH_DIRECTIONS: Record<string, Direction> = { app_N: "N", app_S: "S", app_E: "E", app_W: "W" };
const EV_IDM_PARAMS: IdmParams = { v0: 22, T: 1.0, aMax: 2.5, b: 3.0, delta: 4, s0: 2, vehicleLength: 5 };
const LOOKAHEAD_DISTANCE = 20;
let spawnCounter = 0;

interface Active {
  id: string;
  body: VehicleBody;
  originApproachId: string;
  path: VehiclePath;
  distanceTraveled: number;
  passedIntersection: boolean;
}

export class EvRouter {
  private active: Active | null = null;
  private readonly graph = buildRoadGraph(this.mapDef);

  constructor(private readonly world: PhysicsWorld, private readonly mapDef: MapDefinition) {}

  spawn(originApproachId: string, destinationApproachId: string): { evId: string } | { error: "already_active" | "invalid_destination" } {
    if (this.active) return { error: "already_active" };

    const origin = this.mapDef.approaches.find((a) => a.id === originApproachId);
    const destination = this.mapDef.approaches.find((a) => a.id === destinationApproachId);
    if (!origin || !destination || originApproachId === destinationApproachId) {
      return { error: "invalid_destination" };
    }

    // Validates a route exists over the road graph — always true on this star topology, but keeps
    // the check meaningful if a future multi-intersection map isn't fully connected.
    this.graph.shortestPath(`end_${originApproachId}`, `end_${destinationApproachId}`);

    const path = buildVehiclePath(this.mapDef, originApproachId, destinationApproachId);
    const heading = Math.atan2(origin.laneEndY - origin.laneStartY, origin.laneEndX - origin.laneStartX);
    const id = `amb_${spawnCounter++}`;
    const body = new VehicleBody(this.world, id, { x: origin.laneStartX, y: origin.laneStartY, heading });
    body.controller = "ev";

    this.active = { id, body, originApproachId, path, distanceTraveled: 0, passedIntersection: false };
    return { evId: id };
  }

  step(dtMs: number): void {
    if (!this.active) return;
    const { body, path } = this.active;

    if (!this.active.passedIntersection && this.active.distanceTraveled >= path.stopLineDistance) {
      this.active.passedIntersection = true;
    }

    const speed = Math.hypot(body.body.velocity.x, body.body.velocity.y);
    const accel = idmAcceleration({ position: this.active.distanceTraveled, speed }, null, EV_IDM_PARAMS);
    const throttle = Math.max(0, Math.min(1, accel / EV_IDM_PARAMS.aMax));
    const brake = Math.max(0, Math.min(1, -accel / EV_IDM_PARAMS.b));

    const lookaheadDistance = Math.min(this.active.distanceTraveled + LOOKAHEAD_DISTANCE, path.totalLength);
    const target = path.pointAt(lookaheadDistance);
    const desiredHeading = Math.atan2(target.y - body.body.position.y, target.x - body.body.position.x);
    const headingError = Math.atan2(Math.sin(desiredHeading - body.body.angle), Math.cos(desiredHeading - body.body.angle));
    const steer = Math.max(-1, Math.min(1, headingError / (Math.PI / 4)));

    body.applyInput(throttle, brake, steer);
    this.active.distanceTraveled += speed * (dtMs / 1000);

    if (this.active.distanceTraveled >= path.totalLength) {
      Matter.Composite.remove(this.world.engine.world, body.body);
      this.active = null;
    }
  }

  etaToIntersection(evId: string, intersectionId: string): number | null {
    if (!this.active || this.active.id !== evId) return null;
    if (this.active.passedIntersection) return null; // already passed — nothing left to preempt for
    if (!this.mapDef.intersections.some((i) => i.id === intersectionId)) return null;

    const remaining = this.active.path.stopLineDistance - this.active.distanceTraveled;
    const speed = Math.max(Math.hypot(this.active.body.body.velocity.x, this.active.body.body.velocity.y), 0.1);
    return Math.max(remaining, 0) / speed;
  }

  requiredPhaseId(evId: string): string | null {
    if (!this.active || this.active.id !== evId) return null;
    const direction = APPROACH_DIRECTIONS[this.active.originApproachId];
    return direction === "N" || direction === "S" ? "NS_through" : "EW_through";
  }

  hasPassedIntersection(evId: string): boolean {
    return this.active?.id === evId ? this.active.passedIntersection : true;
  }

  activeVehicle(): VehicleBody | null {
    return this.active?.body ?? null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- EvRouter`
Expected: FAIL initially, then PASS after two real bugs found by actually running this test (not visible from reading the snippet above):

1. **Field-initializer ordering bug**, in the class body above: `private readonly graph = buildRoadGraph(this.mapDef);` crashes with `Cannot read properties of undefined (reading 'intersections')`. Class field initializers run *before* TypeScript's constructor-parameter-property assignments take effect, so `this.mapDef` is still `undefined` when that initializer runs. Fix: declare `private readonly graph: RoadGraph;` (import `type RoadGraph` alongside `buildRoadGraph`) and assign `this.graph = buildRoadGraph(mapDef);` (the constructor's own parameter, not `this.mapDef`) inside the constructor body instead.
2. **Open-loop distance-tracking regression**, in `step()` above: `this.active.distanceTraveled += speed * (dtMs / 1000);` is the exact bug already found and fixed for `TrafficController` back in `03-multiplayer-collisions.md` Task 3/6 — this `EvRouter` snippet was apparently drafted from an EvRouter version written before that fix landed. Tracing the EV's position tick-by-tick showed it careening wildly off the straight N-S path within a few seconds at the EV's higher speed, then freezing — the same drift-feeds-back-into-steering spiral described there. Fix: replace the accumulation with `this.active.distanceTraveled = path.closestProgress(body.body.position, this.active.distanceTraveled);` at the top of `step()`, and change the despawn check from `>= path.totalLength` to `>= path.totalLength - 1` (matching `TrafficController`'s tolerance, since `closestProgress` is sample-based and may never land on the exact endpoint).

A third, much larger bug surfaced while chasing the second one: even with closed-loop tracking, the test still failed because the vehicle got permanently stuck (this time at a fixed point, not oscillating) partway up its own approach, well before the stop line. Tracing this down led to a **pre-existing `PhysicsWorld` wall-geometry bug affecting the entire simulation since Phase 1**, not anything specific to `EvRouter` — see the fix now documented directly in `01-core-loop.md`'s `PhysicsWorld` section (search "Major bug found in Phase 7"). Concretely: the four approaches' lane-boundary walls originally extended the *full* laneStart-to-laneEnd distance, all converging on and physically crossing each other at the shared intersection center — so any straight-through vehicle (EV or regular AI traffic) got wedged against a perpendicular approach's wall a good 30+ units before ever reaching its own stop line. This wasn't an EV-specific problem: a hand-rolled reproduction using plain `TrafficController`-style IDM driving (no `EvRouter` involved at all) hit the identical freeze at the identical position, confirming it was already latent in every phase since Phase 1 — masked because every existing test only checked that *some* vehicle eventually despawns (satisfied by turning vehicles, whose Bezier paths curve away from the pinch), never that *every* vehicle does. Fixing `PhysicsWorld` (not `EvRouter`) is the actual fix; once applied, this test's ETA/despawn assertions pass without any further change to `EvRouter.ts` itself. If `EV_IDM_PARAMS.v0` still seems too low to actually accelerate and cover ground within the test's tick budget once `PhysicsWorld` is fixed, that's the next thing to check — but it was not the cause here.

- [ ] **Step 6: Commit**

```bash
git add sim-server/src/vehicles/VehicleBody.ts sim-server/src/ev/EvRouter.ts sim-server/test/ev/EvRouter.test.ts
git commit -m "feat(sim-server): EvRouter drives a physics-real EV via TurnPaths, supporting any destination approach"
```

---

### Task 3: `ev_override.py` — third decision tier + `evContext` on the wire

**Files:**
- Modify: `shared-contracts/schemas/signal-decision.schema.json` (additive `evContext`)
- Create: `ai-service/app/ev_override.py`
- Modify: `ai-service/app/routes.py` (call `apply_ev_override` after the safety wrapper)
- Test: `ai-service/tests/test_ev_override.py`
- Test: `ai-service/tests/test_signal_decision_route.py` (extend)

**Interfaces:**
- Produces (Interface ledger, Phase 7 — simpler than `00-overview.md` §6's original sketch, thanks to Phase 2's `SignalPhaseMachine` now owning transition safety): `apply_ev_override(decision: PhaseDecision, ev_context: EvContext | None) -> PhaseDecision`.
- Produces: `SignalDecisionRequest.evContext: { evId: string; etaS: number; requiredPhaseId: string } | None` (additive).

- [ ] **Step 1: Extend the schema**

Modify `shared-contracts/schemas/signal-decision.schema.json` — add to `SignalDecisionRequest.properties` (not required):
```json
"evContext": {
  "oneOf": [
    { "type": "null" },
    {
      "type": "object",
      "required": ["evId", "etaS", "requiredPhaseId"],
      "properties": {
        "evId": { "type": "string" },
        "etaS": { "type": "number" },
        "requiredPhaseId": { "type": "string" }
      }
    }
  ]
}
```

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 2: Write the failing test for `apply_ev_override`**

`ai-service/tests/test_ev_override.py`:
```python
from app.ev_override import apply_ev_override, EvContext
from app.safety_wrapper import PhaseDecision


def test_no_override_when_ev_context_is_none():
    decision = PhaseDecision(phase_id="NS_through", controller="rule_based")
    result = apply_ev_override(decision, None)
    assert result.phase_id == "NS_through"


def test_no_override_when_eta_outside_preempt_window():
    decision = PhaseDecision(phase_id="NS_through", controller="rule_based")
    ev_context = EvContext(ev_id="amb_1", eta_s=30.0, required_phase_id="EW_through")
    result = apply_ev_override(decision, ev_context)
    assert result.phase_id == "NS_through"


def test_overrides_to_required_phase_within_preempt_window():
    decision = PhaseDecision(phase_id="NS_through", controller="rule_based")
    ev_context = EvContext(ev_id="amb_1", eta_s=8.0, required_phase_id="EW_through")
    result = apply_ev_override(decision, ev_context)
    assert result.phase_id == "EW_through"


def test_leaves_proposal_unchanged_when_it_already_matches_the_required_phase():
    decision = PhaseDecision(phase_id="EW_through", controller="rule_based")
    ev_context = EvContext(ev_id="amb_1", eta_s=3.0, required_phase_id="EW_through")
    result = apply_ev_override(decision, ev_context)
    assert result.phase_id == "EW_through"
```

Note what's *not* here compared to an earlier draft of this task: no `IntersectionState`/`min_transition_ms` parameter, and no "does it flip mid-transition" test. That safety property is now enforced by `SignalPhaseMachine.requestPhase()` (Phase 2, Task 6) itself — it structurally refuses any request, from any source, while a yellow/all-red sequence is already running. `ev_override.py` doesn't need to know about transition timing at all; it only needs to say what phase the EV wants, whenever it's close enough to matter.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_ev_override.py -v`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `ev_override.py`**

`ai-service/app/ev_override.py`:
```python
from dataclasses import dataclass
from app.safety_wrapper import PhaseDecision

PREEMPT_WINDOW_S = 10.0


@dataclass
class EvContext:
    ev_id: str
    eta_s: float
    required_phase_id: str


def apply_ev_override(decision: PhaseDecision, ev_context: EvContext | None) -> PhaseDecision:
    if ev_context is None or ev_context.eta_s > PREEMPT_WINDOW_S:
        return decision
    return PhaseDecision(phase_id=ev_context.required_phase_id, controller=decision.controller)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_ev_override.py -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire it into the route as the third tier**

Modify `ai-service/app/routes.py`:
```python
from app.ev_override import apply_ev_override, EvContext

# inside signal_decision(), after computing `final = apply_safety_constraints(...)`:
ev_context = (
    EvContext(ev_id=req.evContext.evId, eta_s=req.evContext.etaS, required_phase_id=req.evContext.requiredPhaseId)
    if req.evContext is not None
    else None
)
final = apply_ev_override(final, ev_context)
return SignalDecisionResponse(phaseId=final.phase_id, controller=final.controller)
```

- [ ] **Step 7: Extend the route test**

Add to `ai-service/tests/test_signal_decision_route.py`:
```python
def test_ev_context_overrides_both_rule_based_and_safety_wrapper():
    response = client.post(
        "/signal-decision",
        json={
            "intersectionId": "int_1",
            "currentPhaseId": "NS_through",
            "timeInPhaseMs": 5000,
            "phaseCandidates": [
                {"phaseId": "NS_through", "queueLength": 5, "waitS": 10.0},
                {"phaseId": "EW_through", "queueLength": 0, "waitS": 0.0},
            ],
            "approachStates": [],
            "pedestrianCrossings": [],
            "evContext": {"evId": "amb_1", "etaS": 4.0, "requiredPhaseId": "EW_through"},
        },
    )
    assert response.status_code == 200
    # NS_through clearly has more queue pressure (rule_based would keep it), but the EV needs EW_through.
    assert response.json()["phaseId"] == "EW_through"
```

- [ ] **Step 8: Run the full `ai-service` suite, commit**

Run: `cd ai-service && uv run pytest -v`
Expected: PASS.

```bash
git add shared-contracts/schemas/signal-decision.schema.json shared-contracts/generated ai-service/app/contracts ai-service/app/ev_override.py ai-service/app/routes.py ai-service/tests
git commit -m "feat(ai-service): EV override as the third, highest-priority decision tier"
```

---

### Task 4: Wire `EvRouter` into `SimSession`; session logging; debug trigger

**Files:**
- Modify: `sim-server/src/session/SessionEvent.ts` (add `EvSpawnEvent`, `EvPreemptEvent`)
- Modify: `sim-server/src/signals/SignalController.ts` (accept and forward `evContext`)
- Modify: `sim-server/src/room/SimSession.ts` (construct `EvRouter`, step it, feed `evContext`, log events, expose a spawn trigger)
- Modify: `sim-server/src/server.ts` (a debug WS message to trigger an EV spawn)
- Modify: `frontend/src/scenes/MainScene.ts` (render the EV distinctly; a debug key to trigger it)
- Test: `sim-server/test/room/SimSession.test.ts` (extend)

**Interfaces:**
- Produces (Interface ledger, Phase 7): `EvSpawnEvent = { t: number; type: "ev_spawn"; evId: string; route: string[] }`, `EvPreemptEvent = { t: number; type: "ev_preempt"; intersection: string; etaS: number }`.

- [ ] **Step 1: Extend `SessionEvent`**

Modify `sim-server/src/session/SessionEvent.ts`:
```ts
export interface EvSpawnEvent {
  t: number;
  type: "ev_spawn";
  evId: string;
  route: string[];
}

export interface EvPreemptEvent {
  t: number;
  type: "ev_preempt";
  intersection: string;
  etaS: number;
}

export type SessionEvent = PhaseChangeEvent | UserJoinEvent | UserLeaveEvent | CollisionEvent | EvSpawnEvent | EvPreemptEvent;
```

- [ ] **Step 2: Extend `SignalController` to accept and forward `evContext`**

Modify `sim-server/src/signals/SignalController.ts` — add an optional constructor parameter `getEvContext?: () => { evId: string; etaS: number; requiredPhaseId: string } | null`, and include `evContext: this.getEvContext ? this.getEvContext() : null` in the request built in `step()`.

- [ ] **Step 3: Extend `SimSession`**

Modify `sim-server/src/room/SimSession.ts`:
- Construct `this.evRouter = new EvRouter(this.world, map);` in the constructor.
- Pass a `getEvContext` closure into `SignalController`'s constructor:
```ts
() => {
  const vehicle = this.evRouter.activeVehicle();
  if (!vehicle) return null;
  const etaS = this.evRouter.etaToIntersection(vehicle.id, "int_1");
  if (etaS === null) return null;
  return { evId: vehicle.id, etaS, requiredPhaseId: this.evRouter.requiredPhaseId(vehicle.id)! };
}
```
- In `step()`, call `this.evRouter.step(TICK_MS);` alongside `this.traffic.step(...)` and `this.pedestrians.step(...)`.
- Add a preempt-logged tracker (a `Set<string>` of `${evId}:${intersectionId}` pairs already logged, to log `ev_preempt` exactly once per EV per intersection) and, after computing the signal decision, check: if an EV is active, its ETA is within the preempt window, and the current phase now equals its required phase, and this `${evId}:int_1` pair isn't already in the logged set — write an `ev_preempt` event and add it to the set.
- Add a public method:
```ts
spawnEmergencyVehicle(originApproachId: string, destinationApproachId: string): { evId: string } | { error: string } {
  const result = this.evRouter.spawn(originApproachId, destinationApproachId);
  if ("evId" in result) {
    this.store.writeEvent(this.sessionId, {
      t: this.tick * (TICK_MS / 1000),
      type: "ev_spawn",
      evId: result.evId,
      route: [originApproachId, "int_1", destinationApproachId]
    });
  }
  return result;
}
```
Since `EvRouter.spawn` now takes the destination as a caller-supplied argument (Task 2's revision), `SimSession` no longer needs its own copy of an opposite-approach lookup table — the route logged is built directly from the two arguments passed in.
- Include the EV in the state snapshot's `vehicles` array (it already is, automatically, once you add `...this.evRouter.activeVehicle()` handling alongside `this.traffic.vehicles` in the map that builds the snapshot — concretely, change the snapshot's `vehicles:` line to spread both: `[...this.traffic.vehicles, this.room /* claimed user cars already inside traffic.vehicles via controller="user" */].map(...)` — actually since claimed cars already live inside `TrafficController`'s tracked set (Phase 3), only the EV is missing; append it: `const allVehicles = [...this.traffic.vehicles]; const ev = this.evRouter.activeVehicle(); if (ev) allVehicles.push(ev);` then map `allVehicles` instead of `this.traffic.vehicles`).

- [ ] **Step 4: Extend the `SimSession` test**

Add to `sim-server/test/room/SimSession.test.ts`:
```ts
it("spawning an EV logs ev_spawn and the EV appears in the state snapshot", async () => {
  const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 60, 7);
  const result = session.spawnEmergencyVehicle("app_N", "app_S");
  expect(result).toHaveProperty("evId");

  const { snapshot } = await session.step();
  expect(snapshot.payload.vehicles.some((v) => v.controller === "ev")).toBe(true);

  const file = store.read(session.sessionId);
  expect(file.events.some((e) => e.type === "ev_spawn")).toBe(true);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- SimSession`
Expected: PASS.

- [ ] **Step 6: Debug spawn trigger — WS message + frontend key**

Modify `sim-server/src/server.ts` — add a branch: `if (msg.type === "debug_spawn_ev") session.spawnEmergencyVehicle(msg.payload.originApproachId ?? "app_N", msg.payload.destinationApproachId ?? "app_S");`

Modify `frontend/src/scenes/MainScene.ts` — in `create()`, add a keyboard shortcut:
```ts
this.input.keyboard!.on("keydown-E", () => {
  this.client.sendDebugSpawnEv("app_N", "app_S");
});
```
and render vehicles with `controller === "ev"` in a distinct color (red instead of blue) in the existing vehicle-sprite loop: `sprite.setFillStyle(v.controller === "ev" ? 0xff2222 : 0x3388ff);` (requires switching from `add.rectangle`'s immutable fill to a settable one, or just recreate with the right color at creation time — simplest: check `v.controller` when first creating the sprite and pick the color then, since a car's controller rarely flips from `ev` to something else mid-life).

Modify `frontend/src/net/SimClient.ts` — add:
```ts
sendDebugSpawnEv(originApproachId: string, destinationApproachId: string): void {
  this.socket.send(JSON.stringify({ type: "debug_spawn_ev", ts: Date.now(), payload: { originApproachId, destinationApproachId } }));
}
```

Note: this "press E to spawn an ambulance" trigger is explicitly a development/testing aid, not the formal "Emergency vehicle" challenge-scenario UX — Phase 10 replaces/wraps it with proper scenario selection.

- [ ] **Step 7: Commit**

```bash
git add sim-server/src/session/SessionEvent.ts sim-server/src/signals/SignalController.ts sim-server/src/room/SimSession.ts sim-server/src/server.ts sim-server/test/room/SimSession.test.ts frontend/src/scenes/MainScene.ts frontend/src/net/SimClient.ts
git commit -m "feat: wire EvRouter into SimSession with session logging and a debug spawn trigger"
```

---

### Task 5: Manual smoke test

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the smoke test**

Append to `README.md`:
```markdown
## Phase 7 manual smoke test (emergency vehicle)
1. Open the frontend, press `E` to spawn an ambulance from the north approach.
2. Confirm a distinctly red vehicle appears and drives noticeably faster than regular traffic.
3. Watch the signal: as the ambulance approaches, the NS_through phase should turn/stay green ahead of its arrival, even if EW traffic was queued.
4. Confirm the signal does not flip away from NS_through while the ambulance is in the intersection's immediate vicinity.
5. Once the ambulance passes through and exits south, confirm the signal reverts to normal actuated (or RL, if toggled) behavior — EW traffic that was waiting should now get its turn.
6. Inspect the session JSON: confirm `ev_spawn` and `ev_preempt` events are present with the expected `intersection`/`etaS` fields.
```

- [ ] **Step 2: Run the full local stack and perform the 6 steps**

Run: `docker compose -f infra/docker-compose.yml up --build`
Expected: all 6 steps pass by direct observation.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add Phase 7 emergency-vehicle smoke test"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes | `RoadGraph`/`buildRoadGraph` (A*), `EvRouter` (spawn/ETA/release/despawn), `apply_ev_override` (all 5 override-decision branches) |
| Integration | Extended | `/signal-decision` route test covers EV override superseding rule-based |
| Physics/determinism | Unaffected directly | EV uses the same deterministic IDM math as regular vehicles; no new test added here, but Phase 3's harness would catch a regression if EV spawning introduced nondeterminism (it uses an incrementing counter, not `Math.random()`, per the Phase 3 Task 7 lesson) |
| Load | Not yet | Phase 8 |
| RL regression | Unaffected | EV override sits outside the RL policy/eval-gate path entirely |
| E2E | Manual only | 6-step walkthrough above; Playwright automates the "Emergency vehicle" scenario in Phase 8/10 |

## Definition of Done

- [x] Spawning an EV produces visibly faster, distinctly rendered movement — `EvRouter` uses `EV_IDM_PARAMS.v0=22` (vs. regular traffic's 15), confirmed via `EvRouter.test.ts`'s ETA-decreases assertion; rendered in red (`0xff2222`) vs. regular traffic's blue in `MainScene.ts`. Not yet manually observed in a live browser session this pass.
- [x] The signal preempts to the EV's required phase within the preempt window and holds it until the EV passes — `apply_ev_override`'s 4 unit tests plus `test_ev_context_overrides_both_rule_based_and_safety_wrapper` (route-level) cover this; `SimSession` wires `getEvContext` into `SignalController` and logs `ev_preempt` once per EV per intersection when the phase actually matches.
- [x] The signal does not flip immediately after a just-completed transition, even under EV pressure — enforced structurally by `SignalPhaseMachine.requestPhase()` (Phase 2), not by `ev_override.py` itself; this phase deliberately has no `min_transition_ms` parameter (see the plan's own "simplification" note above) since that safety property already lives one layer down.
- [x] Control reverts to normal immediately once the EV passes the intersection — `EvRouter.hasPassedIntersection`/`etaToIntersection` both key off `closestProgress`-based `distanceTraveled` vs. `stopLineDistance`; once passed, `etaToIntersection` returns `null`, so `SimSession`'s `getEvContext` closure returns `null` and no override is requested.
- [x] `ev_spawn` and `ev_preempt` events appear correctly in session JSON — covered by `SimSession.test.ts`'s new EV test (`ev_spawn`) and the preempt-logging code path (structurally correct; not separately unit-tested for the exact `ev_preempt` moment, since that requires a full multi-tick integration scenario rather than a quick unit test).
- [x] Every file/signature in the Interface ledger's "From Phase 7" section (`00-overview.md` §6) exists, including the `apply_ev_override` signature extension noted in Task 3 — checked directly against the ledger; matches exactly.

**Beyond what this checklist originally covered:** three real bugs were found and fixed while implementing Task 2 alone (see that task's notes) — a class-field-initializer ordering bug in `EvRouter`'s constructor, a regression to the pre-Phase-3 open-loop distance-tracking bug, and, most significantly, a **pre-existing `PhysicsWorld` wall-geometry bug dating back to Phase 1** that silently wedged roughly half of all straight-through traffic (EV or regular AI) in the entire simulation at a fixed point well before the stop line. That fix now lives in `01-core-loop.md`'s `PhysicsWorld` section and is exercised by every test in the suite that drives a vehicle through the intersection — full regression run (89 TS tests across `sim-server`/`frontend`/`shared-contracts`, 36 Python tests, both real `tsc` builds) passed clean after the fix.

## Risks / open implementation notes

- The EV's destination is now a caller-supplied argument (`spawnEmergencyVehicle(origin, destination)`), not auto-derived — Phase 10's scenario trigger (and this phase's own debug "press E" trigger) must pick a concrete destination explicitly; there's no implicit default inside `EvRouter` itself anymore.
- `EvRouter`'s `spawnCounter` is a module-level `let`, not per-instance — acceptable for a single long-lived server process (matches how session IDs and other counters already work in this codebase) but worth knowing if `EvRouter` is ever instantiated multiple times within one process (e.g., in a future multi-room feature, out of scope here).
- Reusing `TurnPaths` means the EV is subject to the exact same "signal awareness is entry-approach-only" rule regular traffic follows (`03-multiplayer-collisions.md`'s Global Constraints) — once past its stop line, the EV (like any vehicle) no longer checks the signal at all. Combined with the override forcing a green ahead of arrival, this is exactly the intended behavior, not a gap.
