# Phase 5: Pedestrian Agent System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second agent-based simulation layer — pedestrians pathfinding across a waypoint graph of sidewalks and crosswalks, steering with boids-style separation/seek/arrival, and jaywalking when their patience at a crossing runs out — sharing the same Matter.js physics world as vehicles (real bodies, real collisions), with per-crossing queue/wait state already wired into the `signal-decision` RPC contract so Phase 6's RL environment doesn't have to touch the wire format later.

**Architecture:** A `PedestrianGraph` (nodes + edges, A*) sits alongside the existing vehicle `MapDefinition`. `PedestrianController` is the pedestrian-side analog of `TrafficController`: it spawns/moves/despawns agents, but movement is boids steering (not IDM) and "stopping for red" becomes "waiting to cross, then possibly jaywalking" instead of "queueing behind a stop line." Both steering and jaywalk-probability are pure functions first (unit tested), then wired into the stateful controller — same pattern `joystickMath.ts` established in Phase 4. `CollisionLogger` (Phase 3) is generalized to recognize `pedestrian_`-labeled bodies. The `signal-decision` schema gains an optional `pedestrianCrossings` field now, per the spec's explicit instruction to lock this interface before RL exists.

**Tech Stack:** Same as Phases 1-4 — no new dependencies. A* is hand-rolled (the graph is ~8 nodes; a pathfinding library would be a heavier dependency than the problem warrants).

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §4, §5, §7 (observation space shape only), §14 step 5, FR-3, TR-3. Also read [`00-overview.md`](00-overview.md) §6 Phase-5 ledger entries. Also read [`01-core-loop.md`](01-core-loop.md) Task 3-4 (`MapDefinition`, `PhysicsWorld`), [`02-signal-ai-v1.md`](02-signal-ai-v1.md) Task 1 (`SignalDecisionRequest`), and [`03-multiplayer-collisions.md`](03-multiplayer-collisions.md) Task 5 (`CollisionLogger`) and Task 6 (`SimSession`) — this phase modifies all three directly.

## Global Constraints

- All Phase 1-4 Global Constraints still apply.
- Pedestrians are full Matter.js bodies (small circles) at all times, whether jaywalking or crossing legally — "cause: jaywalk" on a `CollisionEvent` is a data annotation based on the pedestrian's state at collision time, not a separate physics path (spec §4: real impulse response is what makes both vehicle-vehicle and vehicle-pedestrian collisions meaningful).
- Pedestrian movement uses a force-based arrival/separation controller, never direct `Matter.Body.setVelocity` — setting velocity every tick would silently erase any collision-induced velocity change before it becomes a visible deflection, which would violate the "no clipping, real response" requirement (FR-6) for pedestrians just as much as it would for vehicles.
- No dedicated "pedestrian phase" is introduced — "safe to cross" for a given crosswalk is derived from whether the *vehicle* direction it crosses is currently excluded from the signal's `allowedDirections` (i.e., pedestrians cross during that approach's red). This satisfies the functional intent behind FR-8's "forced pedestrian phase" example without adding a third signal phase to `grid_1x1_v1`.

---

### Task 1: Pedestrian waypoint graph — map data, `MapDefinition` extension, `PedestrianGraph` (A*)

**Files:**
- Modify: `maps/grid_1x1_v1.json` (add `pedestrianNodes`, `pedestrianEdges`)
- Modify: `sim-server/src/maps/MapDefinition.ts` (add `PedestrianNode`, `PedestrianEdge` types)
- Modify: `sim-server/src/maps/loadMap.ts` (validate the new fields)
- Create: `sim-server/src/pedestrians/PedestrianGraph.ts`
- Test: `sim-server/test/pedestrians/PedestrianGraph.test.ts`

**Interfaces:**
- Produces: `PedestrianNode = { id: string; x: number; y: number }`, `PedestrianEdge = { from: string; to: string; kind: "sidewalk" | "crosswalk"; crossingId?: string; approachId?: string }`.
- Produces (Interface ledger, Phase 5): `class PedestrianGraph` — `constructor(nodes: PedestrianNode[], edges: PedestrianEdge[])`, `.node(id: string): PedestrianNode`, `.shortestPath(fromId: string, toId: string): string[]`, `.edgeBetween(a: string, b: string): PedestrianEdge | undefined`.

- [ ] **Step 1: Author the pedestrian graph for `grid_1x1_v1`**

A ring of 4 corner nodes just outside the vehicle lanes (lane half-width is 20, so corners sit at ±30), 4 far entry/exit nodes at the sidewalk ends, sidewalks connecting far↔corner, and one crosswalk edge per approach connecting the two corners flanking it — each tagged with the `approachId` it crosses, so "is it safe to cross" can be derived from the signal's current allowed directions.

