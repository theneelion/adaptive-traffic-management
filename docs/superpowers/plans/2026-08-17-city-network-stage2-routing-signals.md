# City Network Stage 2: Routing + Signals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize routing (multi-hop vehicle/EV paths across N intersections), signal control
(one `SignalController` per intersection, EV green-wave preemption via a hard `forcePhase`
override), and the rule-based AI fallback (basic neighbor-aware coordination) — validated against
`fixture_curved_3int.json` (3 intersections) with zero behavior change to `grid_1x1_v1.json` (1
intersection, where every "multi-hop" code path degenerates to exactly the single hop it already
does today).

**Architecture:** Extend `RoadGraph` to produce genuinely traversable directed edges between real
intersections (not just spokes to synthetic far points), generalize `TurnPaths` to compose an
arbitrary-length chain of approaches into one `VehiclePath` with a `stopLines` array (one stop per
intersection along the route), then thread that through `TrafficController`/`EvRouter`/
`SignalController`/`SimSession`. Finish deleting the `Direction`/`allowedDirections` compass
machinery Stage 1 deliberately deferred (§5.1 of the spec), replacing it with `allowedApproachIds`
resolved once at load time — `grid_1x1_v1.json`'s raw JSON keeps its old `direction`/
`allowedDirections` fields unmodified; `loadMap` normalizes them into the new shape so no map file
needs editing.

**Tech Stack:** TypeScript (`sim-server`), Python/FastAPI (`ai-service`), JSON Schema
(`shared-contracts`).

**Spec:** `docs/superpowers/specs/2026-08-17-city-traffic-network-design.md` — this plan implements
§5.1 (deferred half), §7 (routing), §8.1-8.2 (signals + coordinated rule-based fallback). §8.3
(coordinated RL) is Stage 5, out of scope here.

## Global Constraints

- `grid_1x1_v1.json` and every test that loads it must keep passing **completely unmodified** —
  the file itself is never edited; all schema generalization is backward-compatible via optional
  fields resolved by `loadMap`.
- `fixture_curved_3int.json` (`maps/fixture_curved_3int.json`, from Stage 1) is the multi-hop test
  fixture. Its `direction` per-approach fields and `allowedDirections` phase fields get replaced
  with explicit `allowedApproachIds` in this stage (this file is owned by this session, unlike the
  grid file) since several of its approaches don't have a clean compass direction (e.g. `b_from_c`
  at ~15°) — this is done in Task 1.
- Never run `git commit` or `git add` — the user reviews and commits everything themselves.
- Every task ends with the relevant tests passing, not a commit step.

---

### Task 1: Schema generalization — `allowedApproachIds`, optional `Direction`, terminal detection

**Files:**
- Modify: `sim-server/src/maps/MapDefinition.ts`
- Modify: `sim-server/src/maps/loadMap.ts`
- Modify: `maps/fixture_curved_3int.json` (phases: `allowedDirections` → `allowedApproachIds`)
- Test: `sim-server/test/maps/loadMap.normalize.test.ts`

**Interfaces:**
- Produces: `SignalPhaseDef.allowedApproachIds: string[]` (always populated after `loadMap`,
  regardless of which raw field the JSON used), `isTerminalApproach(mapDef, approach): boolean`
  (exported from `MapDefinition.ts`; true when `approach.laneStartX/Y` doesn't coincide with any
  `IntersectionDef`'s `x/y` within a small epsilon — used by Tasks 2 and 5).

- [ ] **Step 1: Widen the types**

In `MapDefinition.ts`, change:
```ts
export interface SignalPhaseDef {
  id: string;
  allowedDirections?: Direction[]; // legacy; loadMap normalizes this into allowedApproachIds below
  allowedApproachIds?: string[];   // raw JSON may omit this if allowedDirections is present
  durationMs: number;
}
```
and make `ApproachDef.direction` optional (`direction?: Direction`) — it's now purely a hint for
legacy `allowedDirections` resolution, never read by geometry or routing code.

Add at the bottom of the file:
```ts
const TERMINAL_EPSILON = 1;

export function isTerminalApproach(mapDef: MapDefinition, approach: ApproachDef): boolean {
  return !mapDef.intersections.some(
    (i) => Math.hypot(i.x - approach.laneStartX, i.y - approach.laneStartY) < TERMINAL_EPSILON
  );
}
```

- [ ] **Step 2: Normalize phases in `loadMap`**

After `loadMap`'s existing validation (the `phases.length === 0` check), add, before the final
`return raw as MapDefinition`:
```ts
for (const intersection of raw.intersections) {
  const ownApproaches = raw.approaches.filter((a: ApproachDef) => a.intersectionId === intersection.id);
  for (const phase of intersection.phases) {
    if (phase.allowedApproachIds) continue;
    if (!phase.allowedDirections) {
      throw new Error(`Phase ${phase.id} on ${intersection.id} has neither allowedApproachIds nor allowedDirections`);
    }
    phase.allowedApproachIds = ownApproaches
      .filter((a: ApproachDef) => a.direction && phase.allowedDirections!.includes(a.direction))
      .map((a: ApproachDef) => a.id);
  }
}
```
This makes `SignalPhaseDef.allowedApproachIds` always populated by the time any other code sees a
loaded `MapDefinition`, for both old-style (`grid_1x1_v1.json`, `allowedDirections`) and new-style
(anything using `allowedApproachIds` directly) map JSON.

Import `ApproachDef` as a type in `loadMap.ts` if not already imported.

- [ ] **Step 3: Rewrite the fixture's phases to explicit `allowedApproachIds`**

In `maps/fixture_curved_3int.json`, replace every phase's `allowedDirections` with
`allowedApproachIds` listing that intersection's own approach IDs directly (no `direction`
matching needed since these are hand-authored):
- `int_A`: `p1: ["a_far_west"]` is wrong — `int_A` needs phases covering ALL of its own approaches.
  Check `int_A`'s approaches in the fixture (`a_far_west`, `a_far_south`, `a_from_b`) and split
  into two non-conflicting phases, e.g. `p1: allowedApproachIds: ["a_far_west"]`,
  `p2: allowedApproachIds: ["a_far_south", "a_from_b"]` (or whatever grouping matches the actual
  approach angles at `int_A` — inspect the fixture's approach coordinates before deciding; the
  exact split doesn't affect Stage 2's routing logic, only needs to be a valid 2-phase partition of
  that intersection's own approach IDs, per spec §5.1's exactly-2-phases rule).
- `int_B`: has `a_from_b`(wait, no — check actual ownership: approaches with `intersectionId:
  "int_B"` are `b_from_a`, `b_far_north`, `b_from_c`). Split those 3 into two phases, e.g.
  `p1: ["b_from_a", "b_far_north"]`, `p2: ["b_from_c"]` — again inspect real angles/conflicts
  before finalizing; a T-junction-style split (two roughly-opposite/adjacent approaches together,
  the third alone) is reasonable here.
- `int_C`: approaches are `c_from_b`, `c_far_east`. Split `p1: ["c_from_b"]`, `p2: ["c_far_east"]`.

You may also remove the now-unused `direction` field from each approach in this file (optional
cleanup, not required — `loadMap`'s normalization only reads `direction` when `allowedApproachIds`
is absent, and every phase in this file will have `allowedApproachIds` after this step).

- [ ] **Step 4: Write and run the normalization test**

