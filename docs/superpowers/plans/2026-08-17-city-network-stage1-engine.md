# City Network Stage 1 (Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the road/intersection geometry engine (heading angles instead of compass
directions, curved roads via waypoints, angle-based turn-curve geometry, curved wall-chain
physics) so a multi-intersection map with non-90-degree turns and curved connector roads can be
physically simulated correctly — validated against a small 3-intersection test fixture, not yet
the full city.

**Architecture:** Every new capability is additive and optional at the data-model level
(`ApproachDef.waypoints` is optional; absent means today's exact straight-line behavior). Turn
geometry and wall-building generalize from hardcoded compass-direction lookups to real vector
geometry (computed heading angles, ray-intersection for turn control points), reusing the
existing `composePath`/`bezierSegment` segment-composition machinery rather than replacing it.

**Tech Stack:** TypeScript, Matter.js (physics), Vitest (tests). No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-17-city-traffic-network-design.md`](../specs/2026-08-17-city-traffic-network-design.md)
sections 5 (Data model changes) and 6 (Physics changes). Signal-phase generalization
(`allowedDirections` → `allowedApproachIds`) and per-intersection `SignalController` instantiation
are **explicitly deferred to Stage 2** ("Routing + signals") — this plan does not touch
`SignalController.ts` or `SignalPhaseDef` at all, since Stage 1's own validation (a vehicle
correctly driving through curved roads and non-90-degree turns) doesn't require live adaptive
signal decision-making; test fixtures drive signal state with a plain hardcoded map, the same
technique already used throughout this session's probe scripts.

## Global Constraints

- `maps/grid_1x1_v1.json` and every one of its ~100 dependent tests must keep passing **completely
  unmodified** — every new code path is additive (gated on `approach.waypoints` being present),
  never a replacement of the existing straight-line/compass behavior.
- No new npm dependencies.
- Never run `git commit` or `git add` — the user handles all commits themselves. Every task ends
  at "run tests, confirm passing," not a commit step.
- Match existing code style: no comments except where a genuinely non-obvious constraint needs
  explaining (see the tone of existing comments in `TurnPaths.ts`/`PhysicsWorld.ts` — terse,
  explains *why*, not *what*).

---

### Task 1: Data model — optional curved-road waypoints + a small multi-intersection test fixture

**Files:**
- Modify: `sim-server/src/maps/MapDefinition.ts`
- Create: `maps/fixture_curved_3int.json`
- Test: `sim-server/test/maps/loadMap.fixture.test.ts`

**Interfaces:**
- Produces: `ApproachDef.waypoints?: { x: number; y: number }[]` — when present (length ≥ 3),
  defines the approach's centerline as a curve through these points instead of a straight line
  from `laneStartX/Y` to `laneEndX/Y`. `laneStartX/Y`/`laneEndX/Y` remain required and must equal
  `waypoints[0]`/`waypoints[waypoints.length - 1]` when waypoints are present (validated in Task 1,
  relied on by Task 3's centerline builder).

- [ ] **Step 1: Add the optional field to `ApproachDef`**

Modify `sim-server/src/maps/MapDefinition.ts`:
```ts
export interface ApproachDef {
  id: string;
  intersectionId: string;
  direction: Direction;
  laneStartX: number;
  laneStartY: number;
  laneEndX: number;
  laneEndY: number;
  width: number;
  // Optional: when present (length >= 3), the approach's centerline is a smooth curve through
  // these points (Catmull-Rom-derived, see TurnPaths.buildApproachCenterline) instead of a
  // straight line from laneStartX/Y to laneEndX/Y. Absent (the default, and always true for
  // grid_1x1_v1.json) means byte-identical straight-line behavior to before this field existed.
  // waypoints[0] and waypoints[waypoints.length - 1] must equal (laneStartX,laneStartY) and
  // (laneEndX,laneEndY) respectively when present.
  waypoints?: { x: number; y: number }[];
}
```

- [ ] **Step 2: Create the 3-intersection test fixture map**

Create `maps/fixture_curved_3int.json`. Three intersections: `int_A` at the origin (a T-junction,
2 approaches plus a connector to B), `int_B` at (400, 0) (a T-junction, connector to A, a curved
connector to C, and one spawn/despawn approach), `int_C` at (700, 250) (a dead-simple 2-approach
"end of the line" node — one connector back to B, one spawn/despawn approach) — `int_B`'s two
connectors (to A, straight west; to C, curved and heading off at a shallow angle) meet at a
non-90-degree angle, and the B-to-C connector is genuinely curved (3 waypoints, not a straight
line), exercising both required new cases in one small fixture. Pedestrian arrays are empty —
Stage 1 doesn't exercise pedestrian routing at all (that's proven generic already; see spec §7.2).

```json
{
  "id": "fixture_curved_3int",
  "intersections": [
    { "id": "int_A", "x": 0, "y": 0, "phases": [{ "id": "p1", "allowedDirections": ["N", "S"], "durationMs": 8000 }, { "id": "p2", "allowedDirections": ["E", "W"], "durationMs": 8000 }] },
    { "id": "int_B", "x": 400, "y": 0, "phases": [{ "id": "p1", "allowedDirections": ["N", "S"], "durationMs": 8000 }, { "id": "p2", "allowedDirections": ["E", "W"], "durationMs": 8000 }] },
    { "id": "int_C", "x": 700, "y": 250, "phases": [{ "id": "p1", "allowedDirections": ["N", "S"], "durationMs": 8000 }, { "id": "p2", "allowedDirections": ["E", "W"], "durationMs": 8000 }] }
  ],
  "approaches": [
    { "id": "a_far_west", "intersectionId": "int_A", "direction": "W", "laneStartX": -300, "laneStartY": 0, "laneEndX": 0, "laneEndY": 0, "width": 40 },
    { "id": "a_far_south", "intersectionId": "int_A", "direction": "S", "laneStartX": 0, "laneStartY": 300, "laneEndX": 0, "laneEndY": 0, "width": 40 },
    { "id": "a_from_b", "intersectionId": "int_A", "direction": "E", "laneStartX": 400, "laneStartY": 0, "laneEndX": 0, "laneEndY": 0, "width": 40 },
    { "id": "b_from_a", "intersectionId": "int_B", "direction": "W", "laneStartX": 0, "laneStartY": 0, "laneEndX": 400, "laneEndY": 0, "width": 40 },
    { "id": "b_far_north", "intersectionId": "int_B", "direction": "N", "laneStartX": 400, "laneStartY": -300, "laneEndX": 400, "laneEndY": 0, "width": 40 },
    {
      "id": "b_from_c", "intersectionId": "int_B", "direction": "E",
      "laneStartX": 700, "laneStartY": 250, "laneEndX": 400, "laneEndY": 0, "width": 40,
      "waypoints": [{ "x": 700, "y": 250 }, { "x": 550, "y": 40 }, { "x": 400, "y": 0 }]
    },
    {
      "id": "c_from_b", "intersectionId": "int_C", "direction": "W",
      "laneStartX": 400, "laneStartY": 0, "laneEndX": 700, "laneEndY": 250, "width": 40,
      "waypoints": [{ "x": 400, "y": 0 }, { "x": 550, "y": 40 }, { "x": 700, "y": 250 }]
    },
    { "id": "c_far_east", "intersectionId": "int_C", "direction": "E", "laneStartX": 1000, "laneStartY": 250, "laneEndX": 700, "laneEndY": 250, "width": 40 }
  ],
  "pedestrianNodes": [],
  "pedestrianEdges": []
}
```

- [ ] **Step 3: Write the failing test**

Create `sim-server/test/maps/loadMap.fixture.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";

describe("loadMap with curved-road fixture", () => {
  it("loads fixture_curved_3int.json with 3 intersections and a waypoints-bearing approach", () => {
    const map = loadMap("../../maps/fixture_curved_3int.json");
    expect(map.intersections).toHaveLength(3);
    const curved = map.approaches.find((a) => a.id === "b_from_c");
    expect(curved?.waypoints).toHaveLength(3);
  });

  it("grid_1x1_v1.json still loads with no approach ever having waypoints", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    expect(map.approaches.every((a) => a.waypoints === undefined)).toBe(true);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd sim-server && npx vitest run test/maps/loadMap.fixture.test.ts`
Expected: FAIL — `maps/fixture_curved_3int.json` doesn't exist yet if Step 2 wasn't done first (do
Step 2 before this — the ordering here is: schema field, then fixture file, then test; this step
is really "confirm you didn't typo the file path," not a true red-first TDD step, since the fixture
JSON is data, not behavior).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd sim-server && npx vitest run test/maps/loadMap.fixture.test.ts`
Expected: PASS (2 tests).

---

### Task 2: Computed heading angle for any approach (straight or curved)

**Files:**
- Modify: `sim-server/src/vehicles/TurnPaths.ts`
- Test: `sim-server/test/vehicles/TurnPaths.heading.test.ts`

**Interfaces:**
- Consumes: `ApproachDef` (Task 1's `waypoints?` field).
- Produces: `headingIntoIntersection(approach: ApproachDef): number` and
  `headingOutOfIntersection(approach: ApproachDef): number` — both real angles in radians (same
  convention as `VehicleBody.angle`: 0 = facing +x), computed from geometry, never from the legacy
  `approach.direction` compass field. Used by Task 4's turn-control-point logic and Task 5's
  `buildVehiclePath`.

- [ ] **Step 1: Write the failing tests**

Create `sim-server/test/vehicles/TurnPaths.heading.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { headingIntoIntersection, headingOutOfIntersection } from "../../src/vehicles/TurnPaths";

describe("heading computation", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");

  it("a straight (non-waypoint) approach's heading matches its laneStart->laneEnd direction", () => {
    const approach = map.approaches.find((a) => a.id === "a_far_west")!;
    // laneStart=(-300,0) -> laneEnd=(0,0): heading 0 (facing +x)
    expect(headingIntoIntersection(approach)).toBeCloseTo(0, 5);
  });

  it("a curved approach's heading-into-intersection matches the tangent of its final waypoint segment, not the straight laneStart->laneEnd line", () => {
    const approach = map.approaches.find((a) => a.id === "b_from_c")!;
    // waypoints: (700,250) -> (550,40) -> (400,0) (this approach belongs to int_B and represents
    // arriving there from C's direction, so its waypoints run C->B). Final segment tangent
    // (550,40)->(400,0) != the overall laneStart(700,250)->laneEnd(400,0) straight-line angle,
    // because the curve bends more sharply in its final stretch.
    const straightLineHeading = Math.atan2(0 - 250, 400 - 700);
    const tangentHeading = headingIntoIntersection(approach);
    expect(Math.abs(tangentHeading - straightLineHeading)).toBeGreaterThan(0.01);
  });

  it("headingOutOfIntersection points away from the intersection for an approach leaving it", () => {
    const approach = map.approaches.find((a) => a.id === "b_from_a")!;
    // b_from_a: laneStart=(0,0) [at int_A's position] -> laneEnd=(400,0) [at int_B]. This approach
    // is int_B's *entry* from A, so "out of intersection" here means away from int_B, i.e. back
    // toward A: heading pi (facing -x).
    expect(Math.abs(headingOutOfIntersection(approach))).toBeCloseTo(Math.PI, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.heading.test.ts`
Expected: FAIL with "headingIntoIntersection is not a function" (or similar import error).

- [ ] **Step 3: Implement the heading functions**

Modify `sim-server/src/vehicles/TurnPaths.ts` — add near the top, after the `Point`/`Segment`
interfaces:
```ts
// Real geometric heading, computed from coordinates — never from the legacy compass `direction`
// field, which can't represent an organic city's arbitrary-angle approaches. "Into intersection"
// is the tangent direction a vehicle travels arriving at this approach's laneEnd (its
// intersection-side point); "out of intersection" is the reverse (the direction a vehicle departs
// this approach's laneEnd heading back out toward laneStart) — used when this same approach
// object is being traversed as an *exit* from a different intersection's perspective (see
// buildVehiclePath in Task 5).
export function headingIntoIntersection(approach: ApproachDef): number {
  if (approach.waypoints && approach.waypoints.length >= 3) {
    const points = approach.waypoints;
    const last = points[points.length - 1];
    const secondToLast = points[points.length - 2];
    return Math.atan2(last.y - secondToLast.y, last.x - secondToLast.x);
  }
  return Math.atan2(approach.laneEndY - approach.laneStartY, approach.laneEndX - approach.laneStartX);
}

export function headingOutOfIntersection(approach: ApproachDef): number {
  const into = headingIntoIntersection(approach);
  return Math.atan2(Math.sin(into + Math.PI), Math.cos(into + Math.PI));
}
```

Add `ApproachDef` to the existing `import type { MapDefinition, Direction } from "../maps/MapDefinition.js";` line (becomes `import type { MapDefinition, Direction, ApproachDef } from "../maps/MapDefinition.js";`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.heading.test.ts`
Expected: PASS (3 tests).

---

### Task 3: Curved centerline segment builder (waypoints → smooth path)

**Files:**
- Modify: `sim-server/src/vehicles/TurnPaths.ts`
- Test: `sim-server/test/vehicles/TurnPaths.centerline.test.ts`

**Interfaces:**
- Consumes: `ApproachDef` (Task 1), the existing `straightSegment`/`bezierSegment` internal
  functions (unchanged), `Segment` interface (unchanged).
- Produces: `buildApproachCenterline(approach: ApproachDef): Segment` — the approach's *full*
  (un-shortened) centerline from `laneStartX/Y` to `laneEndX/Y`, straight if no waypoints, a smooth
  multi-segment curve through the waypoints otherwise. Consumed by Task 5 (`buildVehiclePath`) and
  Task 6 (curved wall-chains) — both need the full-length centerline and slice it themselves via
  `pointAtDistance`/`length`, matching how `composePath` already works internally.

- [ ] **Step 1: Write the failing tests**

Create `sim-server/test/vehicles/TurnPaths.centerline.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildApproachCenterline } from "../../src/vehicles/TurnPaths";

describe("buildApproachCenterline", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");

  it("a straight approach's centerline has length equal to the direct laneStart-laneEnd distance", () => {
    const approach = map.approaches.find((a) => a.id === "a_far_west")!;
    const centerline = buildApproachCenterline(approach);
    expect(centerline.length).toBeCloseTo(300, 5);
    const start = centerline.pointAtDistance(0);
    expect(start.x).toBeCloseTo(-300, 5);
    expect(start.y).toBeCloseTo(0, 5);
  });

  it("a curved approach's centerline is longer than the direct laneStart-laneEnd distance (it bends, so it isn't the shortest path)", () => {
    const approach = map.approaches.find((a) => a.id === "b_from_c")!;
    const centerline = buildApproachCenterline(approach);
    const directDistance = Math.hypot(400 - 700, 0 - 250);
    expect(centerline.length).toBeGreaterThan(directDistance);
  });

  it("a curved approach's centerline starts and ends at its laneStart/laneEnd exactly", () => {
    const approach = map.approaches.find((a) => a.id === "b_from_c")!;
    const centerline = buildApproachCenterline(approach);
    const start = centerline.pointAtDistance(0);
    const end = centerline.pointAtDistance(centerline.length);
    expect(start.x).toBeCloseTo(700, 1);
    expect(start.y).toBeCloseTo(250, 1);
    expect(end.x).toBeCloseTo(400, 1);
    expect(end.y).toBeCloseTo(0, 1);
  });

  it("grid_1x1_v1.json's approaches (no waypoints) produce a centerline identical to a plain straight line", () => {
    const gridMap = loadMap("../../maps/grid_1x1_v1.json");
    const approach = gridMap.approaches.find((a) => a.id === "app_N")!;
    const centerline = buildApproachCenterline(approach);
    expect(centerline.length).toBeCloseTo(Math.hypot(approach.laneEndX - approach.laneStartX, approach.laneEndY - approach.laneStartY), 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.centerline.test.ts`
Expected: FAIL with "buildApproachCenterline is not a function".

- [ ] **Step 3: Implement the centerline builder**

Modify `sim-server/src/vehicles/TurnPaths.ts` — add after `bezierSegment`:
```ts
// Chains a sequence of waypoints into one smooth Segment by building a quadratic bezier between
// each consecutive pair, using the midpoint-reflection technique for interior control points so
// the curve doesn't kink at each waypoint: for waypoints [p0, p1, p2, ...], the bezier from p0 to
// p1 uses p0 itself as its own control point (a straight lead-in), and each subsequent bezier from
// p(i) to p(i+1) uses a control point placed so the tangent direction stays continuous across the
// p(i) joint (reflecting the previous segment's incoming direction).
function chainedWaypointSegment(waypoints: Point[]): Segment {
  const segments: Segment[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    if (i === 0) {
      // Lead-in: no previous direction to continue, so a straight line to the first interior
      // waypoint keeps this simple and correct (a 2-waypoint approach never reaches this branch
      // at all — chainedWaypointSegment is only called with length >= 3).
      segments.push(straightSegment(from, to));
      continue;
    }
    const prev = waypoints[i - 1];
    // Control point continuing the incoming direction from `prev` through `from`, scaled to a
    // fraction of the outgoing leg's own length so it doesn't overshoot on short final legs.
    const incomingDx = from.x - prev.x;
    const incomingDy = from.y - prev.y;
    const incomingLength = Math.hypot(incomingDx, incomingDy) || 1;
    const outgoingLength = Math.hypot(to.x - from.x, to.y - from.y);
    const controlScale = outgoingLength / incomingLength;
    const control: Point = { x: from.x + (incomingDx / incomingLength) * outgoingLength * controlScale, y: from.y + (incomingDy / incomingLength) * outgoingLength * controlScale };
    segments.push(bezierSegment(from, control, to));
  }
  // composePath returns a VehiclePath (pointAt/headingAt/totalLength), not a bare Segment
  // (pointAtDistance/headingAtDistance/length) — this function's return type is Segment, so wrap
  // it rather than returning the VehiclePath object directly.
  const composed = composePath(segments, segments[0].length);
  return { length: composed.totalLength, pointAtDistance: composed.pointAt, headingAtDistance: composed.headingAt };
}

export function buildApproachCenterline(approach: ApproachDef): Segment {
  const from: Point = { x: approach.laneStartX, y: approach.laneStartY };
  const to: Point = { x: approach.laneEndX, y: approach.laneEndY };
  if (!approach.waypoints || approach.waypoints.length < 3) {
    return straightSegment(from, to);
  }
  return chainedWaypointSegment(approach.waypoints);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.centerline.test.ts`
Expected: PASS (4 tests). If the curved-approach curve self-intersects or looks unreasonable
(check by logging sampled points), adjust `fixture_curved_3int.json`'s waypoints (Task 1) — this
is expected empirical back-and-forth, not a sign of a wrong approach.

- [ ] **Step 5: Run the full existing sim-server test suite to confirm zero regressions so far**

Run: `cd sim-server && npx vitest run`
Expected: PASS, same count as before this task started (this task only added new exported
functions; nothing existing calls them yet).

---

### Task 4: Angle-based turn-curve control point (replaces compass lookup)

**Files:**
- Modify: `sim-server/src/vehicles/TurnPaths.ts`
- Test: `sim-server/test/vehicles/TurnPaths.turnControlPoint.test.ts`
- Create (throwaway, delete after use per this session's established practice): `sim-server/_turn_regression_probe.mts`

**Interfaces:**
- Consumes: `headingIntoIntersection`/`headingOutOfIntersection` (Task 2).
- Produces: `isRoughlyOpposite(headingA: number, headingB: number, toleranceRad?: number):
  boolean` (replaces the compass `OPPOSITE` lookup table); `turnControlPoint(entryStopPoint: Point,
  entryHeading: number, exitStopPoint: Point, exitHeading: number, fraction: number): Point`
  (replaces `cornerPoint`, and is now correctly relative to wherever the two points actually are in
  world space — the old `cornerPoint` implicitly assumed the intersection sat at the origin, a
  latent bug the single-intersection map's `int_1` happening to be at `(0,0)` was masking).

- [ ] **Step 1: Write the failing tests**

Create `sim-server/test/vehicles/TurnPaths.turnControlPoint.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isRoughlyOpposite, turnControlPoint } from "../../src/vehicles/TurnPaths";

describe("isRoughlyOpposite", () => {
  it("headings exactly 180 degrees apart are opposite", () => {
    expect(isRoughlyOpposite(0, Math.PI)).toBe(true);
  });
  it("headings 90 degrees apart are not opposite", () => {
    expect(isRoughlyOpposite(0, Math.PI / 2)).toBe(false);
  });
  it("headings 170 degrees apart are opposite within the default tolerance", () => {
    expect(isRoughlyOpposite(0, (170 * Math.PI) / 180)).toBe(true);
  });
});

describe("turnControlPoint", () => {
  it("for a 90-degree turn at a non-origin intersection, the control point sits near that intersection, not near (0,0)", () => {
    // Mirrors int_B's geometry-ish: entry heading east (0 rad) arriving at (380,0), exit heading
    // north (-pi/2 rad, "up" in a y-down-is-south convention) leaving from (400,-20) -- both stop
    // points near the real intersection center (400,0), not near the origin.
    const point = turnControlPoint({ x: 380, y: 0 }, 0, { x: 400, y: -20 }, -Math.PI / 2, 0.4);
    const distanceFromIntersection = Math.hypot(point.x - 400, point.y - 0);
    const distanceFromOrigin = Math.hypot(point.x, point.y);
    expect(distanceFromIntersection).toBeLessThan(distanceFromOrigin);
  });

  it("does not throw for a near-parallel entry/exit (degenerate ray intersection)", () => {
    expect(() => turnControlPoint({ x: 0, y: 0 }, 0, { x: 100, y: 0.001 }, 0.0001, 0.4)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.turnControlPoint.test.ts`
Expected: FAIL with "isRoughlyOpposite is not a function".

- [ ] **Step 3: Implement `isRoughlyOpposite` and `turnControlPoint`**

Modify `sim-server/src/vehicles/TurnPaths.ts` — add after the heading functions from Task 2:
```ts
export function isRoughlyOpposite(headingA: number, headingB: number, toleranceRad = (20 * Math.PI) / 180): boolean {
  const diff = Math.atan2(Math.sin(headingA - headingB), Math.cos(headingA - headingB));
  return Math.abs(Math.abs(diff) - Math.PI) < toleranceRad;
}

// Replaces the old compass-based cornerPoint, which returned a point relative to an *assumed*
// intersection at the origin (only correct because grid_1x1_v1.json's one intersection happens to
// sit at (0,0) — a latent bug for any other intersection position). This version is a real
// geometric construction: the ideal single control point for a quadratic bezier smoothly
// connecting two directed line segments is where their tangent lines cross (a car arriving along
// `entryHeading` and departing along `exitHeading` would, if it could travel in perfectly straight
// lines, meet at that crossing point). `fraction` pulls the actual control point from that ideal
// crossing toward the straight-line midpoint between the two stop points — fraction=0 is the full
// ideal-crossing point (can produce very wide curves for sharp angles), fraction=1 is a straight
// chord (no bulge at all). Falls back to the midpoint outright when the two tangent rays are
// nearly parallel (no well-defined intersection, e.g. a near-straight "turn" or a near-U-turn).
export function turnControlPoint(entryStopPoint: Point, entryHeading: number, exitStopPoint: Point, exitHeading: number, fraction: number): Point {
  const midpoint: Point = { x: (entryStopPoint.x + exitStopPoint.x) / 2, y: (entryStopPoint.y + exitStopPoint.y) / 2 };

  const d1x = Math.cos(entryHeading);
  const d1y = Math.sin(entryHeading);
  // The exit ray is traced backward from exitStopPoint (a vehicle departing along exitHeading
  // came *from* the direction opposite exitHeading).
  const d2x = Math.cos(exitHeading + Math.PI);
  const d2y = Math.sin(exitHeading + Math.PI);

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-6) return midpoint;

  const dx = exitStopPoint.x - entryStopPoint.x;
  const dy = exitStopPoint.y - entryStopPoint.y;
  const t = (dx * d2y - dy * d2x) / denom;
  const idealCrossing: Point = { x: entryStopPoint.x + d1x * t, y: entryStopPoint.y + d1y * t };

  return {
    x: idealCrossing.x + (midpoint.x - idealCrossing.x) * fraction,
    y: idealCrossing.y + (midpoint.y - idealCrossing.y) * fraction
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.turnControlPoint.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Empirically verify the turn radius on the OLD map's 90-degree turns hasn't regressed**

The old `cornerPoint`-based formula used `fraction` implicitly baked into `TURN_CONTROL_FRACTION =
0.4` applied to `stopOffset` directly (a different parameterization — the old code scaled from the
origin, this new code scales from the ideal ray-crossing toward the midpoint). These are not the
same formula, so the right `fraction` value for this new function needs its own empirical check,
not an assumed carry-over of `0.4`. Create `sim-server/_turn_regression_probe.mts`:
```ts
import { loadMap } from "./src/maps/loadMap.js";
import { headingIntoIntersection, headingOutOfIntersection, turnControlPoint } from "./src/vehicles/TurnPaths.js";

const map = loadMap("../../maps/grid_1x1_v1.json");

function minRadiusForTurn(entryId: string, exitId: string, fraction: number): number {
  const entry = map.approaches.find((a) => a.id === entryId)!;
  const exit = map.approaches.find((a) => a.id === exitId)!;
  const entryStop = { x: entry.laneEndX, y: entry.laneEndY }; // approximate; exact stop point offset doesn't matter for a relative radius check
  const exitStop = { x: exit.laneEndX, y: exit.laneEndY };
  const control = turnControlPoint(entryStop, headingIntoIntersection(entry), exitStop, headingOutOfIntersection(exit), fraction);
  // Reuse the same Menger-curvature sampling technique from this session's earlier turn-geometry probe.
  const N = 60;
  let minR = Infinity;
  for (let i = 1; i < N; i++) {
    const t0 = (i - 1) / N, t1 = i / N, t2 = (i + 1) / N;
    const bez = (t: number) => ({
      x: (1 - t) ** 2 * entryStop.x + 2 * (1 - t) * t * control.x + t ** 2 * exitStop.x,
      y: (1 - t) ** 2 * entryStop.y + 2 * (1 - t) * t * control.y + t ** 2 * exitStop.y
    });
    const p0 = bez(t0), p1 = bez(t1), p2 = bez(t2);
    const a = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const b = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const c = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    const s = (a + b + c) / 2;
    const area = Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c)));
    if (area < 1e-9) continue;
    const R = (a * b * c) / (4 * area);
    if (R < minR) minR = R;
  }
  return minR;
}

for (const fraction of [0.3, 0.4, 0.5, 0.6, 0.7]) {
  console.log(`fraction=${fraction}: minRadius(N->E)=${minRadiusForTurn("app_N", "app_E", fraction).toFixed(1)}`);
}
```

Run: `cd sim-server && npx tsx _turn_regression_probe.mts`

Pick the smallest `fraction` value that keeps `minRadius` comfortably above 30 units (roughly
matching the ~52-unit radius this session already validated as "reads as a real curve" for an
18-wide, 36-long vehicle) — update the `fraction` argument passed from `buildVehiclePath` in Task
5 to this value once chosen. Delete `_turn_regression_probe.mts` once this value is picked (Step 6).

- [ ] **Step 6: Delete the throwaway probe script**

Run: `cd sim-server && rm _turn_regression_probe.mts`

---

### Task 5: Wire `buildVehiclePath` to the new heading/curve/turn-control machinery

**Files:**
- Modify: `sim-server/src/vehicles/TurnPaths.ts:158-181` (the existing `buildVehiclePath` function
  and the now-unused `OPPOSITE`/`cornerPoint`)
- Test: `sim-server/test/vehicles/TurnPaths.multiIntersection.test.ts`

**Interfaces:**
- Consumes: `buildApproachCenterline` (Task 3), `headingIntoIntersection`/`headingOutOfIntersection`
  (Task 2), `isRoughlyOpposite`/`turnControlPoint` (Task 4).
- Produces: `buildVehiclePath` keeps its exact existing signature
  `(mapDef: MapDefinition, entryApproachId: string, exitApproachId: string): VehiclePath` — no
  caller anywhere in the codebase needs to change for this task.

- [ ] **Step 1: Write the failing tests**

Create `sim-server/test/vehicles/TurnPaths.multiIntersection.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildVehiclePath } from "../../src/vehicles/TurnPaths";

describe("buildVehiclePath on a curved, non-90-degree, non-origin intersection", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");

  // Stage 1 keeps buildVehiclePath's existing single-intersection, one-entry-one-exit contract —
  // multi-hop routing across several intersections is Stage 2 (spec §7.1). Every pair below shares
  // one intersection, matching how grid_1x1_v1.json's own tests only ever cross app_N/S/E/W (all
  // one intersection) too.
  it("a turn at int_B (400,0), a non-origin intersection, ends near the exit approach's far point — regression check for the old cornerPoint's implicit origin assumption", () => {
    const path = buildVehiclePath(map, "b_from_a", "b_far_north");
    const end = path.pointAt(path.totalLength);
    expect(end.x).toBeCloseTo(400, 0);
    expect(end.y).toBeCloseTo(-300, 0);
  });

  it("a path exiting via the curved b_from_c connector is noticeably longer than the straight-line distance between its endpoints", () => {
    const path = buildVehiclePath(map, "b_from_a", "b_from_c");
    const start = path.pointAt(0);
    const end = path.pointAt(path.totalLength);
    const straightLineDistance = Math.hypot(end.x - start.x, end.y - start.y);
    expect(path.totalLength).toBeGreaterThan(straightLineDistance * 1.02);
  });

  it("a path exiting via the curved b_from_c connector ends near that approach's far point (700,250), not at int_B", () => {
    const path = buildVehiclePath(map, "b_from_a", "b_from_c");
    const end = path.pointAt(path.totalLength);
    expect(end.x).toBeCloseTo(700, 0);
    expect(end.y).toBeCloseTo(250, 0);
  });

  it("closestProgress still recovers a known distance correctly on a path that exits via a curved connector", () => {
    const path = buildVehiclePath(map, "b_from_a", "b_from_c");
    const knownDistance = path.totalLength * 0.6;
    const point = path.pointAt(knownDistance);
    expect(path.closestProgress(point)).toBeCloseTo(knownDistance, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.multiIntersection.test.ts`
Expected: FAIL — likely wrong `end` coordinates, since `buildVehiclePath` hasn't been rewired yet
and the fixture's non-origin/curved geometry isn't handled correctly by the old compass logic.

- [ ] **Step 3: Rewrite `buildVehiclePath`, removing the now-dead `OPPOSITE`/`cornerPoint`**

Modify `sim-server/src/vehicles/TurnPaths.ts` — delete the `OPPOSITE` constant (line 4) and the
`cornerPoint` function (lines 93-97; both fully superseded by Task 2/4's functions), and replace
`buildVehiclePath` (currently lines 173-195) with:
```ts
export function buildVehiclePath(mapDef: MapDefinition, entryApproachId: string, exitApproachId: string): VehiclePath {
  const entry = mapDef.approaches.find((a) => a.id === entryApproachId)!;
  const exit = mapDef.approaches.find((a) => a.id === exitApproachId)!;

  const entryCenterline = buildApproachCenterline(entry);
  const exitCenterline = buildApproachCenterline(exit);

  const entryStopOffset = Math.min(STOP_LINE_OFFSET, entryCenterline.length / 2);
  const exitStopOffset = Math.min(STOP_LINE_OFFSET, exitCenterline.length / 2);
  const entryStopDistance = entryCenterline.length - entryStopOffset;
  const exitStopDistance = exitCenterline.length - exitStopOffset;
  const entryStopPoint = entryCenterline.pointAtDistance(entryStopDistance);
  // Both stop points sit `stopOffset` short of their OWN approach's intersection end
  // (pointAtDistance(length) — not pointAtDistance(0), which is the far spawn point) — entry and
  // exit are symmetric here, both measured backward from their own centerline's intersection end.
  const exitStopPoint = exitCenterline.pointAtDistance(exitStopDistance);

  const entryHeading = headingIntoIntersection(entry);
  const exitHeading = headingOutOfIntersection(exit);

  const isStraight = isRoughlyOpposite(entryHeading, exitHeading);
  const crossing: Segment = isStraight
    ? straightSegment(entryStopPoint, exitStopPoint)
    : bezierSegment(entryStopPoint, turnControlPoint(entryStopPoint, entryHeading, exitStopPoint, exitHeading, TURN_CONTROL_FRACTION), exitStopPoint);

  // Entry segment: the approach's centerline from its far start up to its stop point — exactly
  // the [0, entryStopDistance] slice, since pointAtDistance(0) is always the far laneStart point
  // by construction (unchanged direction of travel: increasing distance = toward the intersection).
  const entrySegment: Segment = {
    length: entryStopDistance,
    pointAtDistance: (d) => entryCenterline.pointAtDistance(d),
    headingAtDistance: (d) => entryCenterline.headingAtDistance(d)
  };

  // Exit segment: traversed in REVERSE relative to the exit approach's own laneStart->laneEnd
  // parameterization. exit.laneEnd is the SAME intersection entry belongs to (both approaches'
  // laneEnd is always their own home intersection — see MapDefinition's convention), so a vehicle
  // *exiting* via this approach starts near that intersection (large distance-from-laneStart) and
  // travels toward the far laneStart point (distance 0) as the overall path's own distance
  // increases — the opposite direction from how the centerline itself is parameterized. This
  // exactly generalizes the original single-intersection code's `straightSegment(exitStopPoint,
  // exitStart)` (which built a fresh straight segment running the same backward direction) to
  // work over any centerline, straight or curved, without needing a second, reversed geometry
  // builder — reusing the same forward-parameterized centerline, just read backward.
  const exitSegmentLength = exitStopDistance;
  const exitSegment: Segment = {
    length: exitSegmentLength,
    pointAtDistance: (d) => exitCenterline.pointAtDistance(exitStopDistance - d),
    headingAtDistance: (d) => {
      const forwardHeading = exitCenterline.headingAtDistance(exitStopDistance - d);
      return Math.atan2(Math.sin(forwardHeading + Math.PI), Math.cos(forwardHeading + Math.PI));
    }
  };

  const segments = [entrySegment, crossing, exitSegment];
  return composePath(segments, entrySegment.length);
}
```

Update the `import type { MapDefinition, Direction, ApproachDef }` line — `Direction` is no longer
used anywhere in this file once `OPPOSITE`/`cornerPoint` are deleted; remove it from the import
(keep `ApproachDef`, added in Task 2). Update the `TURN_CONTROL_FRACTION` constant's value to
whatever Task 4 Step 5 determined empirically, and update its doc comment to describe the new
ray-crossing-based parameterization instead of the old `cornerPoint`-relative one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sim-server && npx vitest run test/vehicles/TurnPaths.multiIntersection.test.ts`
Expected: PASS (3 tests). If the curved-connector length assertion is too strict/loose given the
actual fixture geometry, adjust the `1.02` multiplier based on the real measured lengths — this is
expected empirical tuning, not a sign of a wrong implementation.

- [ ] **Step 5: Run the FULL existing sim-server test suite — this is the critical regression gate**

Run: `cd sim-server && npx vitest run`
Expected: PASS, exact same test count and results as before Task 1 started. This is the single
most important check in this whole plan: `grid_1x1_v1.json` never sets `waypoints`, so
`buildApproachCenterline` always takes the `straightSegment` branch for it, `isRoughlyOpposite`
must classify the same entry/exit pairs as "straight" that `OPPOSITE` did, and
`turnControlPoint`'s output must produce turns with radius/behavior close enough to the old
`cornerPoint` output that no existing test (physics determinism, TrafficController stop-line
timing, etc.) breaks. If anything fails here, it is a real regression to fix before moving on —
do not proceed to Task 6 with a red suite.

---

### Task 6: Curved wall-chain physics (only for waypoints-bearing approaches)

**Files:**
- Modify: `sim-server/src/physics/PhysicsWorld.ts`
- Test: `sim-server/test/physics/PhysicsWorld.curvedWalls.test.ts`

**Interfaces:**
- Consumes: `buildApproachCenterline` (Task 3).
- Produces: no change to `PhysicsWorld`'s public shape (`constructor(mapDef)`, `step(dtMs)`) — this
  task only changes what bodies get added to `this.engine.world` for waypoints-bearing approaches.

- [ ] **Step 1: Write the failing test**

Create `sim-server/test/physics/PhysicsWorld.curvedWalls.test.ts`:
```ts
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
    const body = new VehicleBody(world, "probe", { x: entry.laneStartX, y: entry.laneStartY, heading });

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

    let distanceTraveled = 0;
    for (let i = 0; i < 1200; i++) {
      world.step(50);
      distanceTraveled = path.closestProgress(body.body.position, distanceTraveled);
      body.applyInput(1, 0, 0, 50); // full throttle, straight steer is fine for this pass/fail check
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sim-server && npx vitest run test/physics/PhysicsWorld.curvedWalls.test.ts`
Expected: FAIL on the first test (curved-connector vehicle hits a wall — the current
straight-line-only wall builder places a single long straight wall pair that doesn't follow the
curve at all, so a vehicle following the curved path drives straight into it).

- [ ] **Step 3: Implement curved wall-chains, gated on `waypoints` presence**

Modify `sim-server/src/physics/PhysicsWorld.ts` — extract the existing per-approach wall-building
loop body (lines 11-56, unchanged) into a new private method `buildStraightWalls`, and add a
parallel `buildCurvedWalls` used only when `approach.waypoints` is present:
```ts
import Matter from "matter-js";
import type { MapDefinition, ApproachDef } from "../maps/MapDefinition.js";
import { STOP_LINE_OFFSET, buildApproachCenterline } from "../vehicles/TurnPaths.js";

const WALL_CHAIN_SEGMENT_LENGTH = 20; // short enough to hug a curve, long enough to keep body count reasonable

export class PhysicsWorld {
  readonly engine: Matter.Engine;

  constructor(mapDef: MapDefinition) {
    this.engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });

    for (const approach of mapDef.approaches) {
      if (approach.waypoints && approach.waypoints.length >= 3) {
        this.buildCurvedWalls(approach);
      } else {
        this.buildStraightWalls(approach);
      }
      this.buildQueueZone(approach);
    }
  }

  // Unchanged from before this task — exact same math, exact same body count/labels for every
  // approach without waypoints (grid_1x1_v1.json always takes this path).
  private buildStraightWalls(approach: ApproachDef): void {
    const dx = approach.laneEndX - approach.laneStartX;
    const dy = approach.laneEndY - approach.laneStartY;
    const fullLength = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    const gap = STOP_LINE_OFFSET;
    const length = Math.max(fullLength - gap, 1);
    const unitX = dx / fullLength;
    const unitY = dy / fullLength;
    const midX = approach.laneStartX + unitX * (length / 2);
    const midY = approach.laneStartY + unitY * (length / 2);
    const perpX = -Math.sin(angle) * (approach.width / 2);
    const perpY = Math.cos(angle) * (approach.width / 2);

    const leftEdge = Matter.Bodies.rectangle(midX + perpX, midY + perpY, length, 4, { isStatic: true, angle, label: `${approach.id}_left_edge` });
    const rightEdge = Matter.Bodies.rectangle(midX - perpX, midY - perpY, length, 4, { isStatic: true, angle, label: `${approach.id}_right_edge` });
    Matter.Composite.add(this.engine.world, [leftEdge, rightEdge]);
  }

  // Only reached for approaches with waypoints (never grid_1x1_v1.json). Samples the approach's
  // real (curved) centerline in short straight segments and places a left/right wall-rectangle
  // pair along each one, rotated to that segment's own local tangent — the same "chain of short
  // straight pieces approximates a curve" technique the turn-curve's own 24-point sampling already
  // relies on, just walked along the whole road instead of only the last few meters into an
  // intersection.
  private buildCurvedWalls(approach: ApproachDef): void {
    const centerline = buildApproachCenterline(approach);
    const length = Math.max(centerline.length - STOP_LINE_OFFSET, 1);
    const segmentCount = Math.max(1, Math.ceil(length / WALL_CHAIN_SEGMENT_LENGTH));
    const segmentLength = length / segmentCount;

    const bodies: Matter.Body[] = [];
    for (let i = 0; i < segmentCount; i++) {
      const dStart = i * segmentLength;
      const dEnd = dStart + segmentLength;
      const pStart = centerline.pointAtDistance(dStart);
      const pEnd = centerline.pointAtDistance(dEnd);
      const midX = (pStart.x + pEnd.x) / 2;
      const midY = (pStart.y + pEnd.y) / 2;
      const segAngle = Math.atan2(pEnd.y - pStart.y, pEnd.x - pStart.x);
      const segLen = Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y);
      const perpX = -Math.sin(segAngle) * (approach.width / 2);
      const perpY = Math.cos(segAngle) * (approach.width / 2);

      bodies.push(Matter.Bodies.rectangle(midX + perpX, midY + perpY, segLen, 4, { isStatic: true, angle: segAngle, label: `${approach.id}_left_edge_${i}` }));
      bodies.push(Matter.Bodies.rectangle(midX - perpX, midY - perpY, segLen, 4, { isStatic: true, angle: segAngle, label: `${approach.id}_right_edge_${i}` }));
    }
    Matter.Composite.add(this.engine.world, bodies);
  }

  private buildQueueZone(approach: ApproachDef): void {
    const dx = approach.laneEndX - approach.laneStartX;
    const dy = approach.laneEndY - approach.laneStartY;
    const fullLength = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    const zoneLength = 60;
    const zoneCenterOffset = zoneLength / 2;
    const towardIntersectionX = dx / fullLength;
    const towardIntersectionY = dy / fullLength;
    const zoneCenterX = approach.laneEndX - towardIntersectionX * zoneCenterOffset;
    const zoneCenterY = approach.laneEndY - towardIntersectionY * zoneCenterOffset;

    const queueZone = Matter.Bodies.rectangle(zoneCenterX, zoneCenterY, zoneLength, approach.width, { isStatic: true, isSensor: true, angle, label: `${approach.id}_queue_zone` });
    Matter.Composite.add(this.engine.world, queueZone);
  }

  step(dtMs: number): void {
    const SUB_STEP_MS = 1000 / 60;
    let remaining = dtMs;
    while (remaining > 1e-6) {
      const step = Math.min(SUB_STEP_MS, remaining);
      Matter.Engine.update(this.engine, step);
      remaining -= step;
    }
  }
}
```

Note: `buildQueueZone`'s straight-line math is left unchanged/uses laneStart-laneEnd directly even
for curved approaches — the queue-zone sensor only needs to roughly cover "near the intersection
end," and it's a sensor (no collision response), so an approximate straight placement near the
curve's actual intersection-end point is acceptable; if empirical testing in Task 7 shows the
queue-zone sensor sitting somewhere clearly wrong for a curved approach (e.g. off to the side of
the actual curved road), switch its center calculation to use `buildApproachCenterline(approach)`'s
last few units instead — flag this as a possible follow-up while implementing, don't guess now.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sim-server && npx vitest run test/physics/PhysicsWorld.curvedWalls.test.ts`
Expected: PASS (2 tests). If the curved-connector test still shows wall collisions, the most likely
cause is gaps or overlaps at wall-chain joints — try reducing `WALL_CHAIN_SEGMENT_LENGTH` (shorter
segments hug the curve more tightly) or check whether `approach.width` is wide enough for
`VehicleBody`'s real 18-unit width plus the STOP_LINE_OFFSET-based gap gives adequate clearance,
the same way the original single-intersection wall-gap bug was diagnosed earlier this session —
trace the vehicle's real position tick-by-tick against the wall bodies' actual bounds if the first
fix attempt doesn't work.

- [ ] **Step 5: Run the full existing sim-server test suite to confirm zero regressions**

Run: `cd sim-server && npx vitest run`
Expected: PASS, same count as after Task 5 (this task's new `buildCurvedWalls` path is never
exercised by `grid_1x1_v1.json`, and `buildStraightWalls`/`buildQueueZone` are extracted verbatim
from the previous inline code, not rewritten).

---

### Task 7: End-to-end integration proof on the fixture map

**Files:**
- Test: `sim-server/test/integration/curvedNetworkFixture.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6. No new production code in this task — it is purely a
  proof that the whole stage works together, the same role `SimSession.test.ts` plays for the
  original single-intersection map.

- [ ] **Step 1: Write the end-to-end test**

Create `sim-server/test/integration/curvedNetworkFixture.test.ts`:
```ts
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
    const body = new VehicleBody(world, "e2e", { x: entry.laneStartX, y: entry.laneStartY, heading });

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
```

- [ ] **Step 2: Run the test**

Run: `cd sim-server && npx vitest run test/integration/curvedNetworkFixture.test.ts`
Expected: PASS. If `reachedEnd` is false or `maxSpeedSeen` exceeds 20, this is a genuine
end-to-end problem somewhere in Tasks 1-6's integration (not necessarily any single task's own
unit tests, which each passed in isolation) — trace the vehicle's tick-by-tick position/speed the
same way every physics bug this session was root-caused, starting from wherever it stalls or
spikes.

- [ ] **Step 3: Run the complete sim-server test suite one final time**

Run: `cd sim-server && npx vitest run`
Expected: PASS, full suite green — this closes out Stage 1. `grid_1x1_v1.json` and all its
original tests are untouched and passing; the new fixture map and its tests (Tasks 1-7) are all
passing; the engine now supports curved roads, non-90-degree turns, and non-origin intersections.

- [ ] **Step 4: Run `tsc --noEmit` for a final type-check**

Run: `cd sim-server && npx tsc --noEmit`
Expected: no errors.

---

## Definition of Done

- [ ] `grid_1x1_v1.json` and all ~100 pre-existing tests pass completely unmodified.
- [ ] `fixture_curved_3int.json` exists with 3 intersections (at least 2 away from the origin,
      specifically to regression-test the old `cornerPoint`'s implicit origin assumption) and one
      genuinely curved connector road.
- [ ] A vehicle can be routed and physically driven through the fixture map end-to-end (far spawn,
      straight approach, turn at a non-origin intersection, curved exit segment, ends near a far
      point) without wall collisions or unrealistic speed spikes.
- [ ] `OPPOSITE` and `cornerPoint` (the old compass-based, origin-assuming functions) are deleted,
      not left dead in the codebase.
- [ ] Full sim-server test suite and `tsc --noEmit` are both clean.
