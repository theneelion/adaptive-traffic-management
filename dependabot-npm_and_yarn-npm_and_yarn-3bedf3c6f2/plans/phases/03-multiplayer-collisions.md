# Phase 3: Multiplayer + Real Collisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-hardcoded-car world with a real shared room: continuous IDM traffic spawning at a configurable arrival rate on all four approaches — each vehicle assigned a real turning movement (straight/left/right) through the intersection, not just a straight pass-through — up to a configurable cap of human-claimable vehicles, multiple browser clients joining the same simulation, physically consistent vehicle-vehicle collision response (no clipping), and disconnect recovery that reverts a car to IDM control after a bounded grace period instead of freezing it.

**Architecture:** `SingleCarSession` (Phase 1/2's intentionally throwaway scaffold) is deleted and replaced by `SimSession`, built from four new collaborators: `TurnPaths` (derives a straight or curved path through the intersection for any entry→exit approach pair, purely from `MapDefinition` geometry), `TrafficController` (spawns/despawns/drives IDM vehicles along their assigned path, combining IDM longitudinal control with pure-pursuit lateral steering, including a signal-aware "virtual leader" with a realistic dilemma-zone rule on yellow), `RoomManager` (claim/leave/disconnect-grace bookkeeping only — it never touches physics), and a collision-logging hook on the existing `PhysicsWorld`. This is also where the dedicated `integration` CI job (docker-compose, both services) finally lands, since multiplayer join/leave/claim is the first thing worth testing against a real second process.

**Why turning matters here and not later:** an earlier draft of this plan had AI traffic travel in a straight line only and despawn at the intersection center — an oversimplification that also artificially blocked Phase 7's emergency vehicle from reaching anything but the directly-opposite approach. Real intersections have vehicles turning left and right, and the whole point of a "test the traffic" sandbox is more interesting emergent behavior (turning traffic crossing paths with through-traffic), not less. This phase is where that capability is built once, for every AI-controlled vehicle (including the EV in Phase 7, which reuses `TurnPaths` rather than re-deriving its own).

**Tech Stack:** Same as Phases 1-2, no new external dependencies — this phase is pure Matter.js + `ws` + vitest work.

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §3, §4, §14 step 3, FR-2, FR-4, FR-5, FR-6, TR-1. Also read [`00-overview.md`](00-overview.md) §5 (CI table — `integration` job added here) and §6 (Interface ledger). Also read [`01-core-loop.md`](01-core-loop.md) Task 5 (`VehicleBody`, `idmAcceleration`) and [`02-signal-ai-v1.md`](02-signal-ai-v1.md) Tasks 4-6 (`QueueDetector`, `SignalController`, `SignalPhaseMachine`) — this phase's `TrafficController` is the first consumer of the phase machine's per-approach green/yellow/red state.

## Global Constraints

- All Phase 1-2 Global Constraints still apply.
- Concurrency cap on human-controlled vehicles is configurable, default `MAX_HUMAN_CARS = 4` (spec: "a handful of concurrent users"; FR-5).
- Disconnect grace period is bounded and configurable, default `DISCONNECT_GRACE_MS = 3000` — a car reverts to IDM control automatically after this elapses, it never simply freezes (spec §3, FR-4).
- **Turning, not just straight-through (revised design decision):** every AI-controlled vehicle is assigned a real movement (its entry approach paired with one of the other three as its exit) at spawn, and follows a real curved or straight path between them via `TurnPaths`. A vehicle despawns once it reaches the far end of its *assigned exit* approach, not at the intersection center. User-claimed cars are unaffected either way — a human can already drive anywhere the physics allows via free steering input (Phase 1), turning was never restricted for them.
- **Signal awareness is entry-approach-only, not movement-specific:** since `grid_1x1_v1` has only two signal phases and no dedicated protected-turn phase, a vehicle's stop/go decision at the stop line depends only on its *entry* approach's current signal state (from Phase 2's `SignalPhaseMachine`), regardless of which exit it's headed to. Once a vehicle has crossed its stop line, it is committed — it no longer checks the signal at all and simply follows its path, subject to physical collision risk from crossing traffic. This is intentional, not an oversight: it's the same "chaos is a feature, not a bug to engineer away" reasoning already applied to collision response elsewhere in this plan set, and it matches how a real driver behaves (you don't stop mid-intersection because the light changed).

---

### Task 1: shared-contracts — `room-events` schema

**Files:**
- Create: `shared-contracts/schemas/room-events.schema.json`
- Test: `shared-contracts/test/generated.test.ts` (extend)

**Interfaces:**
- Produces (Interface ledger, Phase 3 — supersedes the three-separate-types sketch in `00-overview.md` §6, corrected in this phase's self-review): one discriminated-union WS message, `RoomEventMessage`.

- [ ] **Step 1: Write the schema**

`shared-contracts/schemas/room-events.schema.json`:
```json
{
  "$id": "RoomEventMessage",
  "type": "object",
  "required": ["type", "payload", "ts"],
  "properties": {
    "type": { "const": "room_event" },
    "ts": { "type": "number" },
    "payload": {
      "oneOf": [
        {
          "type": "object",
          "required": ["kind", "clientId", "carId"],
          "properties": {
            "kind": { "const": "user_join" },
            "clientId": { "type": "string" },
            "carId": { "type": "string" }
          }
        },
        {
          "type": "object",
          "required": ["kind", "clientId", "carId"],
          "properties": {
            "kind": { "const": "user_leave" },
            "clientId": { "type": "string" },
            "carId": { "type": "string" }
          }
        },
        {
          "type": "object",
          "required": ["kind", "entities", "collisionKind"],
          "properties": {
            "kind": { "const": "collision" },
            "entities": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 2 },
            "collisionKind": { "enum": ["vehicle_vehicle", "vehicle_pedestrian"] }
          }
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Regenerate and extend the smoke test**

Run: `pnpm --filter shared-contracts generate`

Add to `shared-contracts/test/generated.test.ts`:
```ts
import type { RoomEventMessage } from "../generated/ts/room-events.schema";

it("accepts a user_join RoomEventMessage", () => {
  const msg: RoomEventMessage = {
    type: "room_event",
    ts: 1,
    payload: { kind: "user_join", clientId: "c1", carId: "car_app_N_1" }
  };
  expect(msg.payload.kind).toBe("user_join");
});
```

- [ ] **Step 3: Run test, verify pass, commit**

Run: `pnpm --filter shared-contracts test`
Expected: PASS.

```bash
git add shared-contracts/schemas/room-events.schema.json shared-contracts/generated shared-contracts/test ai-service/app/contracts
git commit -m "feat(contracts): add room-events WS message schema"
```

---

### Task 2: `VehicleBody` controller field + seeded RNG utility

**Files:**
- Modify: `sim-server/src/vehicles/VehicleBody.ts` (add mutable `controller` field)
- Create: `sim-server/src/util/mulberry32.ts`
- Test: `sim-server/test/util/mulberry32.test.ts`

**Interfaces:**
- Produces: `VehicleBody.controller: "idm" | "user"` (mutable, default `"idm"`).
- Produces: `mulberry32(seed: number): () => number` — deterministic PRNG, used by `TrafficSpawner` (Task 3) and the determinism harness (Task 7).

- [ ] **Step 1: Write the failing test for `mulberry32`**

`sim-server/test/util/mulberry32.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mulberry32 } from "../../src/util/mulberry32";

describe("mulberry32", () => {
  it("produces the same sequence for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces values in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("produces a different sequence for a different seed", () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- mulberry32`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `mulberry32`**

`sim-server/src/util/mulberry32.ts`:
```ts
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- mulberry32`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the `controller` field to `VehicleBody`**

Modify `sim-server/src/vehicles/VehicleBody.ts` — add `public controller: "idm" | "user" = "idm";` as a class field. No existing test breaks (nothing read this field before now).

- [ ] **Step 6: Commit**

```bash
git add sim-server/src/util sim-server/test/util sim-server/src/vehicles/VehicleBody.ts
git commit -m "feat(sim-server): seeded PRNG util; VehicleBody gains a mutable controller field"
```

---

### Task 3: `TurnPaths` + `TrafficSpawner` + `TrafficController` — continuous IDM traffic with turning and signal compliance

**Files:**
- Create: `sim-server/src/vehicles/TurnPaths.ts`
- Create: `sim-server/src/vehicles/TrafficSpawner.ts`
- Create: `sim-server/src/vehicles/TrafficController.ts`
- Test: `sim-server/test/vehicles/TurnPaths.test.ts`
- Test: `sim-server/test/vehicles/TrafficSpawner.test.ts`
- Test: `sim-server/test/vehicles/TrafficController.test.ts`

**Interfaces:**
- Consumes: `mulberry32` (Task 2), `idmAcceleration`, `VehicleBody`, `IdmParams`, `ApproachDef`, `Direction`, `MapDefinition` (Phase 1), `SignalPhaseMachine`'s per-approach state shape (Phase 2, Task 6: `"green" | "yellow" | "red"`).
- Produces: `interface VehiclePath { totalLength: number; stopLineDistance: number; pointAt(distance: number): { x: number; y: number }; headingAt(distance: number): number }`, `function buildVehiclePath(mapDef: MapDefinition, entryApproachId: string, exitApproachId: string): VehiclePath`. Derived entirely from `MapDefinition` geometry — no new hand-authored map data, and no dependency on Phase 5's pedestrian graph even though both eventually describe the same physical corners.
- Produces: `class TrafficSpawner` — `constructor(approachIds: string[], rng: () => number, arrivalRatePerMinPerApproach: number)`, `.step(dtMs: number): string[]` (approach IDs to spawn on this tick).
- Produces (Interface ledger, Phase 3 — revised from a straight-only design): `class TrafficController` — `constructor(world: PhysicsWorld, mapDef: MapDefinition, idmParams: IdmParams, rng: () => number, arrivalRatePerMinPerApproach: number, onSpawn: (v: VehicleBody) => void)`, `.step(dtMs: number, approachSignalStates: Map<string, "green" | "yellow" | "red">): void`, `.vehicles: VehicleBody[]`, `.claimableVehicle(): VehicleBody | null`, `.vehicleMovements(): Array<{ id: string; entryApproachId: string; exitApproachId: string }>` (debug/test visibility into assigned turns).

- [ ] **Step 1: Write the failing test for `buildVehiclePath`**

`sim-server/test/vehicles/TurnPaths.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildVehiclePath } from "../../src/vehicles/TurnPaths";

describe("buildVehiclePath", () => {
  const map = loadMap("../../maps/grid_1x1_v1.json");

  it("builds a straight path for an opposite entry/exit pair, starting and ending at the approaches' far points", () => {
    const path = buildVehiclePath(map, "app_N", "app_S");
    const start = path.pointAt(0);
    const end = path.pointAt(path.totalLength);
    expect(start.x).toBeCloseTo(0, 5);
    expect(start.y).toBeCloseTo(-300, 5);
    expect(end.x).toBeCloseTo(0, 5);
    expect(end.y).toBeCloseTo(300, 5);
  });

  it("builds a curved path for an adjacent entry/exit pair that bulges toward the shared corner, not a straight line", () => {
    const path = buildVehiclePath(map, "app_N", "app_E");
    const midpoint = path.pointAt(path.totalLength / 2);
    // A straight line from (0,-300) to (300,0) would pass through (150,-150); the real path should
    // detour toward the NE corner (positive x, negative y, but noticeably off that straight midpoint).
    expect(Math.hypot(midpoint.x - 150, midpoint.y - (-150))).toBeGreaterThan(20);
  });

  it("reports a stopLineDistance strictly less than totalLength, positioned near the entry approach's own stop line", () => {
    const path = buildVehiclePath(map, "app_N", "app_W");
    expect(path.stopLineDistance).toBeGreaterThan(0);
    expect(path.stopLineDistance).toBeLessThan(path.totalLength);
    const stopPoint = path.pointAt(path.stopLineDistance);
    // Still on the northern approach's straight segment, i.e. x close to 0, y still negative and close to the intersection.
    expect(Math.abs(stopPoint.x)).toBeLessThan(5);
    expect(stopPoint.y).toBeLessThan(0);
    expect(stopPoint.y).toBeGreaterThan(-30);
  });

  it("headingAt points roughly toward the next point on the path", () => {
    const path = buildVehiclePath(map, "app_W", "app_E");
    const heading = path.headingAt(0);
    expect(heading).toBeCloseTo(0, 1); // W->E starts heading due east (+x direction, angle 0)
  });

  it("closestProgress recovers the correct distance for a point that lies on the path", () => {
    const path = buildVehiclePath(map, "app_N", "app_S");
    const knownDistance = 100;
    const point = path.pointAt(knownDistance);
    expect(path.closestProgress(point)).toBeCloseTo(knownDistance, 0);
  });

  it("closestProgress with a hint stays local, even when a curved path folds back near the entry segment", () => {
    const path = buildVehiclePath(map, "app_N", "app_E");
    // A point right at the start of the path is geometrically close to the corner bulge later
    // in the path too — without a hint, the global nearest-point search could latch onto that
    // far-away sample instead. With a hint near the true (small) progress, it must not.
    const nearStart = path.pointAt(5);
    const progress = path.closestProgress(nearStart, 5);
    expect(progress).toBeLessThan(path.stopLineDistance);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- TurnPaths`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `TurnPaths.ts`**

`sim-server/src/vehicles/TurnPaths.ts`:
```ts
import type { MapDefinition, Direction } from "../maps/MapDefinition";

const STOP_LINE_OFFSET = 15;
const OPPOSITE: Record<Direction, Direction> = { N: "S", S: "N", E: "W", W: "E" };

interface Point {
  x: number;
  y: number;
}

interface Segment {
  length: number;
  pointAtDistance(d: number): Point;
  headingAtDistance(d: number): number;
}

export interface VehiclePath {
  totalLength: number;
  stopLineDistance: number;
  pointAt(distance: number): Point;
  headingAt(distance: number): number;
  closestProgress(position: Point, hint?: number): number;
}

function pointAlong(from: Point, to: Point, distance: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const t = distance / length;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function straightSegment(from: Point, to: Point): Segment {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const heading = Math.atan2(to.y - from.y, to.x - from.x);
  return {
    length,
    pointAtDistance: (d) => pointAlong(from, to, d),
    headingAtDistance: () => heading
  };
}

function bezierSegment(p0: Point, p1: Point, p2: Point, sampleCount = 24): Segment {
  const points: Point[] = Array.from({ length: sampleCount + 1 }, (_, i) => {
    const t = i / sampleCount;
    return {
      x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t ** 2 * p2.x,
      y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t ** 2 * p2.y
    };
  });
  const cumLength = [0];
  for (let i = 1; i < points.length; i++) {
    cumLength.push(cumLength[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const length = cumLength[cumLength.length - 1];

  function locate(d: number): { a: Point; b: Point; localT: number } {
    const clamped = Math.max(0, Math.min(d, length));
    let idx = cumLength.findIndex((c) => c >= clamped);
    if (idx <= 0) idx = 1;
    const segStart = cumLength[idx - 1];
    const segEnd = cumLength[idx];
    const localT = segEnd > segStart ? (clamped - segStart) / (segEnd - segStart) : 0;
    return { a: points[idx - 1], b: points[idx], localT };
  }

  return {
    length,
    pointAtDistance: (d) => {
      const { a, b, localT } = locate(d);
      return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT };
    },
    headingAtDistance: (d) => {
      const { a, b } = locate(d);
      return Math.atan2(b.y - a.y, b.x - a.x);
    }
  };
}

function cornerPoint(dirA: Direction, dirB: Direction, halfWidth: number): Point {
  const xSign = dirA === "E" || dirB === "E" ? 1 : dirA === "W" || dirB === "W" ? -1 : 0;
  const ySign = dirA === "N" || dirB === "N" ? -1 : dirA === "S" || dirB === "S" ? 1 : 0;
  return { x: xSign * halfWidth, y: ySign * halfWidth };
}

const CLOSEST_PROGRESS_SAMPLE_STEP = 4;

function composePath(segments: Segment[], stopLineDistance: number): VehiclePath {
  const totalLength = segments.reduce((sum, s) => sum + s.length, 0);

  function locate(d: number): { segment: Segment; localD: number } {
    let remaining = Math.max(0, Math.min(d, totalLength));
    for (const segment of segments) {
      if (remaining <= segment.length) return { segment, localD: remaining };
      remaining -= segment.length;
    }
    const last = segments[segments.length - 1];
    return { segment: last, localD: last.length };
  }

  const pointAt = (d: number): Point => {
    const { segment, localD } = locate(d);
    return segment.pointAtDistance(localD);
  };

  // Precomputed once per path: a lookup table `closestProgress` uses to find how far along the
  // path the vehicle's *actual* physics position corresponds to. This exists so progress tracking
  // is closed-loop (derived from real position every tick) rather than open-loop (integrating
  // speed*dt) — an earlier version of this function used `distanceTraveled += speed * dt` in the
  // caller, which silently drifted from the vehicle's real position whenever steering introduced
  // any lateral/rotational velocity component (e.g. while braking hard near a stop line),
  // eventually reporting the vehicle as past the stop line when it physically wasn't. That broke
  // red-light compliance outright — caught only by actually running a multi-vehicle queueing
  // scenario, not by any unit test in isolation.
  const sampleCount = Math.max(1, Math.ceil(totalLength / CLOSEST_PROGRESS_SAMPLE_STEP));
  const samples: { distance: number; point: Point }[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const d = Math.min((i / sampleCount) * totalLength, totalLength);
    samples.push({ distance: d, point: pointAt(d) });
  }

  return {
    totalLength,
    stopLineDistance,
    pointAt,
    headingAt: (d) => {
      const { segment, localD } = locate(d);
      return segment.headingAtDistance(localD);
    },
    closestProgress: (position: Point, hint?: number): number => {
      // A curved (turning) path can fold back near itself in raw XY space — a corner's Bezier
      // bulge can sit geometrically close to a point on the straight entry segment. An
      // unconstrained global nearest-point search can therefore snap to the wrong arc-length
      // value (e.g. jumping past the stop line) whenever steering leaves the vehicle briefly
      // off-path. Searching only a local window around the previous tick's known progress makes
      // this self-correcting instead: it can't jump further than a vehicle could plausibly have
      // traveled in one tick.
      const SEARCH_WINDOW = 80;
      let candidates = samples;
      if (hint !== undefined) {
        const windowed = samples.filter((s) => Math.abs(s.distance - hint) <= SEARCH_WINDOW);
        if (windowed.length > 0) candidates = windowed;
      }

      let bestDistance = candidates[0].distance;
      let bestDistSq = Infinity;
      for (const sample of candidates) {
        const dx = sample.point.x - position.x;
        const dy = sample.point.y - position.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestDistance = sample.distance;
        }
      }
      return bestDistance;
    }
  };
}

export function buildVehiclePath(mapDef: MapDefinition, entryApproachId: string, exitApproachId: string): VehiclePath {
  const entry = mapDef.approaches.find((a) => a.id === entryApproachId)!;
  const exit = mapDef.approaches.find((a) => a.id === exitApproachId)!;

  const entryStart: Point = { x: entry.laneStartX, y: entry.laneStartY };
  const entryEnd: Point = { x: entry.laneEndX, y: entry.laneEndY }; // intersection center
  const exitEnd: Point = { x: exit.laneEndX, y: exit.laneEndY }; // same intersection center
  const exitStart: Point = { x: exit.laneStartX, y: exit.laneStartY };

  const entryLength = Math.hypot(entryEnd.x - entryStart.x, entryEnd.y - entryStart.y);
  const stopOffset = Math.min(STOP_LINE_OFFSET, entryLength / 2);

  const entryStopPoint = pointAlong(entryStart, entryEnd, entryLength - stopOffset);
  const exitStopPoint = pointAlong(exitEnd, exitStart, stopOffset);

  const isStraight = OPPOSITE[entry.direction] === exit.direction;
  const crossing: Segment = isStraight
    ? straightSegment(entryStopPoint, exitStopPoint)
    : bezierSegment(entryStopPoint, cornerPoint(entry.direction, exit.direction, (entry.width + exit.width) / 4), exitStopPoint);

  const segments = [straightSegment(entryStart, entryStopPoint), crossing, straightSegment(exitStopPoint, exitStart)];
  return composePath(segments, segments[0].length);
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `pnpm --filter sim-server test -- TurnPaths`
Expected: PASS (4 tests).

```bash
git add sim-server/src/vehicles/TurnPaths.ts sim-server/test/vehicles/TurnPaths.test.ts
git commit -m "feat(sim-server): TurnPaths derives straight or curved intersection paths from map geometry"
```

- [ ] **Step 5: Write the failing test for `TrafficSpawner`**

`sim-server/test/vehicles/TrafficSpawner.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mulberry32 } from "../../src/util/mulberry32";
import { TrafficSpawner } from "../../src/vehicles/TrafficSpawner";

describe("TrafficSpawner", () => {
  it("spawns roughly arrivalRatePerMin vehicles per approach over one simulated minute, deterministically for a fixed seed", () => {
    const spawner = new TrafficSpawner(["app_N"], mulberry32(1), 12); // 12/min = 1 every 5s on average
    let spawnCount = 0;
    for (let t = 0; t < 60_000; t += 100) spawnCount += spawner.step(100).length;
    expect(spawnCount).toBeGreaterThan(3);
    expect(spawnCount).toBeLessThan(30);
  });

  it("is deterministic for a fixed seed", () => {
    const run = () => {
      const spawner = new TrafficSpawner(["app_N", "app_S"], mulberry32(99), 12);
      const events: string[] = [];
      for (let t = 0; t < 30_000; t += 100) events.push(...spawner.step(100));
      return events;
    };
    expect(run()).toEqual(run());
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- TrafficSpawner`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `TrafficSpawner`**

`sim-server/src/vehicles/TrafficSpawner.ts`:
```ts
export class TrafficSpawner {
  private readonly nextArrivalMs = new Map<string, number>();

  constructor(
    private readonly approachIds: string[],
    private readonly rng: () => number,
    private readonly arrivalRatePerMinPerApproach: number
  ) {
    for (const id of approachIds) this.nextArrivalMs.set(id, this.sampleInterArrivalMs());
  }

  private sampleInterArrivalMs(): number {
    const meanMs = 60_000 / this.arrivalRatePerMinPerApproach;
    const u = Math.max(this.rng(), 1e-9);
    return -Math.log(u) * meanMs;
  }

  step(dtMs: number): string[] {
    const spawns: string[] = [];
    for (const id of this.approachIds) {
      const remaining = this.nextArrivalMs.get(id)! - dtMs;
      if (remaining <= 0) {
        spawns.push(id);
        this.nextArrivalMs.set(id, this.sampleInterArrivalMs());
      } else {
        this.nextArrivalMs.set(id, remaining);
      }
    }
    return spawns;
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- TrafficSpawner`
Expected: PASS.

- [ ] **Step 9: Write the failing test for `TrafficController`**

`sim-server/test/vehicles/TrafficController.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { TrafficController } from "../../src/vehicles/TrafficController";
import { mulberry32 } from "../../src/util/mulberry32";

// vehicleLength must match (or exceed) VehicleBody's real Matter.js rectangle length (36 units),
// not the smaller example value used in IdmController.test.ts's formula-only unit test. Getting
// this wrong doesn't fail any test in isolation — it only shows up once real vehicles queue
// behind each other: IDM packs them far closer together than their actual physical bodies, so
// Matter's collision response shoves the overlapping rectangles apart, punching the front car
// through a red light. Found by actually running a multi-vehicle queueing scenario, not by
// reasoning about the code.
const IDM_PARAMS = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 40 };
const ALL_GREEN = new Map([
  ["app_N", "green"], ["app_S", "green"], ["app_E", "green"], ["app_W", "green"]
] as const);
const RED_FOR_N = new Map([
  ["app_N", "red"], ["app_S", "green"], ["app_E", "green"], ["app_W", "green"]
] as const);
const YELLOW_FOR_N = new Map([
  ["app_N", "yellow"], ["app_S", "red"], ["app_E", "red"], ["app_W", "red"]
] as const);

describe("TrafficController", () => {
  it("spawns vehicles over time and assigns each a real entry/exit movement, not just straight-through", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(1), 200, () => {});

    for (let i = 0; i < 200; i++) {
      world.step(50);
      controller.step(50, ALL_GREEN);
    }

    const movements = controller.vehicleMovements();
    expect(movements.length).toBeGreaterThan(0);
    const distinctExitsFromN = new Set(movements.filter((m) => m.entryApproachId === "app_N").map((m) => m.exitApproachId));
    // Over enough spawns from app_N, expect to see more than just the straight-through exit (app_S).
    expect(distinctExitsFromN.size).toBeGreaterThan(1);
  });

  it("holds a vehicle at the stop line when its approach's phase is red, with no real leader ahead", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(2), 120, () => {});

    for (let i = 0; i < 400; i++) {
      world.step(50);
      controller.step(50, RED_FOR_N);
    }

    const nCar = controller.vehicles.find((v) => v.id.startsWith("car_app_N_"));
    expect(nCar).toBeDefined();
    expect(nCar!.body.position.y).toBeLessThan(-10);
    expect(Math.hypot(nCar!.body.velocity.x, nCar!.body.velocity.y)).toBeLessThan(1);
  });

  it("on yellow, a vehicle still far from the stop line brakes rather than committing to the intersection", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(4), 120, () => {});

    // Single tick after spawn: vehicle is still essentially at laneStart, far from the stop line.
    world.step(50);
    controller.step(50, YELLOW_FOR_N);
    for (let i = 0; i < 300; i++) {
      world.step(50);
      controller.step(50, YELLOW_FOR_N);
    }

    const nCar = controller.vehicles.find((v) => v.id.startsWith("car_app_N_"));
    expect(nCar).toBeDefined();
    expect(Math.hypot(nCar!.body.velocity.x, nCar!.body.velocity.y)).toBeLessThan(1);
  });

  it("despawns a vehicle once it reaches the far end of its assigned exit approach, not the intersection center", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const controller = new TrafficController(world, map, IDM_PARAMS, mulberry32(3), 120, () => {});

    for (let i = 0; i < 1500; i++) {
      world.step(50);
      controller.step(50, ALL_GREEN);
    }

    // A steady-state population well below what 1500 ticks of spawning would produce without despawn
    // is the observable evidence that vehicles are completing their (possibly curved) path and leaving.
    expect(controller.vehicles.length).toBeLessThan(40);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- TrafficController`
Expected: FAIL, module not found.

- [ ] **Step 11: Implement `TrafficController`**

`sim-server/src/vehicles/TrafficController.ts`:
```ts
import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import type { MapDefinition, Direction } from "../maps/MapDefinition";
import { VehicleBody } from "./VehicleBody";
import { idmAcceleration, type IdmParams, type IdmState } from "./IdmController";
import { TrafficSpawner } from "./TrafficSpawner";
import { buildVehiclePath, type VehiclePath } from "./TurnPaths";

const MAX_VEHICLES_PER_APPROACH = 8;
const LOOKAHEAD_DISTANCE = 20;
const OPPOSITE: Record<Direction, Direction> = { N: "S", S: "N", E: "W", W: "E" };

type SignalState = "green" | "yellow" | "red";

interface Tracked {
  body: VehicleBody;
  entryApproachId: string;
  exitApproachId: string;
  path: VehiclePath;
  distanceTraveled: number;
}

function pickExitApproachId(entryApproachId: string, mapDef: MapDefinition, rng: () => number): string {
  const entry = mapDef.approaches.find((a) => a.id === entryApproachId)!;
  const others = mapDef.approaches.filter((a) => a.id !== entryApproachId);
  const straightExit = others.find((a) => a.direction === OPPOSITE[entry.direction])!;
  const turnExits = others.filter((a) => a.id !== straightExit.id);

  const r = rng();
  if (r < 0.5 || turnExits.length === 0) return straightExit.id;
  return r < 0.75 ? turnExits[0].id : (turnExits[1]?.id ?? turnExits[0].id);
}

export class TrafficController {
  private readonly tracked = new Map<string, Tracked>();
  private spawner: TrafficSpawner;
  private spawnCounter = 0;

  constructor(
    private readonly world: PhysicsWorld,
    private readonly mapDef: MapDefinition,
    private readonly idmParams: IdmParams,
    private readonly rng: () => number,
    arrivalRatePerMinPerApproach: number,
    private readonly onSpawn: (vehicle: VehicleBody) => void
  ) {
    this.spawner = new TrafficSpawner(mapDef.approaches.map((a) => a.id), rng, arrivalRatePerMinPerApproach);
  }

  setArrivalRate(ratePerMinPerApproach: number): void {
    this.spawner = new TrafficSpawner(this.mapDef.approaches.map((a) => a.id), this.rng, ratePerMinPerApproach);
  }

  step(dtMs: number, approachSignalStates: Map<string, SignalState>): void {
    for (const entryApproachId of this.spawner.step(dtMs)) {
      const queuedOnApproach = [...this.tracked.values()].filter((t) => t.entryApproachId === entryApproachId).length;
      if (queuedOnApproach >= MAX_VEHICLES_PER_APPROACH) continue;

      const exitApproachId = pickExitApproachId(entryApproachId, this.mapDef, this.rng);
      const path = buildVehiclePath(this.mapDef, entryApproachId, exitApproachId);
      const entry = this.mapDef.approaches.find((a) => a.id === entryApproachId)!;
      const heading = Math.atan2(entry.laneEndY - entry.laneStartY, entry.laneEndX - entry.laneStartX);

      const id = `car_${entryApproachId}_${this.spawnCounter++}`;
      const vehicle = new VehicleBody(this.world, id, { x: entry.laneStartX, y: entry.laneStartY, heading });
      vehicle.controller = "idm";
      this.tracked.set(id, { body: vehicle, entryApproachId, exitApproachId, path, distanceTraveled: 0 });
      this.onSpawn(vehicle);
    }

    for (const [id, entry] of [...this.tracked.entries()]) {
      if (entry.body.controller !== "idm") continue;

      // Closed-loop progress: always derived from the vehicle's real physics position, never
      // accumulated from speed*dt (see TurnPaths.closestProgress for why that drifted). The
      // previous tick's value is passed as a hint so the search stays local.
      entry.distanceTraveled = entry.path.closestProgress(
        { x: entry.body.body.position.x, y: entry.body.body.position.y },
        entry.distanceTraveled
      );

      const speed = Math.hypot(entry.body.body.velocity.x, entry.body.body.velocity.y);

      const ahead = [...this.tracked.values()]
        .filter(
          (t) =>
            t !== entry &&
            t.entryApproachId === entry.entryApproachId &&
            t.exitApproachId === entry.exitApproachId &&
            t.distanceTraveled > entry.distanceTraveled
        )
        .sort((a, b) => a.distanceTraveled - b.distanceTraveled)[0];

      let leader: IdmState | null = ahead
        ? { position: ahead.distanceTraveled, speed: Math.hypot(ahead.body.body.velocity.x, ahead.body.body.velocity.y) }
        : null;

      if (entry.distanceTraveled < entry.path.stopLineDistance) {
        const signalState = approachSignalStates.get(entry.entryApproachId) ?? "red";
        const distanceToStopLine = entry.path.stopLineDistance - entry.distanceTraveled;

        if (signalState === "red") {
          if (!leader || leader.position > entry.path.stopLineDistance) {
            leader = { position: entry.path.stopLineDistance, speed: 0 };
          }
        } else if (signalState === "yellow") {
          // Dilemma zone: only insert the virtual stop-line leader if the vehicle can still brake
          // to a stop in time; otherwise it's already committed and should clear the intersection.
          const brakingDistance = (speed * speed) / (2 * this.idmParams.b);
          const canStopSafely = brakingDistance <= distanceToStopLine;
          if (canStopSafely && (!leader || leader.position > entry.path.stopLineDistance)) {
            leader = { position: entry.path.stopLineDistance, speed: 0 };
          }
        }
        // signalState === "green": no virtual leader, proceed normally.
      }
      // Once past the stop line, the vehicle is committed — no further signal check, ever.

      const accel = idmAcceleration({ position: entry.distanceTraveled, speed }, leader, this.idmParams);
      const throttle = Math.max(0, Math.min(1, accel / this.idmParams.aMax));
      const brake = Math.max(0, Math.min(1, -accel / this.idmParams.b));

      const lookaheadDistance = Math.min(entry.distanceTraveled + LOOKAHEAD_DISTANCE, entry.path.totalLength);
      const targetPoint = entry.path.pointAt(lookaheadDistance);
      const desiredHeading = Math.atan2(
        targetPoint.y - entry.body.body.position.y,
        targetPoint.x - entry.body.body.position.x
      );
      const headingError = Math.atan2(Math.sin(desiredHeading - entry.body.body.angle), Math.cos(desiredHeading - entry.body.body.angle));
      const steer = Math.max(-1, Math.min(1, headingError / (Math.PI / 4)));

      entry.body.applyInput(throttle, brake, steer);

      if (entry.distanceTraveled >= entry.path.totalLength - 1) {
        Matter.Composite.remove(this.world.engine.world, entry.body.body);
        this.tracked.delete(id);
      }
    }
  }

  get vehicles(): VehicleBody[] {
    return [...this.tracked.values()].map((t) => t.body);
  }

  claimableVehicle(): VehicleBody | null {
    for (const t of this.tracked.values()) if (t.body.controller === "idm") return t.body;
    return null;
  }

  vehicleMovements(): Array<{ id: string; entryApproachId: string; exitApproachId: string }> {
    return [...this.tracked.entries()].map(([id, t]) => ({ id, entryApproachId: t.entryApproachId, exitApproachId: t.exitApproachId }));
  }
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- TrafficController`
Expected: PASS (4 tests). If the movement-variety test fails, check `pickExitApproachId`'s thresholds against `mulberry32(1)`'s actual sequence — with only 3 possible exits and a modest sample size, a fixed seed could plausibly (if unluckily chosen) land on all-straight; if so, try a different seed or increase the spawn count in the test rather than changing the 50/25/25 weighting itself.

- [ ] **Step 13: Commit**

```bash
git add sim-server/src/vehicles/TrafficController.ts sim-server/test/vehicles/TrafficController.test.ts
git commit -m "feat(sim-server): TrafficController assigns real turning movements and applies a yellow dilemma-zone rule"
```

---

### Task 4: `RoomManager` — claim, leave, bounded disconnect recovery

**Files:**
- Create: `sim-server/src/room/RoomManager.ts`
- Test: `sim-server/test/room/RoomManager.test.ts`

**Interfaces:**
- Consumes: `VehicleBody` (controller field from Task 2), `TrafficController.claimableVehicle()` (Task 3).
- Produces (Interface ledger, Phase 3): `class RoomManager` — `constructor(getClaimableVehicle: () => VehicleBody | null, maxHumanCars: number, disconnectGraceMs: number)`, `.join(clientId: string): { carId: string } | { error: "capacity_reached" }`, `.leave(clientId: string): void`, `.step(dtMs: number): void`, `.ownerOf(carId: string): string | null`.

- [ ] **Step 1: Write the failing test**

`sim-server/test/room/RoomManager.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RoomManager } from "../../src/room/RoomManager";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";

function makeCars(n: number) {
  const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
  return Array.from({ length: n }, (_, i) => new VehicleBody(world, `car_${i}`, { x: 0, y: 0, heading: 0 }));
}

describe("RoomManager", () => {
  it("claims an available IDM-controlled car on join, flipping its controller to user", () => {
    const [car] = makeCars(1);
    const room = new RoomManager(() => (car.controller === "idm" ? car : null), 4, 3000);

    const result = room.join("client_1");
    expect(result).toEqual({ carId: "car_0" });
    expect(car.controller).toBe("user");
    expect(room.ownerOf("car_0")).toBe("client_1");
  });

  it("returns capacity_reached when no claimable car is available", () => {
    const room = new RoomManager(() => null, 4, 3000);
    expect(room.join("client_1")).toEqual({ error: "capacity_reached" });
  });

  it("does not immediately revert control on leave — waits out the grace period", () => {
    const [car] = makeCars(1);
    const room = new RoomManager(() => (car.controller === "idm" ? car : null), 4, 3000);
    room.join("client_1");

    room.leave("client_1");
    room.step(1000);
    expect(car.controller).toBe("user");

    room.step(2500); // total 3500ms > 3000ms grace
    expect(car.controller).toBe("idm");
    expect(room.ownerOf("car_0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- RoomManager`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `RoomManager`**

`sim-server/src/room/RoomManager.ts`:
```ts
import type { VehicleBody } from "../vehicles/VehicleBody";

interface Claim {
  clientId: string;
  car: VehicleBody;
  pendingRevertMs: number | null;
}

export class RoomManager {
  private readonly claimsByCarId = new Map<string, Claim>();
  private readonly carIdByClientId = new Map<string, string>();

  constructor(
    private readonly getClaimableVehicle: () => VehicleBody | null,
    private readonly maxHumanCars: number,
    private readonly disconnectGraceMs: number
  ) {}

  join(clientId: string): { carId: string } | { error: "capacity_reached" } {
    if (this.claimsByCarId.size >= this.maxHumanCars) return { error: "capacity_reached" };

    const car = this.getClaimableVehicle();
    if (!car) return { error: "capacity_reached" };

    car.controller = "user";
    this.claimsByCarId.set(car.id, { clientId, car, pendingRevertMs: null });
    this.carIdByClientId.set(clientId, car.id);
    return { carId: car.id };
  }

  leave(clientId: string): void {
    const carId = this.carIdByClientId.get(clientId);
    if (!carId) return;
    const claim = this.claimsByCarId.get(carId);
    if (claim) claim.pendingRevertMs = 0;
  }

  step(dtMs: number): void {
    for (const [carId, claim] of [...this.claimsByCarId.entries()]) {
      if (claim.pendingRevertMs === null) continue;
      claim.pendingRevertMs += dtMs;
      if (claim.pendingRevertMs >= this.disconnectGraceMs) {
        claim.car.controller = "idm";
        this.claimsByCarId.delete(carId);
        this.carIdByClientId.delete(claim.clientId);
      }
    }
  }

  ownerOf(carId: string): string | null {
    return this.claimsByCarId.get(carId)?.clientId ?? null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- RoomManager`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sim-server/src/room/RoomManager.ts sim-server/test/room/RoomManager.test.ts
git commit -m "feat(sim-server): RoomManager with claim/leave and bounded disconnect-to-IDM recovery"
```

---

### Task 5: Collision logging — `CollisionEvent` + `RoomEventMessage` broadcast

**Files:**
- Modify: `sim-server/src/session/SessionEvent.ts` (extend `SessionEvent` union)
- Create: `sim-server/src/physics/CollisionLogger.ts`
- Test: `sim-server/test/physics/CollisionLogger.test.ts`

**Interfaces:**
- Produces (Interface ledger, Phase 3): `CollisionEvent` extends `SessionEvent`; `class CollisionLogger` — `constructor(world: PhysicsWorld, onCollision: (entities: [string, string]) => void)`.

- [ ] **Step 1: Extend `SessionEvent`**

Modify `sim-server/src/session/SessionEvent.ts`:
```ts
export interface UserJoinEvent {
  t: number;
  type: "user_join";
  clientId: string;
  carId: string;
}

export interface UserLeaveEvent {
  t: number;
  type: "user_leave";
  clientId: string;
  carId: string;
}

export interface CollisionEvent {
  t: number;
  type: "collision";
  entities: [string, string];
  kind: "vehicle_vehicle" | "vehicle_pedestrian";
  cause?: "jaywalk";
}

// Phase 7 adds: EvSpawnEvent | EvPreemptEvent
export type SessionEvent = PhaseChangeEvent | UserJoinEvent | UserLeaveEvent | CollisionEvent;
```

- [ ] **Step 2: Write the failing test for `CollisionLogger`**

`sim-server/test/physics/CollisionLogger.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { CollisionLogger } from "../../src/physics/CollisionLogger";

describe("CollisionLogger", () => {
  it("reports the two vehicle ids when their bodies collide", () => {
    const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
    const onCollision = vi.fn();
    new CollisionLogger(world, onCollision);

    const carA = new VehicleBody(world, "car_a", { x: -20, y: 0, heading: 0 });
    const carB = new VehicleBody(world, "car_b", { x: 20, y: 0, heading: Math.PI });
    carA.applyInput(1, 0, 0);
    carB.applyInput(1, 0, 0);

    for (let i = 0; i < 60; i++) world.step(16);

    expect(onCollision).toHaveBeenCalled();
    const [entities] = onCollision.mock.calls[0];
    expect(new Set(entities)).toEqual(new Set(["car_a", "car_b"]));
  });

  it("does not fire for a vehicle passing over a non-solid queue-detection sensor", () => {
    const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
    const onCollision = vi.fn();
    new CollisionLogger(world, onCollision);

    const car = new VehicleBody(world, "car_1", { x: 0, y: -30, heading: Math.PI / 2 });
    car.applyInput(1, 0, 0);
    for (let i = 0; i < 30; i++) world.step(16);

    expect(onCollision).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- CollisionLogger`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `CollisionLogger`**

`sim-server/src/physics/CollisionLogger.ts`:
```ts
import Matter from "matter-js";
import type { PhysicsWorld } from "./PhysicsWorld";

export class CollisionLogger {
  constructor(world: PhysicsWorld, onCollision: (entities: [string, string]) => void) {
    Matter.Events.on(world.engine, "collisionStart", (event) => {
      for (const pair of event.pairs) {
        const [a, b] = [pair.bodyA, pair.bodyB];
        if (a.isSensor || b.isSensor) continue;
        if (!a.label.startsWith("vehicle_") || !b.label.startsWith("vehicle_")) continue;
        onCollision([a.label.replace("vehicle_", ""), b.label.replace("vehicle_", "")]);
      }
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- CollisionLogger`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add sim-server/src/session/SessionEvent.ts sim-server/src/physics/CollisionLogger.ts sim-server/test/physics/CollisionLogger.test.ts
git commit -m "feat(sim-server): CollisionLogger distinguishes real vehicle collisions from sensor overlaps"
```

---

### Task 6: `SimSession` — replaces `SingleCarSession`; wires everything together for N clients

**Files:**
- Delete: `sim-server/src/room/SingleCarSession.ts`, `sim-server/test/server.integration.test.ts` (superseded by this task's version)
- Create: `sim-server/src/room/SimSession.ts`
- Create: `sim-server/test/room/SimSession.test.ts`
- Modify: `sim-server/src/server.ts` (multi-client: per-connection `clientId`, join/leave routing, ownership-checked input)

**Interfaces:**
- Consumes: everything from Tasks 1-5, plus `SignalController`/`QueueDetector`/`SessionStore` (Phase 2).
- Produces: `class SimSession` — `constructor(mapPath: string, sessionStore: SessionStore, aiServiceUrl: string, arrivalRatePerMin: number, rngSeed: number)`, `.join(clientId): { carId: string } | { error: "capacity_reached" }`, `.leave(clientId): void`, `.applyInput(clientId, carId, throttle, brake, steer): void`, `.step(): Promise<{ snapshot: ServerStateSnapshot; roomEvents: RoomEventMessage[] }>`.

- [ ] **Step 1: Implement `SimSession`**

`sim-server/src/room/SimSession.ts`:
```ts
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { loadMap } from "../maps/loadMap";
import { TrafficController } from "../vehicles/TrafficController";
import { RoomManager } from "./RoomManager";
import { QueueDetector } from "../signals/QueueDetector";
import { AiSignalClient } from "../signals/AiSignalClient";
import { SignalController } from "../signals/SignalController";
import { CollisionLogger } from "../physics/CollisionLogger";
import { LocalDiskSessionStore } from "../session/LocalDiskSessionStore";
import type { SessionStore } from "../session/SessionStore";
import type { ServerStateSnapshot } from "shared-contracts/generated/ts/state-snapshot.schema";
import type { RoomEventMessage } from "shared-contracts/generated/ts/room-events.schema";
import { mulberry32 } from "../util/mulberry32";
import { randomUUID } from "node:crypto";

const TICK_MS = 50;
const MAX_HUMAN_CARS = 4;
const DISCONNECT_GRACE_MS = 3000;
const IDM_PARAMS = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 40 };

export class SimSession {
  readonly sessionId = randomUUID();
  private readonly world: PhysicsWorld;
  private readonly traffic: TrafficController;
  private readonly room: RoomManager;
  private readonly detector: QueueDetector;
  private readonly signalController: SignalController;
  private readonly store: SessionStore;
  private readonly mapId: string;
  private pendingRoomEvents: RoomEventMessage[] = [];
  private tick = 0;

  constructor(
    mapPath: string,
    sessionStore: SessionStore | undefined,
    aiServiceUrl: string,
    arrivalRatePerMin: number,
    rngSeed: number
  ) {
    const map = loadMap(mapPath);
    this.mapId = map.id;
    this.world = new PhysicsWorld(map);
    this.detector = new QueueDetector(this.world, map.approaches);
    this.signalController = new SignalController(
      map.intersections[0].phases,
      new AiSignalClient(aiServiceUrl),
      this.detector,
      map.intersections[0].id
    );
    this.traffic = new TrafficController(this.world, map, IDM_PARAMS, mulberry32(rngSeed), arrivalRatePerMin, () => {});
    this.room = new RoomManager(() => this.traffic.claimableVehicle(), MAX_HUMAN_CARS, DISCONNECT_GRACE_MS);
    this.store = sessionStore ?? new LocalDiskSessionStore(process.env.SESSION_STORE_DIR ?? "./sessions");
    this.store.create(this.sessionId, { mapId: this.mapId, scenario: null });

    new CollisionLogger(this.world, (entities) => {
      this.store.writeEvent(this.sessionId, { t: this.tick * (TICK_MS / 1000), type: "collision", entities, kind: "vehicle_vehicle" });
      this.pendingRoomEvents.push({ type: "room_event", ts: Date.now(), payload: { kind: "collision", entities, collisionKind: "vehicle_vehicle" } });
    });
  }

  join(clientId: string): { carId: string } | { error: "capacity_reached" } {
    const result = this.room.join(clientId);
    if ("carId" in result) {
      this.store.writeEvent(this.sessionId, { t: this.tick * (TICK_MS / 1000), type: "user_join", clientId, carId: result.carId });
      this.pendingRoomEvents.push({ type: "room_event", ts: Date.now(), payload: { kind: "user_join", clientId, carId: result.carId } });
    }
    return result;
  }

  leave(clientId: string): void {
    this.room.leave(clientId);
  }

  applyInput(clientId: string, carId: string, throttle: number, brake: number, steer: number): void {
    if (this.room.ownerOf(carId) !== clientId) return; // not this client's car — ignore
    const vehicle = this.traffic.vehicles.find((v) => v.id === carId);
    vehicle?.applyInput(throttle, brake, steer);
  }

  async step(): Promise<{ snapshot: ServerStateSnapshot; roomEvents: RoomEventMessage[] }> {
    this.world.step(TICK_MS);
    this.detector.step(TICK_MS, this.traffic.vehicles);
    this.room.step(TICK_MS);

    const { phaseId, controller } = await this.signalController.step(TICK_MS);
    const approachSignalStates = this.signalController.getApproachSignalStates();

    this.traffic.step(TICK_MS, approachSignalStates);
    this.tick += 1;

    const roomEvents = this.pendingRoomEvents;
    this.pendingRoomEvents = [];

    return {
      snapshot: {
        type: "state",
        ts: Date.now(),
        payload: {
          tick: this.tick,
          vehicles: this.traffic.vehicles.map((v) => ({
            id: v.id,
            x: v.body.position.x,
            y: v.body.position.y,
            heading: v.body.angle,
            speed: Math.hypot(v.body.velocity.x, v.body.velocity.y),
            controller: v.controller
          })),
          signals: [
            {
              intersectionId: "int_1",
              phase: phaseId,
              msRemainingMin: Math.max(0, 4000 - this.signalController.timeInPhaseMs),
              light: approachSignalStates.get("app_N") ?? "red"
            }
          ]
        }
      },
      roomEvents
    };
  }
}
```

**Correction while implementing Step 1** (caught during the self-review pass, fixed here rather than left as a bug): an earlier draft of this class had a private `greenApproachIds(phaseId)` helper re-deriving per-approach green/red from the phase id via a hardcoded direction map — duplicating logic `SignalController` already owns, and using a bracket-indexed private-field read (`this.signalController["phases"]`) that doesn't even compile. Both are gone: `SignalController.getApproachSignalStates()` (Phase 2, Task 6) is the single source of truth for per-approach light state, and `SimSession` just asks for it once per tick and hands the same `Map` to `TrafficController.step()` (this file) and, from Phase 5 onward, `PedestrianController.step()` too. `TrafficController`'s constructor also now takes the whole `MapDefinition` (`map`), not just `map.approaches` — it needs full map access for `TurnPaths` (Task 3).

- [ ] **Step 2: Write the failing test for `SimSession`**

`sim-server/test/room/SimSession.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("SimSession", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "simsession-test-"));
    store = new LocalDiskSessionStore(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("allows up to MAX_HUMAN_CARS clients to join, then reports capacity_reached", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 120, 1);

    // Prime enough IDM traffic to have claimable cars.
    for (let i = 0; i < 200; i++) await session.step();

    const results = [session.join("c1"), session.join("c2"), session.join("c3"), session.join("c4")];
    for (const r of results) expect(r).toHaveProperty("carId");

    const fifth = session.join("c5");
    expect(fifth).toEqual({ error: "capacity_reached" });
  });

  it("records a user_join event in the session file", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 120, 2);
    for (let i = 0; i < 200; i++) await session.step();

    session.join("c1");
    await session.step();

    const file = store.read(session.sessionId);
    expect(file.events.some((e) => e.type === "user_join")).toBe(true);
  });

  it("ignores input from a client that does not own the target car", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 120, 3);
    for (let i = 0; i < 200; i++) await session.step();
    session.join("c1");

    expect(() => session.applyInput("attacker", "some_car_id", 1, 0, 0)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- SimSession`
Expected: FAIL until Step 1's implementation (with the correction applied) is in place.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- SimSession`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewire `server.ts` for multiple clients**

Modify `sim-server/src/server.ts`:
```ts
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { SimSession } from "./room/SimSession";
import type { ClientInputMessage } from "shared-contracts/generated/ts/client-input.schema";

const PORT = Number(process.env.PORT ?? 8080);
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });
const session = new SimSession(
  "../../maps/grid_1x1_v1.json",
  undefined,
  process.env.AI_SERVICE_URL ?? "http://localhost:8000",
  Number(process.env.ARRIVAL_RATE_PER_MIN ?? 30),
  Number(process.env.SIM_RNG_SEED ?? Date.now())
);
const socketsByClientId = new Map<string, import("ws").WebSocket>();

wss.on("connection", (socket) => {
  const clientId = randomUUID();
  socketsByClientId.set(clientId, socket);
  const joinResult = session.join(clientId);
  socket.send(JSON.stringify({ type: "joined", ts: Date.now(), payload: joinResult }));

  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ClientInputMessage;
    if (msg.type === "input") {
      session.applyInput(clientId, msg.payload.carId, msg.payload.throttle, msg.payload.brake, msg.payload.steer);
    }
  });

  socket.on("close", () => {
    session.leave(clientId);
    socketsByClientId.delete(clientId);
  });
});

setInterval(async () => {
  const { snapshot, roomEvents } = await session.step();
  const statePayload = JSON.stringify(snapshot);
  for (const socket of socketsByClientId.values()) {
    if (socket.readyState === socket.OPEN) socket.send(statePayload);
  }
  for (const event of roomEvents) {
    const payload = JSON.stringify(event);
    for (const socket of socketsByClientId.values()) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }
}, 50);

httpServer.listen(PORT, () => {
  console.log(`sim-server listening on :${PORT}`);
});
```

- [ ] **Step 6: Delete the superseded Phase-1 files and re-run the full sim-server suite**

```bash
rm sim-server/src/room/SingleCarSession.ts sim-server/test/server.integration.test.ts
```

Run: `pnpm --filter sim-server test`
Expected: PASS across every remaining test file — nothing else imported `SingleCarSession`.

- [ ] **Step 7: Commit**

```bash
git add -A sim-server/src/room sim-server/test/room sim-server/src/server.ts
git commit -m "feat(sim-server): SimSession replaces SingleCarSession; multi-client room join/leave/claim wired into server.ts"
```

---

### Task 7: Physics-determinism harness

**Files:**
- Create: `sim-server/test/determinism/collisionDeterminism.test.ts`

**Interfaces:**
- Consumes: `SimSession` (Task 6), `mulberry32` (Task 2).
- Produces: nothing new — first entry in the spec §11 "physics/determinism" pyramid layer.

- [ ] **Step 1: Write the determinism test**

`sim-server/test/determinism/collisionDeterminism.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";
import { vi } from "vitest";

async function runAndCollectCollisionEvents(seed: number, dir: string): Promise<unknown[]> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) })
  );
  const store = new LocalDiskSessionStore(dir);
  const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 300, seed);
  for (let i = 0; i < 2000; i++) await session.step();
  const file = store.read(session.sessionId);
  vi.restoreAllMocks();
  return file.events.filter((e) => e.type === "collision");
}

describe("physics determinism", () => {
  it("produces identical collision event sequences run-to-run given the same seed and inputs", async () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "determinism-a-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "determinism-b-"));

    const eventsA = await runAndCollectCollisionEvents(1234, dirA);
    const eventsB = await runAndCollectCollisionEvents(1234, dirB);

    expect(eventsA).toEqual(eventsB);

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter sim-server test -- collisionDeterminism`
Expected: PASS. `TrafficController`'s spawn-id generation (Task 3) already uses a per-controller incrementing `spawnCounter`, specifically to avoid the `Math.random()`/`Date.now()` class of determinism bug this test is designed to catch — if this test does fail, check for any *other* place a real-time or random source might have crept in (e.g. `PedestrianController`, once Phase 5 exists, or a future edit to `TrafficController` that reintroduces one), not this file.

- [ ] **Step 3: Commit**

```bash
git add sim-server/test/determinism sim-server/src/vehicles/TrafficController.ts
git commit -m "test(sim-server): add physics-determinism harness; fix non-deterministic spawn IDs"
```

---

### Task 8: `integration` CI job (docker-compose, both services)

**Files:**
- Create: `sim-server/test/integration/multiClient.integration.test.ts`
- Modify: `.github/workflows/ci.yml` (add `integration` job — `00-overview.md` §5 phase-3 row)

**Interfaces:**
- Consumes: a live `ai-service` (via `infra/docker-compose.yml`, already extended in Phase 2 Task 7) and `SimSession`/`server.ts` (Task 6).
- Produces: nothing new — CI wiring + the test that job runs.

- [ ] **Step 1: Write the multi-client integration test (runs against a real running sim-server + ai-service, not mocks)**

`sim-server/test/integration/multiClient.integration.test.ts`:
```ts
// Requires: `ai-service` running on :8000 and `sim-server` built+running on :8080
// (docker compose -f infra/docker-compose.yml up), or run manually per Step 3 below.
import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";

const SIM_URL = process.env.SIM_SERVER_URL ?? "ws://localhost:8080";

function connectAndAwaitJoin(): Promise<any> {
  // The "joined" message listener must be attached before (or at latest, synchronously with)
  // socket creation — the server sends "joined" immediately on connection, and on a fast
  // localhost round-trip it can arrive before an `await`-delayed listener registration ever
  // happens, silently dropping the message (EventEmitters don't replay past events to late
  // listeners). An earlier version of this test attached the message listener only after
  // `await`-ing both sockets' "open" events separately, which timed out in practice for exactly
  // this reason — attaching it in the same synchronous tick as `new WebSocket(...)` avoids the
  // race entirely.
  return new Promise((resolve) => {
    const socket = new WebSocket(SIM_URL);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "joined") resolve({ socket, msg });
    });
  });
}

describe.skipIf(!process.env.RUN_INTEGRATION)("multi-client room join/leave/claim (integration)", () => {
  it("two clients joining receive distinct car ids and each other's join events", async () => {
    const [{ socket: clientA, msg: joinedA }, { socket: clientB, msg: joinedB }] = await Promise.all([
      connectAndAwaitJoin(),
      connectAndAwaitJoin()
    ]);

    expect(joinedA.payload.carId).toBeDefined();
    expect(joinedB.payload.carId).toBeDefined();
    expect(joinedA.payload.carId).not.toBe(joinedB.payload.carId);

    clientA.close();
    clientB.close();
  }, 15000);
});
```

- [ ] **Step 2: Add the CI job**

Append to `.github/workflows/ci.yml`:
```yaml
  integration:
    runs-on: ubuntu-latest
    needs: [unit-ts, unit-py]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: "pnpm" }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install uv
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter shared-contracts generate
      - run: docker compose -f infra/docker-compose.yml up -d ai-service sim-server
      - run: sleep 3
      - name: Wait for services
        run: |
          for i in {1..20}; do curl -sf http://localhost:8000/health && break || sleep 1; done
      - run: RUN_INTEGRATION=1 pnpm --filter sim-server test -- multiClient.integration
      - if: always()
        run: docker compose -f infra/docker-compose.yml down
```

- [ ] **Step 3: Run it locally to confirm before relying on CI**

Run: `docker compose -f infra/docker-compose.yml up --build -d ai-service sim-server && RUN_INTEGRATION=1 pnpm --filter sim-server test -- multiClient.integration; docker compose -f infra/docker-compose.yml down`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add sim-server/test/integration .github/workflows/ci.yml
git commit -m "test: add multi-client join integration test; wire docker-compose integration CI job"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes | `mulberry32`, `TrafficSpawner`, `TrafficController` (spawn/stop-at-red/despawn), `RoomManager` (claim/leave/grace), `CollisionLogger` |
| Integration | Yes (first CI-gated job) | Multi-client join over a real WS connection to a real `sim-server` + `ai-service` pair, docker-composed |
| Physics/determinism | Yes (first entry) | Identical seed/inputs → identical collision-event sequence |
| Load | Not yet | Phase 8 (this phase's traffic volume is still small: 4 approaches × a modest arrival rate) |
| RL regression | N/A | Phase 6 |
| E2E | Manual only | Two browser tabs joining and both driving without freezing on disconnect |

## Definition of Done

- [ ] `integration` CI job green in addition to all Phase 1-2 jobs.
- [ ] Continuous IDM traffic visibly queues at red and proceeds at green in the manual smoke test.
- [ ] Two simultaneous browser clients can each claim a different car; a 5th simultaneous join attempt is rejected with `capacity_reached`.
- [ ] Closing one browser tab causes that car to keep moving under IDM control after ~3 seconds, never freezing in place.
- [ ] Driving two cars into each other produces a visible physical deflection (not clipping), and a `collision` event appears in the session JSON.
- [ ] `collisionDeterminism.test.ts` passes.
- [ ] Every file in the Interface ledger's "From Phase 3" section (`00-overview.md` §6, corrected per this phase's Task 1/Task 6) exists with the exact signature listed.

## Risks / open implementation notes

- **Ledger correction required:** this phase's actual `RoomEventMessage` design (Task 1) is a single discriminated-union WS message, not the three separate `UserJoinEvent`/`UserLeaveEvent`/`CarClaimEvent` types sketched in `00-overview.md` §6 before this phase was written. Apply the correction listed in that section during the overview's post-hoc consistency pass (tracked in this plan set's final self-review task).
- The `TrafficController` spawn-id fix in Task 7 (counter instead of `Math.random()`) must land before Task 7's test can pass — Task 3's own tests don't catch this because they don't assert on exact ID values, only on collision/despawn behavior.
- `MAX_VEHICLES_PER_APPROACH = 8` is a soft cap preventing unbounded queue growth if the AI never grants green — reasonable for a demo; Phase 8's load test should confirm it holds under the load-test's traffic volume too.