Create `sim-server/test/maps/loadMap.normalize.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { isTerminalApproach } from "../../src/maps/MapDefinition";

describe("loadMap phase normalization", () => {
  it("derives allowedApproachIds from legacy allowedDirections for grid_1x1_v1.json", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const nsPhase = map.intersections[0].phases.find((p) => p.id === "NS_through")!;
    expect(new Set(nsPhase.allowedApproachIds)).toEqual(new Set(["app_N", "app_S"]));
  });

  it("passes through explicit allowedApproachIds unchanged for fixture_curved_3int.json", () => {
    const map = loadMap("../../maps/fixture_curved_3int.json");
    for (const intersection of map.intersections) {
      for (const phase of intersection.phases) {
        expect(phase.allowedApproachIds!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("isTerminalApproach", () => {
  it("every grid_1x1_v1.json approach is terminal (all 4 laneStarts are far spawn points)", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    for (const a of map.approaches) expect(isTerminalApproach(map, a)).toBe(true);
  });

  it("connector approaches in fixture_curved_3int.json are not terminal; true far approaches are", () => {
    const map = loadMap("../../maps/fixture_curved_3int.json");
    const byId = (id: string) => map.approaches.find((a) => a.id === id)!;
    expect(isTerminalApproach(map, byId("a_from_b"))).toBe(false); // laneStart = int_B
    expect(isTerminalApproach(map, byId("b_from_c"))).toBe(false); // laneStart = int_C
    expect(isTerminalApproach(map, byId("a_far_west"))).toBe(true);
    expect(isTerminalApproach(map, byId("c_far_east"))).toBe(true);
  });
});
```

Run: `cd sim-server && npx vitest run test/maps/loadMap.normalize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite**

Run: `cd sim-server && npx vitest run`
Expected: all previously-passing tests still pass (the `direction`-reading call sites —
`TrafficController.pickExitApproachId`, `EvRouter`'s old `APPROACH_DIRECTIONS` — haven't been
touched yet in this task, so they still compile and behave exactly as before; this task only adds
new fields/normalization, nothing is deleted yet).

---

### Task 2: `RoadGraph` — real directed edges between intersections

**Files:**
- Modify: `sim-server/src/ev/RoadGraph.ts`
- Test: `sim-server/test/ev/RoadGraph.test.ts` (existing, must keep passing unmodified), add cases
  to a new `sim-server/test/ev/RoadGraph.multiHop.test.ts`

**Interfaces:**
- Consumes: `isTerminalApproach` (Task 1).
- Produces: `buildRoadGraph(mapDef)` now returns a graph with a **directed** edge for every
  approach's natural (laneStart→laneEnd) direction, PLUS a reverse-direction edge with the *same*
  `approachId` only for terminal approaches (exit-by-reversal, matching Stage 1's `TurnPaths`
  treatment of terminal exits). Connector approaches (laneStart coincides with another
  intersection) get only their one natural-direction edge — the opposite physical direction is
  covered by that road's *other* approach object (e.g. `b_from_a` for `a_from_b`'s reverse), never
  by reversing the same one.

- [ ] **Step 1: Understand why today's auto-reverse is wrong for connectors**

Read the current `RoadGraph` constructor: it auto-adds a reversed copy of every edge with the same
`approachId`. This is harmless today because `grid_1x1_v1.json` only has spoke-to-one-intersection
edges (reversal there is exactly the terminal-exit case). It becomes wrong once connector
approaches exist: reversing `a_from_b`'s edge would claim a vehicle can travel `int_A → int_B`
"via approach `a_from_b`," but `a_from_b`'s own geometry only makes sense traveling `int_B → int_A`
(its own laneStart/laneEnd). The correct approach for `int_A → int_B` is the *separate* approach
object `b_from_a`. Do not try to make a connector reversible — rely on the map convention (already
followed by `fixture_curved_3int.json`) that every connector road is authored as a pair of
approaches, one per direction.

- [ ] **Step 2: Rewrite `buildRoadGraph` and remove the constructor's auto-reverse**

In `RoadGraph.ts`, remove this line from the constructor:
```ts
this.adjacency.get(edge.to)?.push({ ...edge, from: edge.to, to: edge.from });
```
(keep the constructor otherwise storing edges exactly as given — the graph becomes purely
directed, driven entirely by which edges `buildRoadGraph` decides to add).

Rewrite `buildRoadGraph`:
```ts
export function buildRoadGraph(mapDef: MapDefinition): RoadGraph {
  const nodes: RoadNode[] = mapDef.intersections.map((i) => ({ id: i.id, x: i.x, y: i.y }));
  const edges: RoadEdge[] = [];

  const intersectionAt = (x: number, y: number) =>
    mapDef.intersections.find((i) => Math.hypot(i.x - x, i.y - y) < 1);

  for (const approach of mapDef.approaches) {
    const farIntersection = intersectionAt(approach.laneStartX, approach.laneStartY);
    if (farIntersection && farIntersection.id !== approach.intersectionId) {
      // Connector between two real intersections: one directed edge, its own natural direction.
      // The opposite physical direction is a *different* approach object (see Step 1).
      edges.push({ from: farIntersection.id, to: approach.intersectionId, approachId: approach.id });
    } else {
      // Terminal spoke: same approach reversed for exit, exactly like today's behavior.
      const endNodeId = `end_${approach.id}`;
      nodes.push({ id: endNodeId, x: approach.laneStartX, y: approach.laneStartY });
      edges.push({ from: endNodeId, to: approach.intersectionId, approachId: approach.id });
      edges.push({ from: approach.intersectionId, to: endNodeId, approachId: approach.id });
    }
  }

  return new RoadGraph(nodes, edges);
}
```

- [ ] **Step 3: Run the existing RoadGraph test**

Run: `cd sim-server && npx vitest run test/ev/RoadGraph.test.ts`
Expected: PASS, unmodified — `grid_1x1_v1.json`'s 4 approaches are all terminal, so this produces
exactly the same edges (`end_X ↔ int_1`) as before, just built without the generic auto-reverse.

- [ ] **Step 4: Write and run a multi-hop connectivity test**

Create `sim-server/test/ev/RoadGraph.multiHop.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildRoadGraph } from "../../src/ev/RoadGraph";