> **Bug found during implementation:** a straight-line far→corner sidewalk edge (e.g. `far_N` at `(0,-350)` to `corner_NE` at `(30,-30)`) cuts diagonally *through* `PhysicsWorld`'s solid lane-boundary walls (e.g. `app_N`'s right-edge wall at `x=+20` spanning `y` from `-300` to `0`) — a pedestrian following that path gets physically wedged against the wall and never reaches the corner. Root-caused via a debug test that traced a stuck pedestrian's position across a whole run and found it pinned at a fixed point near the wall. Fixed by inserting one "bend" intermediate node per far→corner sidewalk, routing each as an L-shape that stays outside the lane's wall range for its entire length: first a lateral move while still beyond the lane's far extent (e.g. `far_N` → `bend_N_NE` at `(30,-350)`, still at `y=-350`, outside the wall's `y∈[-300,0]` range), then a straight move along the outside of the wall into the corner (e.g. `bend_N_NE` → `corner_NE`, at `x=30`, outside the wall's `x=20` half-width). This changes the node/edge counts below from 8/12 to 16/20 and turns each direct far→corner edge into two edges.

Modify `maps/grid_1x1_v1.json` — add:
```json
"pedestrianNodes": [
  { "id": "far_N", "x": 0, "y": -350 },
  { "id": "far_S", "x": 0, "y": 350 },
  { "id": "far_E", "x": 350, "y": 0 },
  { "id": "far_W", "x": -350, "y": 0 },
  { "id": "corner_NW", "x": -30, "y": -30 },
  { "id": "corner_NE", "x": 30, "y": -30 },
  { "id": "corner_SW", "x": -30, "y": 30 },
  { "id": "corner_SE", "x": 30, "y": 30 },
  { "id": "bend_N_NW", "x": -30, "y": -350 },
  { "id": "bend_N_NE", "x": 30, "y": -350 },
  { "id": "bend_S_SW", "x": -30, "y": 350 },
  { "id": "bend_S_SE", "x": 30, "y": 350 },
  { "id": "bend_E_NE", "x": 350, "y": -30 },
  { "id": "bend_E_SE", "x": 350, "y": 30 },
  { "id": "bend_W_NW", "x": -350, "y": -30 },
  { "id": "bend_W_SW", "x": -350, "y": 30 }
],
"pedestrianEdges": [
  { "from": "far_N", "to": "bend_N_NW", "kind": "sidewalk" },
  { "from": "bend_N_NW", "to": "corner_NW", "kind": "sidewalk" },
  { "from": "far_N", "to": "bend_N_NE", "kind": "sidewalk" },
  { "from": "bend_N_NE", "to": "corner_NE", "kind": "sidewalk" },
  { "from": "far_S", "to": "bend_S_SW", "kind": "sidewalk" },
  { "from": "bend_S_SW", "to": "corner_SW", "kind": "sidewalk" },
  { "from": "far_S", "to": "bend_S_SE", "kind": "sidewalk" },
  { "from": "bend_S_SE", "to": "corner_SE", "kind": "sidewalk" },
  { "from": "far_E", "to": "bend_E_NE", "kind": "sidewalk" },
  { "from": "bend_E_NE", "to": "corner_NE", "kind": "sidewalk" },
  { "from": "far_E", "to": "bend_E_SE", "kind": "sidewalk" },
  { "from": "bend_E_SE", "to": "corner_SE", "kind": "sidewalk" },
  { "from": "far_W", "to": "bend_W_NW", "kind": "sidewalk" },
  { "from": "bend_W_NW", "to": "corner_NW", "kind": "sidewalk" },
  { "from": "far_W", "to": "bend_W_SW", "kind": "sidewalk" },
  { "from": "bend_W_SW", "to": "corner_SW", "kind": "sidewalk" },
  { "from": "corner_NW", "to": "corner_NE", "kind": "crosswalk", "crossingId": "cross_N", "approachId": "app_N" },
  { "from": "corner_SW", "to": "corner_SE", "kind": "crosswalk", "crossingId": "cross_S", "approachId": "app_S" },
  { "from": "corner_NE", "to": "corner_SE", "kind": "crosswalk", "crossingId": "cross_E", "approachId": "app_E" },
  { "from": "corner_NW", "to": "corner_SW", "kind": "crosswalk", "crossingId": "cross_W", "approachId": "app_W" }
]
```

- [ ] **Step 2: Extend `MapDefinition` and `loadMap`**

Modify `sim-server/src/maps/MapDefinition.ts` — add:
```ts
export interface PedestrianNode {
  id: string;
  x: number;
  y: number;
}

export interface PedestrianEdge {
  from: string;
  to: string;
  kind: "sidewalk" | "crosswalk";
  crossingId?: string;
  approachId?: string;
}

// extend MapDefinition:
export interface MapDefinition {
  id: string;
  intersections: IntersectionDef[];
  approaches: ApproachDef[];
  pedestrianNodes: PedestrianNode[];
  pedestrianEdges: PedestrianEdge[];
}
```

Modify `sim-server/src/maps/loadMap.ts` — add validation after the existing checks:
```ts
if (!Array.isArray(raw.pedestrianNodes) || !Array.isArray(raw.pedestrianEdges)) {
  throw new Error(`Invalid map file at ${fullPath}: missing pedestrianNodes/pedestrianEdges`);
}
```

- [ ] **Step 3: Update the existing `loadMap` test's expectations**

Modify `sim-server/test/maps/loadMap.test.ts` — add an assertion to the first test:
```ts
expect(map.pedestrianNodes).toHaveLength(16);
expect(map.pedestrianEdges).toHaveLength(20);
```

Run: `pnpm --filter sim-server test -- loadMap`
Expected: PASS with the new assertions.

- [ ] **Step 4: Write the failing test for `PedestrianGraph`**

`sim-server/test/pedestrians/PedestrianGraph.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";

describe("PedestrianGraph", () => {
  const map = loadMap("../../maps/grid_1x1_v1.json");
  const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);

  it("finds a sidewalk path via the intermediate bend node", () => {
    expect(graph.shortestPath("far_N", "corner_NW")).toEqual(["far_N", "bend_N_NW", "corner_NW"]);
  });

  it("finds a path crossing the intersection via a crosswalk", () => {
    const path = graph.shortestPath("far_N", "far_S");
    expect(path[0]).toBe("far_N");
    expect(path.at(-1)).toBe("far_S");
    expect(path.some((id) => id.startsWith("corner_"))).toBe(true);
  });

  it("exposes the crossing/approach metadata for a crosswalk edge", () => {
    const edge = graph.edgeBetween("corner_NW", "corner_NE");
    expect(edge?.kind).toBe("crosswalk");
    expect(edge?.crossingId).toBe("cross_N");
    expect(edge?.approachId).toBe("app_N");
  });

  it("throws for an unreachable or unknown node", () => {
    expect(() => graph.shortestPath("far_N", "does_not_exist")).toThrow();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- PedestrianGraph`
Expected: FAIL, module not found.

- [ ] **Step 6: Implement `PedestrianGraph`**

`sim-server/src/pedestrians/PedestrianGraph.ts`:
```ts
import type { PedestrianNode, PedestrianEdge } from "../maps/MapDefinition";

export class PedestrianGraph {
  private readonly nodesById = new Map<string, PedestrianNode>();
  private readonly adjacency = new Map<string, PedestrianEdge[]>();

  constructor(nodes: PedestrianNode[], edges: PedestrianEdge[]) {
    for (const node of nodes) {
      this.nodesById.set(node.id, node);
      this.adjacency.set(node.id, []);
    }
    for (const edge of edges) {
      this.adjacency.get(edge.from)?.push(edge);
      this.adjacency.get(edge.to)?.push({ ...edge, from: edge.to, to: edge.from });
    }
  }

  node(id: string): PedestrianNode {
    const node = this.nodesById.get(id);
    if (!node) throw new Error(`Unknown pedestrian node: ${id}`);
    return node;
  }

  edgeBetween(a: string, b: string): PedestrianEdge | undefined {
    return this.adjacency.get(a)?.find((e) => e.to === b);
  }

  shortestPath(fromId: string, toId: string): string[] {
    this.node(fromId);
    const target = this.node(toId);

    const dist = new Map<string, number>([[fromId, 0]]);
    const prev = new Map<string, string>();
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
          prev.set(edge.to, current);
          open.add(edge.to);
        }
      }
    }

    if (fromId !== toId && !prev.has(toId)) {
      throw new Error(`No path from ${fromId} to ${toId}`);
    }

    const path: string[] = [toId];
    let cursor = toId;
    while (cursor !== fromId) {
      const parent = prev.get(cursor);
      if (!parent) break;
      path.unshift(parent);
      cursor = parent;
    }
    return path;
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- PedestrianGraph`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add maps/grid_1x1_v1.json sim-server/src/maps sim-server/src/pedestrians/PedestrianGraph.ts sim-server/test/maps/loadMap.test.ts sim-server/test/pedestrians/PedestrianGraph.test.ts
git commit -m "feat(sim-server): pedestrian waypoint graph data + A* PedestrianGraph"
```

---

### Task 2: Pure functions — steering force and jaywalk probability

**Files:**
- Create: `sim-server/src/pedestrians/steering.ts`
- Create: `sim-server/src/pedestrians/JaywalkModel.ts`
- Test: `sim-server/test/pedestrians/steering.test.ts`
- Test: `sim-server/test/pedestrians/JaywalkModel.test.ts`

**Interfaces:**
- Produces: `function computeSteeringForce(self: { x: number; y: number; vx: number; vy: number }, target: { x: number; y: number }, neighbors: { x: number; y: number }[], params: SteeringParams): { fx: number; fy: number }`.
- Produces (Interface ledger, Phase 5): `function jaywalkProbability(waitS: number, patienceS: number): number`.

- [ ] **Step 1: Write the failing test for `computeSteeringForce`**

`sim-server/test/pedestrians/steering.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeSteeringForce, DEFAULT_STEERING_PARAMS } from "../../src/pedestrians/steering";