describe("buildRoadGraph on a multi-intersection fixture", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");
  const graph = buildRoadGraph(map);

  it("routes from a far approach at int_B to a far approach at int_C via the b_from_c/c_from_b connector", () => {
    const route = graph.shortestPath("end_b_far_north", "end_c_far_east");
    expect(route.nodeIds).toEqual(["end_b_far_north", "int_B", "int_C", "end_c_far_east"]);
    expect(route.edges.map((e) => e.approachId)).toEqual(["b_far_north", "c_from_b", "c_far_east"]);
  });

  it("routes the other direction, using the opposite connector approach", () => {
    const route = graph.shortestPath("end_c_far_east", "end_b_far_north");
    expect(route.edges.map((e) => e.approachId)).toEqual(["c_far_east", "b_from_c", "b_far_north"]);
  });
});
```

Run: `cd sim-server && npx vitest run test/ev/RoadGraph.multiHop.test.ts`
Expected: PASS. If the route doesn't match, print `route.nodeIds`/`route.edges` and check the
fixture's actual approach `intersectionId`/`laneStartX/Y` values against what Step 2's connector
detection expects — this is exactly the kind of thing Stage 1's probe-script methodology caught
early; don't guess, inspect the real fixture data.

- [ ] **Step 5: Run the full suite**

Run: `cd sim-server && npx vitest run`
Expected: PASS. `EvRouter`'s existing single "validates a route exists" call
(`this.graph.shortestPath(...)`) still succeeds on `grid_1x1_v1.json` (unchanged topology).

---

### Task 3: Multi-hop `VehiclePath` — `buildMultiHopVehiclePath`, `stopLines`, `approachIdAt`

**Files:**
- Modify: `sim-server/src/vehicles/TurnPaths.ts`
- Test: `sim-server/test/vehicles/TurnPaths.multiHopPath.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface VehiclePath {
    totalLength: number;
    stopLineDistance: number; // kept for backward compat = stopLines[0]?.distance ?? totalLength
    stopLines: { distance: number; approachId: string }[]; // one per intersection crossed, in order
    pointAt(distance: number): Point;
    headingAt(distance: number): number;
    closestProgress(position: Point, hint?: number): number;
    approachIdAt(distance: number): string; // which approach's physical lane this distance falls on
  }
  export function buildMultiHopVehiclePath(mapDef: MapDefinition, approachIds: string[]): VehiclePath;
  ```
  `buildVehiclePath(mapDef, entryId, exitId)` becomes `return buildMultiHopVehiclePath(mapDef, [entryId, exitId]);` — byte-identical behavior for every existing 2-hop caller/test.

- [ ] **Step 1: Understand the two segment "modes" for hops after the first**

Every approach in `approachIds` after index 0 is either:
- The **last** element: a terminal exit, used *reversed* — exactly today's `exitSegment` (drive
  backward from `length - STOP_LINE_OFFSET` down to `0`), no stop line (the vehicle is leaving the
  network).
- A **middle** element: a connector, used *forward* — drive from a small offset near its own
  `laneStart` (the intersection just crossed) up to `length - STOP_LINE_OFFSET` near its own
  `laneEnd` (the *next* intersection, where it needs a stop line).

Between every consecutive pair of hops, insert the same kind of turn-crossing bezier Stage 1's
`buildVehiclePath` already builds (via `turnControlPoint`), just computed for that specific
hop-to-hop junction instead of only once.

- [ ] **Step 2: Add `composePath`'s segment-to-approachId tracking**

`composePath` (already in this file) needs to let `approachIdAt` look up which approach a given
distance belongs to. Change its signature to also accept the originating approach id per segment,
and expose `approachIdAt`:
```ts
function composePath(
  segments: { segment: Segment; approachId: string }[],
  stopLineDistance: number,
  stopLines: { distance: number; approachId: string }[]
): VehiclePath {
  const totalLength = segments.reduce((sum, s) => sum + s.segment.length, 0);

  function locate(d: number): { segment: Segment; localD: number; approachId: string } {
    let remaining = Math.max(0, Math.min(d, totalLength));
    for (const { segment, approachId } of segments) {
      if (remaining <= segment.length) return { segment, localD: remaining, approachId };
      remaining -= segment.length;
    }
    const last = segments[segments.length - 1];
    return { segment: last.segment, localD: last.segment.length, approachId: last.approachId };
  }
  // ...pointAt/headingAt/closestProgress bodies unchanged except calling locate() this new way and
  // destructuring {segment, localD} out of its result...

  return {
    totalLength,
    stopLineDistance,
    stopLines,
    pointAt: (d) => locate(d).segment.pointAtDistance(locate(d).localD),
    headingAt: (d) => locate(d).segment.headingAtDistance(locate(d).localD),
    approachIdAt: (d) => locate(d).approachId,
    closestProgress: /* unchanged body, still built from samples via pointAt */
  };
}
```
`chainedWaypointSegment`'s own internal use of `composePath` (Task 3 of Stage 1) needs updating for
the new signature too — wrap its plain `Segment[]` as `segments.map(s => ({segment: s, approachId: "" }))` with an empty/unused id (that inner `composePath` call is only used to get a combined
`Segment` back out, never a full `VehiclePath` with meaningful `approachIdAt`), and pass an empty
`stopLines: []`.

- [ ] **Step 3: Write `buildMultiHopVehiclePath`**

```ts
export function buildMultiHopVehiclePath(mapDef: MapDefinition, approachIds: string[]): VehiclePath {
  const approaches = approachIds.map((id) => mapDef.approaches.find((a) => a.id === id)!);
  const centerlines = approaches.map((a) => buildApproachCenterline(a));

  const segments: { segment: Segment; approachId: string }[] = [];
  const stopLines: { distance: number; approachId: string }[] = [];
  let cumulative = 0;

  // Hop 0 (entry): forward, up to its own stop line.
  const entryStopOffset = Math.min(STOP_LINE_OFFSET, centerlines[0].length / 2);
  const entryStopDistance = centerlines[0].length - entryStopOffset;
  segments.push({
    approachId: approachIds[0],
    segment: { length: entryStopDistance, pointAtDistance: (d) => centerlines[0].pointAtDistance(d), headingAtDistance: (d) => centerlines[0].headingAtDistance(d) }
  });
  stopLines.push({ distance: entryStopDistance, approachId: approachIds[0] });
  cumulative += entryStopDistance;
  let prevStopPoint = centerlines[0].pointAtDistance(entryStopDistance);
  let prevHeading = headingIntoIntersection(approaches[0]);

  for (let hop = 1; hop < approachIds.length; hop++) {
    const isLast = hop === approachIds.length - 1;
    const centerline = centerlines[hop];
    const approach = approaches[hop];

    let startDistance: number, endDistance: number, forward: boolean, nextHeading: number, startPoint: { x: number; y: number };
    if (isLast) {
      // Terminal exit: reversed, from near laneEnd down to 0, no stop line.
      const stopOffset = Math.min(STOP_LINE_OFFSET, centerline.length / 2);
      startDistance = centerline.length - stopOffset;
      endDistance = 0;
      forward = false;
      startPoint = centerline.pointAtDistance(startDistance);
      nextHeading = headingOutOfIntersection(approach);
    } else {
      // Connector: forward, from near laneStart up to near laneEnd (its own stop line).
      const startOffset = Math.min(STOP_LINE_OFFSET, centerline.length / 2);
      const stopOffset = Math.min(STOP_LINE_OFFSET, centerline.length / 2);
      startDistance = startOffset;
      endDistance = centerline.length - stopOffset;
      forward = true;
      startPoint = centerline.pointAtDistance(startOffset);
      nextHeading = headingIntoIntersection(approach); // heading arriving at approach's own intersectionId
    }

    const crossingLength = Math.hypot(startPoint.x - prevStopPoint.x, startPoint.y - prevStopPoint.y);
    const isStraight = isRoughlyOpposite(prevHeading, forward ? Math.atan2(Math.sin(nextHeading + Math.PI), Math.cos(nextHeading + Math.PI)) : nextHeading);
    // Reuse the exact crossing-bezier construction buildVehiclePath (below) already used for the
    // single-hop case — see that function's own crossing-segment code for the precise call. The
    // "exit heading" passed to turnControlPoint is always headingOutOfIntersection of whichever
    // approach the vehicle is about to travel; for a forward connector that's the reverse of
    // headingIntoIntersection (see headingOutOfIntersection's own definition).
    const exitHeadingForCrossing = forward ? Math.atan2(Math.sin(nextHeading + Math.PI), Math.cos(nextHeading + Math.PI)) : nextHeading;
    const crossing: Segment = isStraight
      ? straightSegment(prevStopPoint, startPoint)
      : bezierSegment(prevStopPoint, turnControlPoint(prevStopPoint, prevHeading, startPoint, exitHeadingForCrossing, TURN_CONTROL_FRACTION), startPoint);
    segments.push({ approachId: approachIds[hop - 1], segment: crossing });
    cumulative += crossing.length;

    const hopLength = Math.abs(endDistance - startDistance);
    const hopSegment: Segment = {
      length: hopLength,
      pointAtDistance: (d) => centerline.pointAtDistance(forward ? startDistance + d : startDistance - d),
      headingAtDistance: (d) => {
        const raw = centerline.headingAtDistance(forward ? startDistance + d : startDistance - d);
        return forward ? raw : Math.atan2(Math.sin(raw + Math.PI), Math.cos(raw + Math.PI));
      }
    };
    segments.push({ approachId: approachIds[hop], segment: hopSegment });

    if (!isLast) {
      stopLines.push({ distance: cumulative + hopLength, approachId: approachIds[hop] });
    }
    cumulative += hopLength;
    prevStopPoint = hopSegment.pointAtDistance(hopLength);
    prevHeading = forward ? headingOutOfIntersection(approach) : Math.atan2(Math.sin(nextHeading + Math.PI), Math.cos(nextHeading + Math.PI));
  }

  return composePath(segments, stopLines[0]?.distance ?? cumulative, stopLines);
}

export function buildVehiclePath(mapDef: MapDefinition, entryApproachId: string, exitApproachId: string): VehiclePath {
  return buildMultiHopVehiclePath(mapDef, [entryApproachId, exitApproachId]);
}
```
**Note for the implementer:** the heading bookkeeping above (`prevHeading` after a forward hop
should be the heading *leaving* that connector, ready to feed the next crossing) is the most
error-prone part of this task — validate it empirically with a probe script on the fixture's real
3-hop route before trusting the unit tests alone, the same discipline Stage 1 used for turn
geometry. If a probe shows the path visibly kinking or looping back at a junction, the bug is
almost always a heading sign error here, not in `turnControlPoint` itself (which Stage 1 already
validated in isolation).

- [ ] **Step 4: Run existing TurnPaths tests (regression check for the wrapper)**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.multiIntersection.test.ts test/vehicles/TurnPaths.turnControlPoint.test.ts test/vehicles/TurnPaths.centerline.test.ts test/vehicles/TurnPaths.heading.test.ts`
Expected: PASS, unmodified — these all call the 2-arg `buildVehiclePath`, now a thin wrapper.

- [ ] **Step 5: Write and run the 3-hop test**

Create `sim-server/test/vehicles/TurnPaths.multiHopPath.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildMultiHopVehiclePath } from "../../src/vehicles/TurnPaths";

describe("buildMultiHopVehiclePath across two intersections", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");

  it("a 3-approach route (enter int_B, cross into int_C via the connector, exit) has 2 stop lines, in order", () => {
    const path = buildMultiHopVehiclePath(map, ["b_far_north", "c_from_b", "c_far_east"]);
    expect(path.stopLines).toHaveLength(2);
    expect(path.stopLines[0].approachId).toBe("b_far_north");
    expect(path.stopLines[1].approachId).toBe("c_from_b");
    expect(path.stopLines[0].distance).toBeLessThan(path.stopLines[1].distance);
    expect(path.stopLines[1].distance).toBeLessThan(path.totalLength);
  });

  it("ends near c_far_east's far point (1000, 250)", () => {
    const path = buildMultiHopVehiclePath(map, ["b_far_north", "c_from_b", "c_far_east"]);
    const end = path.pointAt(path.totalLength);
    expect(end.x).toBeCloseTo(1000, -1);
    expect(end.y).toBeCloseTo(250, -1);
  });

  it("approachIdAt reports the correct approach for known points along the route", () => {
    const path = buildMultiHopVehiclePath(map, ["b_far_north", "c_from_b", "c_far_east"]);
    expect(path.approachIdAt(10)).toBe("b_far_north");
    expect(path.approachIdAt(path.totalLength - 10)).toBe("c_far_east");
  });
});
```

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.multiHopPath.test.ts`
Expected: PASS. If the endpoint assertion fails, write a throwaway probe script
(`sim-server/_multihop_probe.mts`, delete once done) that prints `path.pointAt(d)` at several `d`
values across the route and compare against hand-computed fixture coordinates — the same
empirical-probe discipline as every prior geometry bug this session.

- [ ] **Step 6: Run the full suite**

Run: `cd sim-server && npx vitest run`
Expected: PASS, same count as Task 2 plus the 4 new tests from this task.

---

### Task 4: `SignalController` — per-intersection, `allowedApproachIds`-based, `forcePhase`

**Files:**
- Modify: `sim-server/src/signals/SignalController.ts`
- Test: `sim-server/test/signals/SignalController.test.ts` (new)

**Interfaces:**
- Consumes: `SignalPhaseDef.allowedApproachIds` (Task 1).
- Produces:
  ```ts
  class SignalController {
    constructor(
      phases: SignalPhaseDef[],
      approaches: ApproachDef[], // this intersection's own approaches — replaces APPROACH_DIRECTIONS
      client: AiSignalClient,
      detector: QueueDetector,
      intersectionId: string,
      getPedestrianCrossingState?: (crossingId: string) => { queueLength: number; waitS: number },
      crossingIdsByApproach: Record<string, string> = {}, // no more hardcoded default
      requestedController: "rule_based" | "rl" = "rule_based",
      getEvContext?: () => { evId: string; etaS: number; requiredPhaseId: string } | null
    )
    forcePhase(phaseId: string): void;
    clearForcedPhase(): void;
    // currentPhaseId, timeInPhaseMs, getApproachSignalStates(), step() unchanged in shape
  }
  ```

- [ ] **Step 1: Delete `APPROACH_DIRECTIONS`, take `approaches` in the constructor**

Remove the module-level `APPROACH_DIRECTIONS` constant and the `Direction` import. Add `approaches:
ApproachDef[]` as a new constructor parameter (insert right after `phases`, shifting every
positional caller — Task 7 updates the one real caller, `SimSession`).

- [ ] **Step 2: Rewrite `getApproachSignalStates` and the decision-step approach iteration**

```ts
getApproachSignalStates(): Map<string, SignalLightState> {
  const states = new Map<string, SignalLightState>();
  for (const approach of this.approaches) {
    const phase = this.phases.find((p) => p.allowedApproachIds!.includes(approach.id))!;
    states.set(approach.id, this.phaseMachine.lightStateFor(phase.id));
  }
  return states;
}
```
In `step()`, replace the `phaseCandidates`/`approachStates` construction's iteration over
`Object.entries(APPROACH_DIRECTIONS)` with iteration over `this.phases`/`this.approaches`
directly:
```ts
const phaseCandidates = this.phases.map((phase) => {
  let queueLength = 0;
  let waitS = 0;
  for (const approachId of phase.allowedApproachIds!) {
    const state = this.detector.getApproachState(approachId);
    queueLength += state.queueLength;
    waitS = Math.max(waitS, state.waitS);
  }
  return { phaseId: phase.id, queueLength, waitS };
});

const approachStates = this.approaches.map((a) => ({
  approachId: a.id,
  ...this.detector.getApproachState(a.id)
}));
```
Note `approachStates` no longer includes a `direction` field — Task 8 removes it from the schema
too; until Task 8 lands, leave the shared-contracts schema as-is (it currently requires `direction`
in `PhaseCandidate`... actually re-check: `direction` is required on `approachStates` items, not
`PhaseCandidate`. Since Task 8 hasn't dropped that requirement yet, this task's `approachStates`
construction would fail schema validation if validated strictly. `AiSignalClient.decide` doesn't
validate against the schema at runtime (it just POSTs JSON) — the Python side's pydantic model is
what would reject a missing required field. To keep this task independently testable without
depending on Task 8, temporarily keep sending a placeholder: `direction: "N"` (or any fixed dummy
value — cosmetic, since Task 1 already confirmed nothing on the Python side reads it). Task 8
removes the schema requirement and this placeholder together.

- [ ] **Step 3: Add `forcePhase`/`clearForcedPhase`**

Add a private field `private forcedPhaseId: string | null = null;` and:
```ts
forcePhase(phaseId: string): void {
  this.forcedPhaseId = phaseId;
}