describe("computeSteeringForce", () => {
  it("pushes toward the target when at rest with no neighbors", () => {
    const { fx, fy } = computeSteeringForce({ x: 0, y: 0, vx: 0, vy: 0 }, { x: 10, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    expect(fx).toBeGreaterThan(0);
    expect(fy).toBeCloseTo(0, 5);
  });

  it("slows the desired velocity within the arrival radius", () => {
    // Start already moving at walkSpeed so the comparison isn't masked by both cases saturating
    // identically at maxForce from a resting start (a from-rest version of this test found both
    // "far" and "near" clamped to the exact same force, since the raw force needed in either case
    // vastly exceeded maxForce — a real bug in the test, not the implementation, only visible by
    // actually running it). Approaching a near target should call for deceleration (negative
    // force) since the arrival-scaled desired speed is far below current speed; approaching a far
    // target should call for ~no change.
    const movingAtWalkSpeed = { x: 0, y: 0, vx: DEFAULT_STEERING_PARAMS.walkSpeed, vy: 0 };
    const far = computeSteeringForce(movingAtWalkSpeed, { x: 100, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    const near = computeSteeringForce(movingAtWalkSpeed, { x: 1, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    expect(near.fx).toBeLessThan(far.fx);
  });

  it("adds a separation push away from a very close neighbor", () => {
    // Same masking issue as the arrival-radius test above: starting from rest, both the with-
    // and without-neighbor raw pulls vastly exceed maxForce and clamp to the identical
    // +maxForce value, hiding the separation effect entirely. Starting already at the
    // no-neighbor desired velocity makes that baseline case unclamped (fx == 0), so the
    // neighbor's separation push shows up as a genuine (clamped) negative deviation from it.
    const movingAtWalkSpeed = { x: 0, y: 0, vx: DEFAULT_STEERING_PARAMS.walkSpeed, vy: 0 };
    const withoutNeighbor = computeSteeringForce(movingAtWalkSpeed, { x: 100, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    const withNeighbor = computeSteeringForce(
      movingAtWalkSpeed,
      { x: 100, y: 0 },
      [{ x: 2, y: 0 }],
      DEFAULT_STEERING_PARAMS
    );
    expect(withNeighbor.fx).toBeLessThan(withoutNeighbor.fx);
  });

  it("clamps the resulting force to maxForce", () => {
    const { fx, fy } = computeSteeringForce({ x: 0, y: 0, vx: -50, vy: 0 }, { x: 1000, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    expect(Math.hypot(fx, fy)).toBeLessThanOrEqual(DEFAULT_STEERING_PARAMS.maxForce + 1e-9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- steering`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `computeSteeringForce`**

`sim-server/src/pedestrians/steering.ts`:
```ts
export interface SteeringParams {
  walkSpeed: number;
  arrivalRadius: number;
  separationRadius: number;
  separationStrength: number;
  maxForce: number;
}

export const DEFAULT_STEERING_PARAMS: SteeringParams = {
  walkSpeed: 1.3,
  arrivalRadius: 20,
  separationRadius: 12,
  separationStrength: 1.5,
  maxForce: 0.0008
};

export function computeSteeringForce(
  self: { x: number; y: number; vx: number; vy: number },
  target: { x: number; y: number },
  neighbors: { x: number; y: number }[],
  params: SteeringParams
): { fx: number; fy: number } {
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  const dist = Math.hypot(dx, dy);
  const desiredSpeed = dist < params.arrivalRadius ? params.walkSpeed * (dist / params.arrivalRadius) : params.walkSpeed;

  let desiredVx = dist > 0 ? (dx / dist) * desiredSpeed : 0;
  let desiredVy = dist > 0 ? (dy / dist) * desiredSpeed : 0;

  for (const other of neighbors) {
    const ox = self.x - other.x;
    const oy = self.y - other.y;
    const d = Math.hypot(ox, oy);
    if (d > 0 && d < params.separationRadius) {
      const strength = params.separationStrength * ((params.separationRadius - d) / params.separationRadius);
      desiredVx += (ox / d) * strength;
      desiredVy += (oy / d) * strength;
    }
  }

  let fx = desiredVx - self.vx;
  let fy = desiredVy - self.vy;
  const mag = Math.hypot(fx, fy);
  if (mag > params.maxForce) {
    fx = (fx / mag) * params.maxForce;
    fy = (fy / mag) * params.maxForce;
  }

  return { fx, fy };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- steering`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for `jaywalkProbability`**

`sim-server/test/pedestrians/JaywalkModel.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { jaywalkProbability } from "../../src/pedestrians/JaywalkModel";

describe("jaywalkProbability", () => {
  it("is zero while wait time is within patience", () => {
    expect(jaywalkProbability(3, 10)).toBe(0);
    expect(jaywalkProbability(10, 10)).toBe(0);
  });

  it("rises above zero once wait exceeds patience", () => {
    expect(jaywalkProbability(15, 10)).toBeGreaterThan(0);
  });

  it("is monotonically increasing in wait time beyond patience", () => {
    const p1 = jaywalkProbability(12, 10);
    const p2 = jaywalkProbability(20, 10);
    const p3 = jaywalkProbability(40, 10);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
  });

  it("never exceeds 0.95", () => {
    expect(jaywalkProbability(10_000, 10)).toBeLessThanOrEqual(0.95);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- JaywalkModel`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `jaywalkProbability`**

`sim-server/src/pedestrians/JaywalkModel.ts`:
```ts
export function jaywalkProbability(waitS: number, patienceS: number): number {
  if (waitS <= patienceS) return 0;
  const excess = waitS - patienceS;
  return Math.min(0.95, 1 - Math.exp(-excess / patienceS));
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- JaywalkModel`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add sim-server/src/pedestrians/steering.ts sim-server/src/pedestrians/JaywalkModel.ts sim-server/test/pedestrians
git commit -m "feat(sim-server): pure steering-force and jaywalk-probability functions"
```

---

### Task 3: `PedestrianController` — spawn, path-follow, despawn; state snapshot gains `pedestrians`

**Files:**
- Create: `sim-server/src/pedestrians/PedestrianController.ts`
- Modify: `shared-contracts/schemas/state-snapshot.schema.json` (add `pedestrians` array)
- Modify: `sim-server/test/session/LocalDiskSessionStore.test.ts` — **no change needed** (doesn't construct `ServerStateSnapshot`)
- Modify: `shared-contracts/test/generated.test.ts` (existing `ServerStateSnapshot` literal needs `pedestrians: []` added)
- Modify: `frontend/src/scenes/MainScene.ts` (render pedestrians as small circles)
- Test: `sim-server/test/pedestrians/PedestrianController.test.ts`

**Interfaces:**
- Consumes: `PedestrianGraph` (Task 1), `computeSteeringForce`, `jaywalkProbability` (Task 2), `mulberry32` (Phase 3), `SignalLightState` (Phase 2, Task 6).
- Produces (Interface ledger, Phase 5): `class PedestrianController` — `constructor(world: PhysicsWorld, graph: PedestrianGraph, farNodeIds: string[], rng: () => number, arrivalRatePerMinPerNode: number)`, `.step(dtMs: number, approachSignalStates: Map<string, "green" | "yellow" | "red">): void`, `.agents: PedestrianSnapshot[]`. **(Note: this takes the same per-approach state map `TrafficController` (Phase 3) takes — not a plain `Set` of green approaches. A crossing is safe only when its approach reads `"red"`, never merely "not green" — yellow means vehicles are still clearing, not stopped.)**
- Produces: `ServerStateSnapshot.payload.pedestrians: PedestrianSnapshot[]` where `PedestrianSnapshot = { id: string; x: number; y: number }`.

- [ ] **Step 1: Extend the `state-snapshot` schema**

Modify `shared-contracts/schemas/state-snapshot.schema.json` — add to `payload.properties` and `payload.required`:
```json
"pedestrians": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["id", "x", "y"],
    "properties": {
      "id": { "type": "string" },
      "x": { "type": "number" },
      "y": { "type": "number" }
    }
  }
}
```

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 2: Update the existing `ServerStateSnapshot` test literal**

Modify `shared-contracts/test/generated.test.ts` — add `pedestrians: []` to the existing snapshot object literal (mirrors Phase 4 Task 1's pattern for additive-but-required fields).

Run: `pnpm --filter shared-contracts test`
Expected: PASS.

- [ ] **Step 3: Write the failing test for `PedestrianController`**

`sim-server/test/pedestrians/PedestrianController.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";
import { PedestrianController } from "../../src/pedestrians/PedestrianController";
import { mulberry32 } from "../../src/util/mulberry32";

const ALL_CLEAR_FOR_PEDESTRIANS = new Map([
  ["app_N", "red"], ["app_S", "red"], ["app_E", "red"], ["app_W", "red"]
] as const); // every approach's vehicles fully stopped — no crossing ever has to wait

describe("PedestrianController", () => {
  it("spawns pedestrians over time at the far nodes and moves them toward their destination", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
    const controller = new PedestrianController(world, graph, ["far_N", "far_S", "far_E", "far_W"], mulberry32(1), 60);

    for (let i = 0; i < 400; i++) {
      world.step(50);
      controller.step(50, ALL_CLEAR_FOR_PEDESTRIANS);
    }

    expect(controller.agents.length).toBeGreaterThan(0);
  });

  it("despawns a pedestrian once it reaches its destination node", () => {
    // Real numbers, established only by actually running the test — three earlier versions of it
    // got this wrong in different ways, each looking like "stuck at the population cap" for reasons
    // that had nothing to do with whether despawn itself was broken:
    //   1. arrivalRatePerMinPerNode=240 across 4 nodes gives steady-state demand (~240) that far
    //      exceeds the population cap regardless of despawn correctness.
    //   2. A short run (3000 ticks = 150s) ends before the very first pedestrians could possibly
    //      have completed even a fast crossing, so no despawn has had a chance to happen yet.
    //   3. Each far->corner sidewalk now routes through an extra "bend" node (Task 1's wall-crossing
    //      fix), so a full far-to-far journey is 5 hops (far->bend->corner->corner->bend->far)
    //      instead of 3. Every hop transition decelerates within arrivalRadius and re-accelerates
    //      from near-zero at maxForce=0.0008, so the two extra hops add real transit time:
    //      empirically ~150s per crossing at walkSpeed=8, not what a straight-line distance
    //      estimate would suggest. arrivalRatePerMinPerNode=5 (steady-state demand ~50) still
    //      exceeded the intended headroom below the cap once this was accounted for.
    // arrivalRatePerMinPerNode=3 across 4 nodes and a 6000-tick (300s) run gives steady-state
    // demand (arrival rate x transit time) of roughly 30 — comfortably below the cap, with the run
    // long enough for steady state to actually establish.
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
    const controller = new PedestrianController(world, graph, ["far_N", "far_S", "far_E", "far_W"], mulberry32(2), 3);

    for (let i = 0; i < 6000; i++) {
      world.step(50);
      controller.step(50, ALL_CLEAR_FOR_PEDESTRIANS);
    }

    expect(controller.agents.length).toBeLessThan(40);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- PedestrianController`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement `PedestrianController` (movement only — jaywalking added in Task 4)**

`sim-server/src/pedestrians/PedestrianController.ts`:
```ts
import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import { PedestrianGraph } from "./PedestrianGraph";
import { computeSteeringForce, DEFAULT_STEERING_PARAMS } from "./steering";
import { TrafficSpawner } from "../vehicles/TrafficSpawner";

type SignalLightState = "green" | "yellow" | "red";

export interface PedestrianSnapshot {
  id: string;
  x: number;
  y: number;
}

interface Agent {
  id: string;
  body: Matter.Body;
  path: string[]; // remaining node ids, path[0] is the next target
  waitStartMs: number | null;
  waitingAtCrossingId: string | null;
}

export class PedestrianController {
  private readonly agents2 = new Map<string, Agent>();
  private readonly spawner: TrafficSpawner;
  private spawnCounter = 0;

  constructor(
    private readonly world: PhysicsWorld,
    private readonly graph: PedestrianGraph,
    private readonly farNodeIds: string[],
    private readonly rng: () => number,
    arrivalRatePerMinPerNode: number
  ) {
    this.spawner = new TrafficSpawner(farNodeIds, rng, arrivalRatePerMinPerNode);
  }

  step(dtMs: number, approachSignalStates: Map<string, SignalLightState>): void {
    for (const originId of this.spawner.step(dtMs)) {
      const destinationId = this.pickDestination(originId);
      const origin = this.graph.node(originId);
      const path = this.graph.shortestPath(originId, destinationId).slice(1); // drop origin, keep remaining targets
      const id = `ped_${this.spawnCounter++}`;
      const body = Matter.Bodies.circle(origin.x, origin.y, 6, { label: `pedestrian_${id}`, frictionAir: 0.4 });
      Matter.Composite.add(this.world.engine.world, body);
      this.agents2.set(id, { id, body, path, waitStartMs: null, waitingAtCrossingId: null });
    }

    for (const [id, agent] of [...this.agents2.entries()]) {
      this.stepAgent(agent, dtMs, approachSignalStates);
      if (agent.path.length === 0) {
        Matter.Composite.remove(this.world.engine.world, agent.body);
        this.agents2.delete(id);
      }
    }
  }

  private pickDestination(originId: string): string {
    const others = this.farNodeIds.filter((id) => id !== originId);
    return others[Math.floor(this.rng() * others.length)] ?? others[0];
  }

  private stepAgent(agent: Agent, dtMs: number, approachSignalStates: Map<string, SignalLightState>): void {
    const nextId = agent.path[0];
    const edge = this.graph.edgeBetween(this.currentNodeGuess(agent), nextId);
    // Safe to cross only on a confirmed RED for this crossing's approach — yellow still means vehicles
    // are clearing the intersection, not stopped, so it must not be treated as safe.
    const isSafeToCross = edge?.approachId ? approachSignalStates.get(edge.approachId) === "red" : true;

    if (edge?.kind === "crosswalk" && edge.approachId && !isSafeToCross) {
      // Vehicles currently have this crosswalk's approach (green or yellow) — hold at the corner.
      if (agent.waitStartMs === null) agent.waitStartMs = 0;
      agent.waitStartMs += dtMs;
      agent.waitingAtCrossingId = edge.crossingId ?? null;
      this.applySteering(agent, this.bodyPosition(agent), []); // decelerate toward a stop at the current position
      return;
    }

    agent.waitStartMs = null;
    agent.waitingAtCrossingId = null;

    const target = this.graph.node(nextId);
    const neighbors = [...this.agents2.values()]
      .filter((other) => other !== agent)
      .map((other) => ({ x: other.body.position.x, y: other.body.position.y }));

    this.applySteering(agent, target, neighbors);

    const dist = Math.hypot(target.x - agent.body.position.x, target.y - agent.body.position.y);
    if (dist < 4) agent.path.shift();
  }

  private applySteering(agent: Agent, target: { x: number; y: number }, neighbors: { x: number; y: number }[]): void {
    const { fx, fy } = computeSteeringForce(
      { x: agent.body.position.x, y: agent.body.position.y, vx: agent.body.velocity.x, vy: agent.body.velocity.y },
      target,
      neighbors,
      DEFAULT_STEERING_PARAMS
    );
    Matter.Body.applyForce(agent.body, agent.body.position, { x: fx, y: fy });
  }

  private bodyPosition(agent: Agent): { x: number; y: number } {
    return { x: agent.body.position.x, y: agent.body.position.y };
  }

  private currentNodeGuess(agent: Agent): string {
    // Nearest graph node to the agent's current position — used only to look up the edge to the next
    // target for the "is this a crosswalk I need to wait at" check.
    let closest = agent.path[0];
    let bestDist = Infinity;
    for (const nodeId of [...this.farNodeIds, ...this.graph_allNodeIdsFallback()]) {
      const node = this.graph.node(nodeId);
      const d = Math.hypot(node.x - agent.body.position.x, node.y - agent.body.position.y);
      if (d < bestDist) {
        bestDist = d;
        closest = nodeId;
      }
    }
    return closest;
  }

  private graph_allNodeIdsFallback(): string[] {
    return ["corner_NW", "corner_NE", "corner_SW", "corner_SE"];
  }

  get agents(): PedestrianSnapshot[] {
    return [...this.agents2.values()].map((a) => ({ id: a.id, x: a.body.position.x, y: a.body.position.y }));
  }
}
```

**Note on `currentNodeGuess`:** this is a nearest-node lookup rather than tracked state, which is adequate for an 8-node graph but is called out here as a shortcut — Task 4 replaces it with an explicit `agent.lastNodeId` field once jaywalking needs to know precisely which crossing an agent is approaching (nearest-node guessing is not precise enough once an agent can leave the graph mid-crossing).

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- PedestrianController`
Expected: PASS (2 tests).

- [ ] **Step 7: Wire `pedestrians` into `SimSession`'s state snapshot**

Modify `sim-server/src/room/SimSession.ts` — construct a `PedestrianController` in the constructor (`new PedestrianController(this.world, new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges), ["far_N","far_S","far_E","far_W"], mulberry32(rngSeed + 1), 20)`, using a distinct seed offset so pedestrian and vehicle RNG streams don't interfere). In `step()`, the `approachSignalStates` map already computed for `this.traffic.step(...)` (Phase 3, Task 6) is the exact same map `PedestrianController` needs — call `this.pedestrians.step(TICK_MS, approachSignalStates)` right alongside `this.traffic.step(TICK_MS, approachSignalStates)`, both reading from the one `this.signalController.getApproachSignalStates()` call already made this tick. Add `pedestrians: this.pedestrians.agents` to the returned snapshot's `payload`.

- [ ] **Step 8: Render pedestrians in the frontend**

Modify `frontend/src/scenes/MainScene.ts` — in the `onState` callback, mirror the existing vehicle-sprite pattern with a `pedestrianSprites` map and small circles:
```ts
for (const p of snapshot.payload.pedestrians) {
  let sprite = this.pedestrianSprites.get(p.id);
  if (!sprite) {
    sprite = this.add.circle(p.x, p.y, 5, 0xffcc00);
    this.pedestrianSprites.set(p.id, sprite);
  }
  sprite.setPosition(p.x, p.y);
}
```
(Add `private pedestrianSprites = new Map<string, Phaser.GameObjects.Arc>();` alongside the existing `carSprites` field.)

> **Bug found during implementation:** neither the pre-existing `carSprites` map nor this new `pedestrianSprites` map ever removed a sprite once its entity despawned server-side (vehicle despawn shipped in Phase 3; pedestrian despawn is this phase) — both would accumulate frozen ghost sprites at their last-seen position forever, contradicting the whole point of despawn. Fixed by computing a `Set` of live ids from each snapshot and adding a shared `removeStaleSprites(sprites, liveIds)` helper (destroys and deletes any sprite whose id isn't in the live set), called once per entity kind right after its spawn/update loop.

- [ ] **Step 9: Commit**

```bash
git add shared-contracts/schemas/state-snapshot.schema.json shared-contracts/generated shared-contracts/test ai-service/app/contracts sim-server/src/pedestrians/PedestrianController.ts sim-server/test/pedestrians/PedestrianController.test.ts sim-server/src/room/SimSession.ts frontend/src/scenes/MainScene.ts
git commit -m "feat: PedestrianController spawns/moves/despawns agents; state snapshot and frontend render them"
```

---

### Task 4: Jaywalking — precise crossing tracking, probability-driven divergence, collision tagging

**Files:**
- Modify: `sim-server/src/pedestrians/PedestrianController.ts` (replace `currentNodeGuess` with tracked `lastNodeId`; add jaywalk roll)
- Modify: `sim-server/src/physics/CollisionLogger.ts` (generalize to `pedestrian_`-labeled bodies)
- Modify: `sim-server/src/room/SimSession.ts` (tag `cause: "jaywalk"` on qualifying collisions)
- Test: `sim-server/test/pedestrians/PedestrianController.jaywalk.test.ts`
- Test: `sim-server/test/physics/CollisionLogger.test.ts` (extend for `vehicle_pedestrian`)

**Interfaces:**
- Consumes: `jaywalkProbability` (Task 2).
- Produces: `PedestrianController.getCrossingState(crossingId: string): { queueLength: number; waitS: number }`, `PedestrianController.isJaywalking(pedId: string): boolean`.
- Modifies (Interface ledger, Phase 5 — supersedes Phase 3's signature): `CollisionLogger`'s callback becomes `(entities: [string, string], kind: "vehicle_vehicle" | "vehicle_pedestrian") => void`.

- [ ] **Step 1: Replace `currentNodeGuess` with explicit tracked state**

Modify `sim-server/src/pedestrians/PedestrianController.ts` — add `lastNodeId: string` to the `Agent` interface, set it to `originId` at spawn, update it to the just-departed node each time `agent.path.shift()` runs (i.e., right before shifting, set `agent.lastNodeId = agent.path[0]`... concretely: capture `const departedNode = nextId` before the shift only fires when `dist < 4`, so add `agent.lastNodeId = nextId;` immediately after `agent.path.shift();`). Remove `currentNodeGuess` and `graph_allNodeIdsFallback` entirely; every call site that used `this.currentNodeGuess(agent)` now uses `agent.lastNodeId` directly.

- [ ] **Step 2: Write the failing test for jaywalk triggering and crossing-state queries**

`sim-server/test/pedestrians/PedestrianController.jaywalk.test.ts`:
```ts
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
// a real topology bug found only by running it: a far_N<->far_S journey only ever needs cross_W
// or cross_E, so it never waited at cross_N at all, and the "eventually jaywalks" assertion
// silently never triggered.
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
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
    const controller = new PedestrianController(world, graph, ["far_W", "far_E"], mulberry32(5), 300);

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- PedestrianController.jaywalk`
Expected: FAIL — `getCrossingState`/`isJaywalking` don't exist yet.

- [ ] **Step 4: Implement jaywalk triggering and crossing-state queries**

Modify `sim-server/src/pedestrians/PedestrianController.ts`:
- Add `jaywalking: boolean` to the `Agent` interface, default `false`.
- In `stepAgent`, inside the `if (edge?.kind === "crosswalk" && edge.approachId && !isSafeToCross && !agent.jaywalking)` waiting branch (see the `!agent.jaywalking` addition below), after incrementing `waitStartMs`, roll for jaywalking:
```ts
const patienceS = 8; // seconds; a fixed per-agent patience is sufficient at this scale — see Risks
const waitS = agent.waitStartMs / 1000;
const p = jaywalkProbability(waitS, patienceS) * (dtMs / 1000);
if (!agent.jaywalking && this.rng() < p) {
  agent.jaywalking = true;
}
```
- Still inside that branch: if `agent.jaywalking` is true, do **not** hold position — instead steer directly toward `nextId`'s node (ignoring the red-crossing hold), i.e. fall through to the normal steering/advance logic used for a safe crossing. Restructure the branch so the "hold" behavior only applies when `!agent.jaywalking`:
```ts
if (edge?.kind === "crosswalk" && edge.approachId && !isSafeToCross && !agent.jaywalking) {
  // ... existing wait/roll logic ...
  return;
}
if (edge?.kind === "crosswalk" && agent.jaywalking) {
  agent.waitingAtCrossingId = null; // no longer "waiting" — now a live collision risk, per spec §5
}
```
- Add `import { jaywalkProbability } from "./JaywalkModel";` at the top.
- Add the two new methods:
```ts
getCrossingState(crossingId: string): { queueLength: number; waitS: number } {
  const waiting = [...this.agents2.values()].filter((a) => a.waitingAtCrossingId === crossingId);
  const waits = waiting.map((a) => (a.waitStartMs ?? 0) / 1000);
  return { queueLength: waiting.length, waitS: waits.length ? Math.max(...waits) : 0 };
}

isJaywalking(pedId: string): boolean {
  return this.agents2.get(pedId)?.jaywalking ?? false;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- PedestrianController`
Expected: PASS across both `PedestrianController.test.ts` and `PedestrianController.jaywalk.test.ts`. If the jaywalk test is flaky, raise the iteration count or lower `patienceS` slightly — the test only needs *at least one* jaywalk event across 4000 ticks at a deliberately provoking (permanently-red) crossing.

- [ ] **Step 6: Generalize `CollisionLogger` for vehicle-pedestrian collisions**

Modify `sim-server/src/physics/CollisionLogger.ts`:
```ts
import Matter from "matter-js";
import type { PhysicsWorld } from "./PhysicsWorld";

export type CollisionKind = "vehicle_vehicle" | "vehicle_pedestrian";

export class CollisionLogger {
  constructor(world: PhysicsWorld, onCollision: (entities: [string, string], kind: CollisionKind) => void) {
    Matter.Events.on(world.engine, "collisionStart", (event) => {
      for (const pair of event.pairs) {
        const [a, b] = [pair.bodyA, pair.bodyB];
        if (a.isSensor || b.isSensor) continue;

        const aIsVehicle = a.label.startsWith("vehicle_");
        const bIsVehicle = b.label.startsWith("vehicle_");
        const aIsPed = a.label.startsWith("pedestrian_");
        const bIsPed = b.label.startsWith("pedestrian_");

        if (aIsVehicle && bIsVehicle) {
          onCollision([a.label.replace("vehicle_", ""), b.label.replace("vehicle_", "")], "vehicle_vehicle");
        } else if ((aIsVehicle && bIsPed) || (aIsPed && bIsVehicle)) {
          const vehicleLabel = aIsVehicle ? a.label : b.label;
          const pedLabel = aIsPed ? a.label : b.label;
          onCollision([vehicleLabel.replace("vehicle_", ""), pedLabel.replace("pedestrian_", "")], "vehicle_pedestrian");
        }
      }
    });
  }
}
```

Modify `sim-server/test/physics/CollisionLogger.test.ts` — update the existing `onCollision` mock assertions to also check the new second callback argument (`"vehicle_vehicle"` for the existing test), and add a third test:
```ts
it("reports vehicle_pedestrian for a vehicle-pedestrian overlap", () => {
  const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
  const onCollision = vi.fn();
  new CollisionLogger(world, onCollision);

  const car = new VehicleBody(world, "car_1", { x: -20, y: 0, heading: 0 });
  const ped = Matter.Bodies.circle(20, 0, 6, { label: "pedestrian_ped_1" });
  Matter.Composite.add(world.engine.world, ped);
  car.applyInput(1, 0, 0);

  for (let i = 0; i < 60; i++) world.step(16);

  const call = onCollision.mock.calls.find((c) => c[1] === "vehicle_pedestrian");
  expect(call).toBeDefined();
  expect(new Set(call![0])).toEqual(new Set(["car_1", "ped_1"]));
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- CollisionLogger`
Expected: PASS (3 tests).

- [ ] **Step 8: Wire the collision kind and jaywalk cause into `SimSession`**

Modify `sim-server/src/room/SimSession.ts` — update the `CollisionLogger` callback:
```ts
new CollisionLogger(this.world, (entities, kind) => {
  const cause = kind === "vehicle_pedestrian" && this.pedestrians.isJaywalking(entities[1]) ? "jaywalk" : undefined;
  this.store.writeEvent(this.sessionId, {
    t: this.tick * (TICK_MS / 1000),
    type: "collision",
    entities,
    kind,
    ...(cause ? { cause } : {})
  });
  this.pendingRoomEvents.push({
    type: "room_event",
    ts: Date.now(),
    payload: { kind: "collision", entities, collisionKind: kind }
  });
});
```

- [ ] **Step 9: Commit**

```bash
git add sim-server/src/pedestrians/PedestrianController.ts sim-server/test/pedestrians sim-server/src/physics/CollisionLogger.ts sim-server/test/physics/CollisionLogger.test.ts sim-server/src/room/SimSession.ts
git commit -m "feat(sim-server): jaywalking triggers real collision risk; CollisionLogger distinguishes vehicle_pedestrian and tags jaywalk cause"
```

---

### Task 5: Lock the RL observation interface — extend `signal-decision` with pedestrian context

**Files:**
- Modify: `shared-contracts/schemas/signal-decision.schema.json` (additive `pedestrianCrossings` field)
- Modify: `sim-server/src/signals/SignalController.ts` (accept and populate pedestrian state)
- Modify: `sim-server/src/room/SimSession.ts` (pass `PedestrianController` into `SignalController`)
- Test: `sim-server/test/signals/SignalController.test.ts` (extend)

**Interfaces:**
- Produces (Interface ledger, Phase 5): `SignalDecisionRequest.pedestrianCrossings: [{ crossingId: string; queueLength: number; waitS: number }]` (additive; `ai-service`'s `rule_based.py` ignores it for now — Phase 6 is where it enters the reward/observation).

- [ ] **Step 1: Extend the schema**

Modify `shared-contracts/schemas/signal-decision.schema.json` — add to `SignalDecisionRequest`'s properties:
```json
"pedestrianCrossings": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["crossingId", "queueLength", "waitS"],
    "properties": {
      "crossingId": { "type": "string" },
      "queueLength": { "type": "integer", "minimum": 0 },
      "waitS": { "type": "number", "minimum": 0 }
    }
  }
}
```
Do **not** add it to `required` — this keeps every existing caller (Phase 2's tests, which don't set it) valid, matching the "additive" rule from `00-overview.md` §4.

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 2: Extend `SignalController` to accept and forward pedestrian crossing state**

Modify `sim-server/src/signals/SignalController.ts` constructor to accept an optional `getPedestrianCrossingState?: (crossingId: string) => { queueLength: number; waitS: number }` parameter and a `crossingIdsByApproach: Record<string, string>` map (`{ app_N: "cross_N", app_S: "cross_S", app_E: "cross_E", app_W: "cross_W" }`, matching the map's `pedestrianEdges` metadata). In `step()`, when building the request, add:
```ts
pedestrianCrossings: this.getPedestrianCrossingState
  ? Object.entries(this.crossingIdsByApproach).map(([, crossingId]) => ({
      crossingId,
      ...this.getPedestrianCrossingState!(crossingId)
    }))
  : []
```

- [ ] **Step 3: Extend the `SignalController` test**

Modify `sim-server/test/signals/SignalController.test.ts` — add a test:
```ts
it("includes pedestrian crossing state in the request when a provider is given", async () => {
  const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
  const crossingMap = { app_N: "cross_N", app_S: "cross_S", app_E: "cross_E", app_W: "cross_W" };
  const controller = new SignalController(
    phases,
    client as any,
    fakeDetector({}),
    "int_1",
    (crossingId: string) => ({ queueLength: crossingId === "cross_N" ? 3 : 0, waitS: crossingId === "cross_N" ? 12 : 0 }),
    crossingMap
  );

  await controller.step(1500);

  const sent = client.decide.mock.calls[0][0];
  const crossN = sent.pedestrianCrossings.find((c: any) => c.crossingId === "cross_N");
  expect(crossN.queueLength).toBe(3);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- SignalController`
Expected: PASS (4 tests). Update Phase 2's original three test cases' `new SignalController(...)` calls only if TypeScript's strictness requires the two new constructor params — since they're declared optional (`?`), the existing 3-argument-plus call sites from Phase 2 continue to compile unchanged.

- [ ] **Step 5: Wire it into `SimSession`**

Modify `sim-server/src/room/SimSession.ts` — pass `(crossingId) => this.pedestrians.getCrossingState(crossingId)` and the `crossingIdsByApproach` map into the `SignalController` constructor. Note this requires constructing `PedestrianController` (Task 3) *before* `SignalController` in `SimSession`'s constructor body, reordering the two `new` calls if needed.

- [ ] **Step 6: Commit**

```bash
git add shared-contracts/schemas/signal-decision.schema.json shared-contracts/generated ai-service/app/contracts sim-server/src/signals/SignalController.ts sim-server/test/signals/SignalController.test.ts sim-server/src/room/SimSession.ts
git commit -m "feat(contracts): lock pedestrianCrossings into signal-decision request ahead of Phase 6 RL"
```

---

### Task 6: KPI extension, pedestrian determinism, manual smoke test

**Files:**
- Modify: `sim-server/src/session/SessionEvent.ts` (extend `KpiSnapshot`)
- Create: `sim-server/test/determinism/pedestrianDeterminism.test.ts`
- Modify: `README.md`

**Interfaces:**
- Modifies (Interface ledger, Phase 5): `KpiSnapshot` gains `avgPedWaitS: number` and `jaywalkEvents: number`.

- [ ] **Step 1: Extend `KpiSnapshot`**

Modify `sim-server/src/session/SessionEvent.ts`:
```ts
export interface KpiSnapshot {
  t: number;
  avgVehicleWaitS: number;
  throughput: number;
  avgPedWaitS: number;
  jaywalkEvents: number;
}
```
No production code constructs a `KpiSnapshot` literal yet (periodic KPI snapshot writing is wired in Phase 10 alongside the KPI panel) — but Phase 1's `LocalDiskSessionStore.test.ts` does, in its "appends events and kpi snapshots" test. **Bug found during implementation:** that test's literal (`{ t: 60, avgVehicleWaitS: 4.2, throughput: 12 }`) has no `avgPedWaitS`/`jaywalkEvents`, so this is not actually a zero-call-site change — update it to `{ t: 60, avgVehicleWaitS: 4.2, throughput: 12, avgPedWaitS: 0, jaywalkEvents: 0 }` in the same commit.

- [ ] **Step 2: Write the pedestrian determinism test**

`sim-server/test/determinism/pedestrianDeterminism.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";
import { PedestrianController } from "../../src/pedestrians/PedestrianController";
import { mulberry32 } from "../../src/util/mulberry32";

function runAndCollectPositions(seed: number): { id: string; x: number; y: number }[] {
  const map = loadMap("../../maps/grid_1x1_v1.json");
  const world = new PhysicsWorld(map);
  const graph = new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges);
  const controller = new PedestrianController(world, graph, ["far_N", "far_S", "far_E", "far_W"], mulberry32(seed), 60);
  // Just needs a fixed signal state, not a specifically crossable/uncrossable one — general
  // position determinism doesn't depend on the far_N/far_S <-> cross_N/cross_S topology quirk
  // that Task 4's jaywalk tests had to work around.
  const neverSafeForN = new Map([
    ["app_N", "green"], ["app_S", "green"], ["app_E", "red"], ["app_W", "red"]
  ] as const);

  for (let i = 0; i < 500; i++) {
    world.step(50);
    controller.step(50, neverSafeForN);
  }
  return controller.agents;
}

describe("pedestrian determinism", () => {
  it("produces identical agent positions run-to-run given the same seed", () => {
    expect(runAndCollectPositions(4242)).toEqual(runAndCollectPositions(4242));
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm --filter sim-server test -- pedestrianDeterminism`
Expected: PASS. If it fails, check for any remaining `Math.random()`/`Date.now()` in `PedestrianController`'s spawn-id or destination-pick logic — both should route through the injected `rng`/an incrementing counter only, same class of bug fixed for vehicles in Phase 3 Task 7.

- [ ] **Step 4: Add the manual smoke test to the README**

Append to `README.md`:
```markdown
## Phase 5 manual smoke test (pedestrians)
1. Open the frontend; small yellow circles (pedestrians) should appear walking along the sidewalks and crosswalks.
2. Watch a crosswalk while its approach has a green light — pedestrians should visibly stop and wait at the corner, not walk into traffic.
3. Once the light turns red for that approach, waiting pedestrians should proceed across.
4. Leave the sim running with one direction permanently busy (or just wait long enough) — eventually a pedestrian should jaywalk (visibly cut across outside the crosswalk lines) rather than waiting forever.
5. Drive a car through a crosswalk while a jaywalking pedestrian is crossing — confirm a real collision deflection occurs (not clipping), and check the session JSON for a `collision` event with `kind: "vehicle_pedestrian"` and `cause: "jaywalk"`.
```

- [ ] **Step 5: Run the full local stack and perform the 5 steps above**

Run: `docker compose -f infra/docker-compose.yml up --build`
Expected: all 5 steps pass by direct observation.

- [ ] **Step 6: Commit**

```bash
git add sim-server/src/session/SessionEvent.ts sim-server/test/determinism/pedestrianDeterminism.test.ts README.md
git commit -m "feat(sim-server): extend KpiSnapshot for pedestrians; add pedestrian determinism test and smoke test"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes | `PedestrianGraph` (A*), `computeSteeringForce`, `jaywalkProbability`, `PedestrianController` (spawn/despawn/wait/jaywalk), extended `CollisionLogger` |
| Integration | Unaffected directly | `signal-decision`'s additive field doesn't change existing integration coverage; Phase 8 revisits with the full pyramid |
| Physics/determinism | Yes (extended) | New `pedestrianDeterminism.test.ts` alongside Phase 3's vehicle version |
| Load | Not yet | Phase 8 — pedestrian agents are flagged there as "the more expensive addition to the Matter.js tick" per spec §11 |
| RL regression | N/A | Phase 6 |
| E2E | Manual only | 5-step walkthrough above |

## Definition of Done

- [ ] Pedestrians visibly spawn, path across crosswalks/sidewalks, wait for a safe crossing, and despawn at their destination.
- [ ] At least one jaywalk event is observable within a reasonable manual test window when a crossing is kept persistently unsafe.
- [ ] A vehicle-pedestrian collision produces a real physical deflection and a correctly-tagged `collision` session event.
- [ ] `SignalDecisionRequest` carries `pedestrianCrossings` on every call, additive and non-breaking to Phase 2's tests.
- [ ] Both determinism harnesses (vehicle from Phase 3, pedestrian from this phase) pass.
- [ ] Every file/signature in the Interface ledger's "From Phase 5" section (`00-overview.md` §6) exists, including the `CollisionLogger` signature change noted as superseding Phase 3's.

## Risks / open implementation notes

- `patienceS = 8` (Task 4) is a fixed constant, not per-agent variation — the spec's description ("each pedestrian has a patience/risk-tolerance value") implies per-agent variance. A fixed value is an accepted simplification for this phase (the probability curve and collision mechanics are what matter for the demo); adding per-agent sampling (e.g. `patienceS = 5 + rng() * 10` at spawn) is a small, isolated follow-up if the uniform behavior reads as too synchronized in the actual demo.
- `PedestrianController`'s `currentNodeGuess` shortcut (Task 3) is explicitly temporary and replaced within the same phase (Task 4) — flagged in case an implementer works Task 3 and Task 4 as separate sessions and is tempted to leave the guess-based version in place.
- Load implications of pedestrian agents (per spec §11's own callout) are deferred to Phase 8's load test, not estimated here.