clearForcedPhase(): void {
  this.forcedPhaseId = null;
}
```
At the top of the `if (this.sinceLastDecisionMs >= DECISION_INTERVAL_MS)` block in `step()`, before
calling `this.client.decide(...)`, add:
```ts
if (this.forcedPhaseId !== null) {
  this.sinceLastDecisionMs = 0;
  this.phaseMachine.requestPhase(this.forcedPhaseId);
  this.lastController = "forced";
  const changed = this.phaseMachine.currentPhaseId !== previousPhaseId;
  return { phaseId: this.phaseMachine.currentPhaseId, changed, controller: this.lastController };
}
```
(placed as an early return inside the decision-interval block, skipping the AI client call
entirely while a forced phase is active — matches spec §7.3: "a deterministic override... never a
hope that the adaptive algorithm reacts correctly on its own"). `controller: "forced"` is a new
value beyond the existing `"rule_based"|"rl"` union used elsewhere in this file — widen `private
lastController = "rule_based"` to `private lastController: string = "rule_based"` (already
untyped as a bare property, so this is just being explicit) and the `step()` return type's
`controller: string` (already `string`, not a union — confirmed by reading the current file).

- [ ] **Step 4: Write and run `SignalController.test.ts`**

Create `sim-server/test/signals/SignalController.test.ts` with a small synthetic 2-approach,
2-phase setup (mock `AiSignalClient`/`QueueDetector` the same way other tests in this codebase mock
dependencies — check `test/room/SimSession.test.ts`'s `vi.stubGlobal("fetch", ...)` pattern, or
construct a real `QueueDetector` against a tiny `PhysicsWorld`+map the way
`test/signals/FixedTimeSignal.test.ts` or existing `SignalController`-adjacent tests already do —
inspect `test/signals/` for the established mocking convention before writing this test). Cover:
- `getApproachSignalStates()` returns light states keyed by this intersection's own approach IDs
  (not any hardcoded compass set).
- `forcePhase("p2")` followed by stepping past `DECISION_INTERVAL_MS` causes `currentPhaseId` to
  transition toward `"p2"` regardless of what the (mocked) AI client would have returned, and the
  mocked client is never called while forced.
- `clearForcedPhase()` resumes calling the AI client on the next decision interval.

Run: `cd sim-server && npx vitest run test/signals/SignalController.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd sim-server && npx vitest run`
Expected: **compile errors** at this point are expected and OK — `SimSession.ts` still constructs
`SignalController` with the old (pre-`approaches`-param) argument list. Task 7 fixes that call
site. Confirm the *new* test passes and that the only failures are TypeScript errors localized to
`SimSession.ts`'s one `new SignalController(...)` call, not anything else.

---

### Task 5: `TrafficController` — terminal-only spawning, multi-hop destinations

**Files:**
- Modify: `sim-server/src/vehicles/TrafficController.ts`

**Interfaces:**
- Consumes: `isTerminalApproach` (Task 1), `buildMultiHopVehiclePath` + `RoadGraph` (Tasks 2-3).
- Produces: `TrafficController`'s public shape (`step`, `vehicles`, `claimableVehicle`,
  `vehicleMovements`) unchanged — only internal spawn/tracking logic changes.

- [ ] **Step 1: Replace `pickExitApproachId` with graph-based `pickDestinationApproachId`**

Delete `OPPOSITE` and `pickExitApproachId`. Add a `RoadGraph` field (built once in the
constructor via `buildRoadGraph(mapDef)`) and:
```ts
function pickDestinationApproachId(
  entryApproachId: string,
  mapDef: MapDefinition,
  terminals: string[],
  rng: () => number
): string {
  const entry = mapDef.approaches.find((a) => a.id === entryApproachId)!;
  const entryHeading = headingIntoIntersection(entry);
  const others = terminals.filter((id) => id !== entryApproachId);
  const straightCandidates = others.filter((id) => {
    const a = mapDef.approaches.find((x) => x.id === id)!;
    return isRoughlyOpposite(entryHeading, headingOutOfIntersection(a));
  });
  const pick = (pool: string[]) => pool[Math.floor(rng() * pool.length)];
  if (straightCandidates.length > 0 && rng() < 0.5) return pick(straightCandidates);
  return pick(others);
}
```
This is a reasonable generalization of the old 50%-straight bias without hand-coding directions;
for `grid_1x1_v1.json` (single intersection, 4 terminals) it produces the same qualitative mix the
existing test (`distinctExitsFromN.size > 1`) needs. Import `headingIntoIntersection`,
`headingOutOfIntersection`, `isRoughlyOpposite` from `TurnPaths.ts`.

In the constructor, compute `const terminals = mapDef.approaches.filter((a) =>
isTerminalApproach(mapDef, a)).map((a) => a.id);` once, store it, and pass it to
`pickDestinationApproachId` at each spawn. Also build `private readonly graph =
buildRoadGraph(mapDef);`.

**Also change the spawner itself**: `TrafficSpawner` should only be constructed over `terminals`,
not `mapDef.approaches.map((a) => a.id)` — only terminal approaches are valid entry points (a
connector approach's laneStart is another intersection, not a place for a new vehicle to
materialize). Update both the constructor and `setArrivalRate`.

- [ ] **Step 2: Build the multi-hop path at spawn time**

Replace:
```ts
const exitApproachId = pickExitApproachId(entryApproachId, this.mapDef, this.rng);
const path = buildVehiclePath(this.mapDef, entryApproachId, exitApproachId);
```
with:
```ts
const destinationApproachId = pickDestinationApproachId(entryApproachId, this.mapDef, this.terminals, this.rng);
const route = this.graph.shortestPath(`end_${entryApproachId}`, `end_${destinationApproachId}`);
const approachIds = route.edges.map((e) => e.approachId);
const path = buildMultiHopVehiclePath(this.mapDef, approachIds);
const exitApproachId = approachIds[approachIds.length - 1];
```
(`exitApproachId` is still tracked in the `Tracked` interface and returned by `vehicleMovements()`
— unchanged shape, just now derived from the route's last hop instead of a single random pick.)

- [ ] **Step 3: Generalize the stop-line and same-lane-leader logic**

Replace the single `entry.path.stopLineDistance` check with "the next stop line ahead of my
current distance":
```ts
const nextStop = entry.path.stopLines.find((s) => s.distance > entry.distanceTraveled) ?? null;
```
Every place that read `entry.path.stopLineDistance` and `entry.entryApproachId` for the
red/yellow-braking logic now uses `nextStop?.distance` and `nextStop?.approachId` instead — if
`nextStop` is `null` (past every stop line, on the final exit segment), skip the signal-braking
block entirely (there's nothing left to check).

For the "ahead" (same-physical-lane leader) filter, replace the `t.entryApproachId ===
entry.entryApproachId` / `t.exitApproachId === entry.exitApproachId` two-case comparison with a
single generalized rule using `approachIdAt`:
```ts
const myCurrentApproach = entry.path.approachIdAt(entry.distanceTraveled);
const ahead = [...this.tracked.values()]
  .filter((t) => t !== entry && t.distanceTraveled > entry.distanceTraveled && t.path.approachIdAt(t.distanceTraveled) === myCurrentApproach)
  .sort((a, b) => a.distanceTraveled - b.distanceTraveled)[0];
```
This is a direct generalization: "same physical lane right now" replaces the old two special-cased
comparisons, and produces identical results for `grid_1x1_v1.json`'s single-hop case (before the
stop line, both vehicles' `approachIdAt` is the shared entry approach; after, it diverges by exit
approach — exactly the old rule, just expressed generically).

- [ ] **Step 4: Run the existing TrafficController tests**

Run: `cd sim-server && npx vitest run test/vehicles/TrafficController.test.ts`
Expected: PASS unmodified. If the "spawns... not just straight-through" test flakes (depends on
`pickDestinationApproachId`'s randomness), re-run with the same seed a few times before concluding
it's a real bug — this test only requires `distinctExitsFromN.size > 1`, which the new
straight-biased-but-not-deterministic picker should satisfy easily across 200 ticks.

- [ ] **Step 5: Run the full suite**

Run: `cd sim-server && npx vitest run`
Expected: still failing to compile at `SimSession.ts`'s `SignalController` call site only (same
known gap as Task 4) — confirm no *new* failures elsewhere.

---

### Task 6: `EvRouter` — multi-hop spawn, per-intersection ETA, generalized `requiredPhaseId`

**Files:**
- Modify: `sim-server/src/ev/EvRouter.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces (all existing methods keep their exact signature and semantics for the single-hop case
  — `grid_1x1_v1.json`'s existing `EvRouter.test.ts` must keep passing unmodified):
  ```ts
  class EvRouter {
    spawn(originApproachId, destinationApproachId): { evId } | { error };
    step(dtMs): void;
    etaToIntersection(evId, intersectionId): number | null; // now checks ALL stop lines, not just one
    requiredPhaseId(evId): string | null; // now resolves the NEXT upcoming stop's phase generically
    hasPassedIntersection(evId): boolean; // true once every stop line is behind it
    activeVehicle(): VehicleBody | null;
    upcomingStops(evId): { intersectionId: string; approachId: string; etaS: number; phaseId: string | null }[]; // NEW
  }
  ```

- [ ] **Step 1: Delete `APPROACH_DIRECTIONS`, build the path via the road graph**

Remove the module-level `APPROACH_DIRECTIONS` and the `Direction` import. In `spawn()`, replace:
```ts
this.graph.shortestPath(`end_${originApproachId}`, `end_${destinationApproachId}`);
const path = buildVehiclePath(this.mapDef, originApproachId, destinationApproachId);
```
with:
```ts
const route = this.graph.shortestPath(`end_${originApproachId}`, `end_${destinationApproachId}`);
const approachIds = route.edges.map((e) => e.approachId);
const path = buildMultiHopVehiclePath(this.mapDef, approachIds);
```
Store `approachIds` on the `Active` record (needed by `phaseIdFor` below) instead of just
`originApproachId` (keep `originApproachId` too, it's still used elsewhere — check every read site
before deleting anything).

- [ ] **Step 2: Replace the single `passedIntersection` boolean with per-stop-line tracking**

Change `Active.passedIntersection: boolean` to nothing new is strictly required — `distanceTraveled`
plus `path.stopLines` already tells you which stops are behind (`s.distance <=
distanceTraveled`) vs. ahead (`s.distance > distanceTraveled`) at any moment; you can compute this
on demand in `etaToIntersection`/`requiredPhaseId`/`upcomingStops` rather than tracking a redundant
boolean per stop. Remove `passedIntersection` entirely and the `if
(!this.active.passedIntersection && ...)` block in `step()` — nothing else in this class needs it
once `hasPassedIntersection` is redefined (Step 4) to derive the same fact from `stopLines`.

- [ ] **Step 3: Add the phase-resolution helper and rewrite `requiredPhaseId`/`etaToIntersection`**

```ts
private phaseIdFor(intersectionId: string, approachId: string): string | null {
  const intersection = this.mapDef.intersections.find((i) => i.id === intersectionId);
  const phase = intersection?.phases.find((p) => p.allowedApproachIds!.includes(approachId));
  return phase?.id ?? null;
}

etaToIntersection(evId: string, intersectionId: string): number | null {
  if (!this.active || this.active.id !== evId) return null;
  const stop = this.active.path.stopLines.find((s) => {
    const approach = this.mapDef.approaches.find((a) => a.id === s.approachId)!;
    return approach.intersectionId === intersectionId;
  });
  if (!stop || stop.distance <= this.active.distanceTraveled) return null; // no such stop, or already passed it
  const remaining = stop.distance - this.active.distanceTraveled;
  const speed = Math.max(realSpeed(this.active.body.body), 0.1);
  return Math.max(remaining, 0) / speed;
}

requiredPhaseId(evId: string): string | null {
  if (!this.active || this.active.id !== evId) return null;
  const nextStop = this.active.path.stopLines.find((s) => s.distance > this.active.distanceTraveled);
  if (!nextStop) return null;
  const approach = this.mapDef.approaches.find((a) => a.id === nextStop.approachId)!;
  return this.phaseIdFor(approach.intersectionId, nextStop.approachId);
}

hasPassedIntersection(evId: string): boolean {
  if (!this.active || this.active.id !== evId) return true;
  return !this.active.path.stopLines.some((s) => s.distance > this.active.distanceTraveled);
}

upcomingStops(evId: string): { intersectionId: string; approachId: string; etaS: number; phaseId: string | null }[] {
  if (!this.active || this.active.id !== evId) return [];
  const speed = Math.max(realSpeed(this.active.body.body), 0.1);
  return this.active.path.stopLines
    .filter((s) => s.distance > this.active.distanceTraveled)
    .map((s) => {
      const approach = this.mapDef.approaches.find((a) => a.id === s.approachId)!;
      return {
        intersectionId: approach.intersectionId,
        approachId: s.approachId,
        etaS: (s.distance - this.active!.distanceTraveled) / speed,
        phaseId: this.phaseIdFor(approach.intersectionId, s.approachId)
      };
    });
}
```
Delete the old `step()` block that set `this.active.passedIntersection = true` (Step 2 already
removed the field it wrote to).

- [ ] **Step 4: Run the existing EvRouter tests**

Run: `cd sim-server && npx vitest run test/ev/EvRouter.test.ts`
Expected: PASS unmodified — verify specifically that `requiredPhaseId((result as
any).evId)` still returns `"NS_through"` for both the straight-through and turning spawn cases (it
should, since `grid_1x1_v1.json`'s single stop line's `approachId` is always the entry approach
`app_N` regardless of which exit was chosen, and Task 1's normalization guarantees `NS_through`'s
`allowedApproachIds` includes `app_N`).

- [ ] **Step 5: Write and run a green-wave-data test on the fixture**

Add a test to a new `sim-server/test/ev/EvRouter.multiHop.test.ts`:
```ts
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
```

Run: `cd sim-server && npx vitest run test/ev/EvRouter.multiHop.test.ts`
Expected: PASS. If `initial.map(...)` doesn't equal `["int_B", "int_C"]`, dump
`router.spawn(...)`'s resulting path's `stopLines` directly (temporary `console.log` or a throwaway
probe script) and cross-check against Task 2/3's route — this exercises the full Task 2→3→6 chain
end to end for the first time, so a mismatch here could originate in any of those three tasks.

- [ ] **Step 6: Run the full suite**

Run: `cd sim-server && npx vitest run`
Expected: same known `SimSession.ts` compile gap as before (Task 7 fixes it), no other failures.

---

### Task 7: `SimSession` — per-intersection controllers, EV green-wave loop

**Files:**
- Modify: `sim-server/src/room/SimSession.ts`
- Test: `sim-server/test/room/SimSession.test.ts` (existing, must keep passing unmodified)

**Interfaces:**
- Consumes: Tasks 4 and 6.
- Produces: `SimSession`'s public API (`join`, `leave`, `setControllerMode`, `startScenario`,
  `spawnEmergencyVehicle`, `applyInput`, `step`) — unchanged signatures.

- [ ] **Step 1: Build one `SignalController` per intersection**

Replace the single `this.signalController = new SignalController(...)` with:
```ts
private readonly signalControllers = new Map<string, SignalController>();
private readonly forcedIntersections = new Set<string>();
```
and, in the constructor, after `this.evRouter = new EvRouter(...)`:
```ts
for (const intersection of map.intersections) {
  const ownApproaches = map.approaches.filter((a) => a.intersectionId === intersection.id);
  const crossingIdsByApproach: Record<string, string> = {};
  for (const edge of map.pedestrianEdges) {
    if (edge.kind === "crosswalk" && edge.approachId && edge.crossingId && ownApproaches.some((a) => a.id === edge.approachId)) {
      crossingIdsByApproach[edge.approachId] = edge.crossingId;
    }
  }
  this.signalControllers.set(
    intersection.id,
    new SignalController(
      intersection.phases,
      ownApproaches,
      new AiSignalClient(aiServiceUrl),
      this.detector,
      intersection.id,
      (crossingId) => this.pedestrians.getCrossingState(crossingId),
      crossingIdsByApproach,
      "rule_based",
      () => {
        const vehicle = this.evRouter.activeVehicle();
        if (!vehicle) return null;
        const etaS = this.evRouter.etaToIntersection(vehicle.id, intersection.id);
        if (etaS === null) return null;
        const requiredPhaseId = this.evRouter.upcomingStops(vehicle.id).find((s) => s.intersectionId === intersection.id)?.phaseId;
        if (!requiredPhaseId) return null;
        return { evId: vehicle.id, etaS, requiredPhaseId };
      }
    )
  );
}
```
Delete the `CROSSING_IDS`/`APPROACH_IDS` module constants (KPI snapshot code, Step 3 below,
generalizes past needing them).

- [ ] **Step 2: Generalize `step()`'s signal-stepping and state-merging**

Replace:
```ts
const { phaseId, controller } = await this.signalController.step(TICK_MS);
this.lastControllerMode = controller === "rl" ? "rl" : "rule_based";
const approachSignalStates = this.signalController.getApproachSignalStates();
```
with:
```ts
const approachSignalStates = new Map<string, "green" | "yellow" | "red">();
const phaseByIntersection = new Map<string, string>();
for (const [intersectionId, controller] of this.signalControllers) {
  const { phaseId, controller: usedController } = await controller.step(TICK_MS);
  phaseByIntersection.set(intersectionId, phaseId);
  this.lastControllerMode = usedController === "rl" ? "rl" : "rule_based";
  for (const [approachId, state] of controller.getApproachSignalStates()) {
    approachSignalStates.set(approachId, state);
  }
}
```
(`this.lastControllerMode` reflects whichever controller stepped *last* in iteration order — fine
for the existing single-intersection tests, and a reasonable approximation for the KPI HUD's
"currentMode" display until a future stage cares about per-intersection mode reporting.)

- [ ] **Step 3: EV green-wave preemption loop, replacing every `"int_1"` literal**

Replace the entire `evVehicle`/`etaS`/`requiredPhaseId`/`preemptKey` block (the code between
`this.evRouter.step(TICK_MS);` and `const roomEvents = ...`) with:
```ts
const evVehicle = this.evRouter.activeVehicle();
if (evVehicle) {
  const upcoming = this.evRouter.upcomingStops(evVehicle.id);
  const withinThreshold = new Set(upcoming.filter((s) => s.etaS < EV_PREEMPT_THRESHOLD_S).map((s) => s.intersectionId));

  for (const stop of upcoming) {
    if (!withinThreshold.has(stop.intersectionId) || stop.phaseId === null) continue;
    if (!this.forcedIntersections.has(stop.intersectionId)) {
      this.forcedIntersections.add(stop.intersectionId);
      this.store.writeEvent(this.sessionId, {
        t: this.tick * (TICK_MS / 1000),
        type: "ev_preempt",
        intersection: stop.intersectionId,
        etaS: stop.etaS
      });
    }
    this.signalControllers.get(stop.intersectionId)!.forcePhase(stop.phaseId);
  }
  for (const intersectionId of [...this.forcedIntersections]) {
    if (!withinThreshold.has(intersectionId)) {
      this.forcedIntersections.delete(intersectionId);
      this.signalControllers.get(intersectionId)!.clearForcedPhase();
    }
  }
} else if (this.forcedIntersections.size > 0) {
  for (const intersectionId of this.forcedIntersections) this.signalControllers.get(intersectionId)!.clearForcedPhase();
  this.forcedIntersections.clear();
}
```
Add `const EV_PREEMPT_THRESHOLD_S = 8;` near the top of the file alongside the other module
constants (matches the spec's suggested starting value; Task 9's capacity work, Stage 3, is where
this gets empirically validated against real intersection spacing — not this task's job to tune
against a map that doesn't exist yet).

Delete the now-unused `loggedPreempts` field (replaced by `forcedIntersections`, which serves the
same "log once per intersection per active EV" purpose plus the actual preemption logic).

Replace the hardcoded `route: [originApproachId, "int_1", destinationApproachId]` in
`spawnEmergencyVehicle` with just `route: [originApproachId, destinationApproachId]` (the
intermediate intersection list isn't something `SimSession` computes today and isn't asserted by
any test — a full route log is a reasonable follow-up, not required now).

Replace `etaToIntersection(vehicle.id, "int_1")` (used nowhere else after this task — confirm by
grep) — already handled by the rewrite above.

- [ ] **Step 4: Fix the KPI snapshot's hardcoded approach/crossing ID lists**

Replace:
```ts
const approachStates = APPROACH_IDS.map((id) => this.detector.getApproachState(id));
...
const crossingStates = CROSSING_IDS.map((id) => this.pedestrians.getCrossingState(id));
```
with:
```ts
const approachStates = map.approaches.map((a) => this.detector.getApproachState(a.id));
...
const crossingIds = new Set(map.pedestrianEdges.filter((e) => e.kind === "crosswalk" && e.crossingId).map((e) => e.crossingId!));
const crossingStates = [...crossingIds].map((id) => this.pedestrians.getCrossingState(id));
```
`map` here refers to the `loadMap(mapPath)` result already held in the constructor — store it as
`private readonly mapDef: MapDefinition` (currently only `this.mapId = map.id` is kept; add the
full object) so `step()` can reach it.

- [ ] **Step 5: Fix the `signals[]` snapshot array**

Replace the single-element `signals: [{intersectionId: "int_1", ...}]` with:
```ts
signals: [...this.signalControllers.entries()].map(([intersectionId, controller]) => {
  const states = controller.getApproachSignalStates();
  const firstApproachId = [...states.keys()][0];
  return {
    intersectionId,
    phase: phaseByIntersection.get(intersectionId)!,
    msRemainingMin: Math.max(0, 4000 - controller.timeInPhaseMs),
    light: firstApproachId ? states.get(firstApproachId)! : "red"
  };
})
```

- [ ] **Step 6: Run the existing SimSession tests**

Run: `cd sim-server && npx vitest run test/room/SimSession.test.ts`
Expected: PASS unmodified — `grid_1x1_v1.json` has exactly one intersection, so
`this.signalControllers` has exactly one entry and every test's assumptions (one fetch-call series
for the "forwards controller mode" test, EV spawn/snapshot behavior) hold identically.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd sim-server && npx vitest run && npx tsc --noEmit`
Expected: full PASS, no type errors — this is the point where Tasks 4-7's interlocking signature
changes all finally compile together.

---

### Task 8: End-to-end green-wave proof on the fixture

**Files:**
- Test: `sim-server/test/integration/multiHopGreenWave.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7. No new production code.

- [ ] **Step 1: Write the test**

Create `sim-server/test/integration/multiHopGreenWave.test.ts`. Construct a `SimSession` against
`fixture_curved_3int.json` (mock `fetch` the same way `SimSession.test.ts` does, returning
whatever `phaseId`/`controller` — irrelevant once the EV comes within the preempt threshold, since
`forcePhase` bypasses the AI client entirely), spawn an EV routed from `b_far_north` to
`c_far_east` (crossing both `int_B` and `int_C`), step for long enough to cross the whole fixture,
and assert the session's event log contains `ev_preempt` events for **both** `int_B` and `int_C` —
this is the sim-server-level proof of spec §7.3's green wave (the Playwright e2e version of this
assertion, against the real city map, is Stage 4's job per the spec's rollout order).

- [ ] **Step 2: Run it**

Run: `cd sim-server && npx vitest run test/integration/multiHopGreenWave.test.ts`
Expected: PASS. If only one intersection ever gets an `ev_preempt` event, check
`EV_PREEMPT_THRESHOLD_S` against the fixture's actual hop lengths and the EV's real cruise speed
(22 u/s) — 8s at 22 u/s is ~176 units; if `int_C`'s stop line is closer than that to `int_B`'s once
the EV is already past `int_B`, both could preempt near-simultaneously (still a pass, just
worth understanding) or if the fixture's `int_B`-to-`int_C` leg is much longer than 176 units, the
second preempt event might arrive very late in the run — increase the tick budget if needed rather
than lowering the threshold, since the threshold itself is a deliberately-approximate value the
spec defers to real tuning against the finished city map (Stage 3).

- [ ] **Step 3: Run the complete suite one final time**

Run: `cd sim-server && npx vitest run && npx tsc --noEmit`
Expected: full green, no type errors. This closes out the TypeScript side of Stage 2.

---

### Task 9: Coordinated rule-based fallback (Python) — `neighborIntersections`

**Files:**
- Modify: `shared-contracts/schemas/signal-decision.schema.json`
- Modify: `ai-service/app/rule_based.py`
- Modify: `ai-service/app/routes.py`
- Modify: `sim-server/src/signals/SignalController.ts` (drop the Task 4 placeholder `direction`)
- Modify: `sim-server/src/room/SimSession.ts` (compute and pass `neighborIntersections`)
- Test: `ai-service/tests/test_rule_based.py`

**Interfaces:**
- Produces: `SignalDecisionRequest.neighborIntersections?:
  {intersectionId: string, currentPhaseId: string, timeInPhaseMs: number, totalPressure: number}[]`;
  `decide_phase` biases toward switching when a neighbor upstream just went green for a phase
  feeding this intersection.

- [ ] **Step 1: Update the schema — drop `direction`, add `neighborIntersections`**

In `signal-decision.schema.json`'s `SignalDecisionRequest.properties.approachStates.items`, remove
`"direction"` from both `required` and `properties` (Task 1 already confirmed nothing on the
Python side reads it). Add a sibling property:
```json
"neighborIntersections": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["intersectionId", "currentPhaseId", "timeInPhaseMs", "totalPressure"],
    "properties": {
      "intersectionId": { "type": "string" },
      "currentPhaseId": { "type": "string" },
      "timeInPhaseMs": { "type": "number", "minimum": 0 },
      "totalPressure": { "type": "number", "minimum": 0 }
    }
  }
}
```

Run: `cd shared-contracts && node scripts/generate.mjs`
Expected: regenerates `generated/ts/signal-decision.schema.d.ts`,
`generated/py/signal_decision_schema.py`, and `ai-service/app/contracts/signal_decision_schema.py`
with the new field and without `direction`. Run it twice in a row and diff to confirm the
`--disable-timestamp` fix from earlier this session still makes this idempotent.

- [ ] **Step 2: Remove the Task 4 `direction` placeholder in `SignalController.ts`**

In the `approachStates` construction from Task 4 Step 2, drop the placeholder `direction: "N"`
field entirely now that the schema no longer requires it:
```ts
const approachStates = this.approaches.map((a) => ({
  approachId: a.id,
  ...this.detector.getApproachState(a.id)
}));
```

- [ ] **Step 3: Extend `decide_phase` with a simple, explainable coordination rule**

```python
from app.contracts.signal_decision_schema import SignalDecisionRequest

MIN_ADVANTAGE_RATIO = 1.5
NEIGHBOR_BOOST = 0.5  # added to the challenger's pressure when a neighbor just fed it fresh flow
NEIGHBOR_FRESH_MS = 3000  # a neighbor phase is "just switched" within this long of its own start


def decide_phase(req: SignalDecisionRequest) -> str:
    current = next(c for c in req.phaseCandidates if c.phaseId == req.currentPhaseId)
    best = max(req.phaseCandidates, key=lambda c: c.queueLength + c.waitS)

    current_pressure = current.queueLength + current.waitS
    best_pressure = best.queueLength + best.waitS

    # Basic green-wave heuristic: if any neighboring intersection just turned green (within
    # NEIGHBOR_FRESH_MS of its own phase start), that flow is about to arrive here — nudge this
    # intersection toward being ready to receive it by inflating whichever candidate phase isn't
    # the current one. This is deliberately simple (no lane-level flow modeling, no knowledge of
    # *which* approach the neighbor's flow feeds into) — a hand-written bias, not a learned policy;
    # the coordinated RL policy in a later stage supersedes this with real inter-intersection
    # structure.
    neighbors = req.neighborIntersections or []
    neighbor_just_switched = any(n.timeInPhaseMs < NEIGHBOR_FRESH_MS for n in neighbors)
    if neighbor_just_switched and best.phaseId != current.phaseId:
        best_pressure += NEIGHBOR_BOOST

    if best.phaseId == current.phaseId:
        return current.phaseId
    if current_pressure == 0 or best_pressure > current_pressure * MIN_ADVANTAGE_RATIO:
        return best.phaseId
    return current.phaseId
```

- [ ] **Step 4: Extend `test_rule_based.py`**

Add a test constructing a `SignalDecisionRequest` where, without `neighborIntersections`, the
existing `MIN_ADVANTAGE_RATIO` threshold would keep the current phase (best pressure only
marginally higher than current), but with a `neighborIntersections` entry showing
`timeInPhaseMs < NEIGHBOR_FRESH_MS`, `decide_phase` switches instead. Also add a test confirming
`neighborIntersections=None`/absent behaves identically to today (regression check for every
existing test in this file).

Run: `cd ai-service && .venv/bin/pytest tests/test_rule_based.py -v` (check the actual venv/pytest
invocation convention this repo uses — look at how CI or another skill in this session already
runs Python tests here rather than guessing the exact command).
Expected: PASS, including all pre-existing cases in this file.

- [ ] **Step 5: Wire `neighborIntersections` from `SimSession`**

In `SimSession`'s per-intersection `SignalController` construction (Task 7 Step 1), this task adds
a `getNeighborIntersections: () => NeighborIntersection[]` — but the current `SignalController`
constructor doesn't have a slot for this. Add one more optional constructor parameter to
`SignalController` (after `getEvContext`): `getNeighborIntersections?: () => {intersectionId:
string; currentPhaseId: string; timeInPhaseMs: number; totalPressure: number}[]`, and include
`neighborIntersections: this.getNeighborIntersections ? this.getNeighborIntersections() : []` in
the request object built inside `step()`.

In `SimSession`, compute each intersection's immediate neighbors once (via the same
`buildRoadGraph`-style adjacency Task 2 already introduced — a light usage, not a new dependency:
`this.roadGraph.adjacency` isn't public today; add a `neighborsOf(intersectionId): string[]` method
to `RoadGraph` that returns the directly-connected intersection IDs, reusing the existing
`adjacency` map) and pass a closure per intersection:
```ts
() => {
  const neighborIds = this.roadGraph.neighborsOf(intersection.id);
  return neighborIds
    .map((id) => this.signalControllers.get(id))
    .filter((c): c is SignalController => c !== undefined)
    .map((c) => ({
      intersectionId: c.intersectionId, // add a public getter for this if not already exposed
      currentPhaseId: c.currentPhaseId,
      timeInPhaseMs: c.timeInPhaseMs,
      totalPressure: [...c.getApproachSignalStates().keys()].reduce((sum, id) => sum + this.detector.getApproachState(id).queueLength + this.detector.getApproachState(id).waitS, 0)
    }));
}
```
(`SignalController` needs `this.roadGraph` built once as a `SimSession` field:
`private readonly roadGraph = buildRoadGraph(map);` — `grid_1x1_v1.json` has zero neighbors for
its one intersection, so this closure returns `[]` there, exactly matching pre-Stage-2 behavior.)

- [ ] **Step 6: Run everything one final time**

Run: `cd sim-server && npx vitest run && npx tsc --noEmit`
Run: `cd ai-service && .venv/bin/pytest -v` (full Python suite, not just the one file — confirm no
regressions from the schema change, e.g. `test_signal_decision_route.py` and `test_observation.py`
if either constructs a full request payload that previously included `direction`).

Expected: everything green. This closes out Stage 2.

---

## Definition of Done

- [ ] `grid_1x1_v1.json` and all its pre-existing tests pass completely unmodified.
- [ ] `fixture_curved_3int.json`'s phases use `allowedApproachIds` directly; a vehicle can be
  routed and driven across all 3 of its intersections via `buildMultiHopVehiclePath`.
- [ ] Each of the fixture's 3 intersections has its own independently-stepping `SignalController`.
- [ ] An EV spawned across 2+ intersections in the fixture triggers `ev_preempt` events at each
  distinct intersection along its route, in order, as it approaches.
- [ ] The Python rule-based fallback reads a `neighborIntersections` field and measurably changes
  its decision in at least one constructed test case where a neighbor just switched.
- [ ] `Direction`/`allowedDirections` still parse from `grid_1x1_v1.json`'s raw JSON (unedited) but
  no runtime decision/routing/geometry logic reads them anymore — `allowedApproachIds` and
  computed headings (`headingIntoIntersection`/`headingOutOfIntersection`, Stage 1) are the only
  things routing/signal code consults from this point forward.
- [ ] `npx tsc --noEmit` (sim-server) and the full Python test suite (ai-service) are both clean.
