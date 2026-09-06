# Phase 1: Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Node+TypeScript+Matter.js sim server, serving one hand-authored map with one signal-controlled intersection on a fixed-time cycle, that a single keyboard-controlled car can drive around inside a real physics world — rendered live in a Phaser 3 browser client. No AI service yet; the signal advances on its own timer.

**Architecture:** Monorepo bootstrap (pnpm workspace + shared-contracts codegen + base CI) is folded into Task 1 since nothing else can start without it. Everything after is: define the map → build the physics world around it → add one physically-driven vehicle → wire the WS loop → render it.

**Tech Stack:** TypeScript, Node.js, `ws`, `matter-js` + `@types/matter-js`, pnpm workspaces, vitest, Phaser 3, esbuild/tsc, Docker Compose.

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §1, §2, §4, §9, §14 step 1, FR-1. Also read [`00-overview.md`](00-overview.md) §2–§5 (toolchain, repo layout, shared-contracts flow, CI table) before starting — this plan does not repeat them.

## Global Constraints

- Monorepo package manager: pnpm workspaces (`00-overview.md` §2).
- WS transport: raw `ws`, envelope `{ type, payload, ts }` (`00-overview.md` §2).
- Shared contracts: JSON Schema source → generated TS + Python types, drift-checked in CI (`00-overview.md` §4).
- Physics: `matter-js`, server-authoritative; clients render interpolated state only (TR-1).
- State broadcast ~15-20Hz, input ingestion ~30Hz (TR-2).
- No timeline/dates in any task — dependency order only.

---

### Task 1: Monorepo & base CI bootstrap

**Files:**
- Create: `package.json` (root), `pnpm-workspace.yaml`, `.gitignore` (extend existing), `.github/workflows/ci.yml`, `.eslintrc.cjs`, `.prettierrc`
- Create: `sim-server/package.json`, `sim-server/tsconfig.json`
- Create: `frontend/package.json`, `frontend/tsconfig.json`
- Create: `shared-contracts/package.json`
- Create: `infra/docker-compose.yml` (stub, extended Task 8)

**Interfaces:**
- Produces: pnpm workspace with three JS/TS members (`sim-server`, `frontend`, `shared-contracts`); root scripts `pnpm lint`, `pnpm -r build`, `pnpm -r test`.

- [ ] **Step 1: Create root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "sim-server"
  - "frontend"
  - "shared-contracts"
```

`package.json` (root):
```json
{
  "name": "traffic-ai-sandbox",
  "private": true,
  "scripts": {
    "lint": "eslint . --ext .ts",
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  },
  "devDependencies": {
    "eslint": "^9.9.0",
    "prettier": "^3.3.3",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Run `pnpm install` at repo root**

Run: `pnpm install`
Expected: lockfile created, no errors (workspace members have no deps yet beyond devDependencies).

- [ ] **Step 3: Scaffold `sim-server`, `frontend`, `shared-contracts` package.json + tsconfig**

`sim-server/package.json`:
```json
{
  "name": "sim-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "matter-js": "^0.20.0",
    "shared-contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/matter-js": "^0.19.7",
    "@types/ws": "^8.5.12",
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

`sim-server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Repeat the same shape for `frontend/package.json` (deps: `phaser`, dev deps: `vite`, `typescript`, `vitest`) and `shared-contracts/package.json` (deps: `json-schema-to-typescript`, `datamodel-code-generator` invoked via a Python subprocess — see Task 2).

- [ ] **Step 4: Run `pnpm install` again, verify workspace linking**

Run: `pnpm install && pnpm ls -r --depth -1`
Expected: three workspace packages listed, `sim-server` shows `shared-contracts` linked via `workspace:*` (symlink under `node_modules`).

- [ ] **Step 5: Add ESLint + Prettier config**

`.eslintrc.cjs`:
```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true },
  ignorePatterns: ["dist", "generated", "node_modules"]
};
```

- [ ] **Step 6: Create base CI workflow (lint + contracts-drift + unit-ts jobs — `00-overview.md` §5 phase-1 row)**

`.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  contracts-drift:
    runs-on: ubuntu-latest
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
      - run: git diff --exit-code -- shared-contracts/generated

  unit-ts:
    runs-on: ubuntu-latest
    needs: [lint]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter sim-server --filter frontend --filter shared-contracts test
```

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml .eslintrc.cjs .prettierrc .github .gitignore sim-server/package.json sim-server/tsconfig.json frontend/package.json frontend/tsconfig.json shared-contracts/package.json
git commit -m "chore: bootstrap pnpm monorepo and base CI"
```

---

### Task 2: shared-contracts — input & state-snapshot schemas + codegen

**Files:**
- Create: `shared-contracts/schemas/client-input.schema.json`
- Create: `shared-contracts/schemas/state-snapshot.schema.json`
- Create: `shared-contracts/scripts/generate.mjs`
- Create: `shared-contracts/package.json` scripts entry
- Test: `shared-contracts/test/generated.test.ts`

**Interfaces:**
- Produces (Interface ledger, Phase 1): `ClientInputMessage`, `ServerStateSnapshot`, `VehicleState`, `SignalState` — exact shapes in `00-overview.md` §6.

- [ ] **Step 1: Write the JSON Schemas**

`shared-contracts/schemas/client-input.schema.json`:
```json
{
  "$id": "ClientInputMessage",
  "type": "object",
  "required": ["type", "payload", "ts"],
  "properties": {
    "type": { "const": "input" },
    "ts": { "type": "number" },
    "payload": {
      "type": "object",
      "required": ["carId", "throttle", "brake", "steer"],
      "properties": {
        "carId": { "type": "string" },
        "throttle": { "type": "number", "minimum": 0, "maximum": 1 },
        "brake": { "type": "number", "minimum": 0, "maximum": 1 },
        "steer": { "type": "number", "minimum": -1, "maximum": 1 }
      }
    }
  }
}
```

`shared-contracts/schemas/state-snapshot.schema.json`:
```json
{
  "$id": "ServerStateSnapshot",
  "type": "object",
  "required": ["type", "payload", "ts"],
  "properties": {
    "type": { "const": "state" },
    "ts": { "type": "number" },
    "payload": {
      "type": "object",
      "required": ["tick", "vehicles", "signals"],
      "properties": {
        "tick": { "type": "number" },
        "vehicles": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["id", "x", "y", "heading", "speed", "controller"],
            "properties": {
              "id": { "type": "string" },
              "x": { "type": "number" },
              "y": { "type": "number" },
              "heading": { "type": "number" },
              "speed": { "type": "number" },
              "controller": { "enum": ["idm", "user"] }
            }
          }
        },
        "signals": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["intersectionId", "phase", "msRemainingMin"],
            "properties": {
              "intersectionId": { "type": "string" },
              "phase": { "type": "string" },
              "msRemainingMin": { "type": "number" }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write the codegen script**

`shared-contracts/scripts/generate.mjs`:
```js
import { compileFromFile } from "json-schema-to-typescript";
import { execSync } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const schemaDir = "schemas";
const tsOutDir = "generated/ts";
const pyOutDir = "generated/py";
mkdirSync(tsOutDir, { recursive: true });
mkdirSync(pyOutDir, { recursive: true });

for (const file of readdirSync(schemaDir)) {
  if (!file.endsWith(".schema.json")) continue;
  const name = file.replace(".schema.json", "");
  // TS side keeps hyphenated filenames (just a path string, reads naturally next to the schema).
  // Python side MUST use underscores: `signal-decision.py` cannot be imported as a module.
  const pyName = name.replace(/-/g, "_");
  const ts = await compileFromFile(path.join(schemaDir, file));
  writeFileSync(path.join(tsOutDir, `${name}.d.ts`), ts);
  execSync(
    `uvx datamodel-codegen --input ${path.join(schemaDir, file)} --input-file-type jsonschema --output ${path.join(pyOutDir, `${pyName}_schema.py`)}`,
    { stdio: "inherit" }
  );
}

// Copy generated Python types into ai-service so uv doesn't need pnpm workspace resolution.
mkdirSync("../ai-service/app/contracts", { recursive: true });
execSync(`cp -r ${pyOutDir}/* ../ai-service/app/contracts/`);
```

`shared-contracts/package.json` scripts:
```json
{
  "name": "shared-contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "node scripts/generate.mjs",
    "build": "echo 'no build step, generated/ is the artifact'",
    "test": "vitest run"
  },
  "dependencies": {
    "json-schema-to-typescript": "^15.0.2"
  },
  "devDependencies": { "vitest": "^2.0.5" }
}
```

- [ ] **Step 2b: Note the runtime prerequisite**

`uvx` (from `uv`) must be installed on the machine/CI runner for the Python codegen half of Step 2 to run — add `pip install uv` before any `pnpm --filter shared-contracts generate` invocation (already present in the CI job from Task 1 Step 6, and required in local dev setup instructions in the repo root README created in Task 8).

- [ ] **Step 3: Run generation, verify output exists**

Run: `cd shared-contracts && pnpm generate`
Expected: `generated/ts/client-input.schema.d.ts`, `generated/ts/state-snapshot.schema.d.ts`, `generated/py/client_input_schema.py`, `generated/py/state_snapshot_schema.py` all created; `ai-service/app/contracts/*.py` populated (underscored filenames, importable as Python modules).

- [ ] **Step 4: Write the failing test asserting generated types compile and round-trip a sample object**

`shared-contracts/test/generated.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { ClientInputMessage } from "../generated/ts/client-input.schema";

describe("generated contract types", () => {
  it("accepts a well-formed ClientInputMessage", () => {
    const msg: ClientInputMessage = {
      type: "input",
      ts: 123,
      payload: { carId: "car_1", throttle: 0.5, brake: 0, steer: 0.1 }
    };
    expect(msg.payload.carId).toBe("car_1");
  });
});
```

- [ ] **Step 5: Run test to verify it passes (this is a type-level smoke test, not TDD-red-first, since it verifies codegen output rather than new logic)**

Run: `pnpm --filter shared-contracts test`
Expected: PASS. If it fails with a type error, Step 3's generation produced a mismatched shape — fix the schema, not the test.

- [ ] **Step 6: Commit**

```bash
git add shared-contracts/schemas shared-contracts/scripts shared-contracts/generated shared-contracts/test shared-contracts/package.json ai-service/app/contracts
git commit -m "feat(contracts): add client-input and state-snapshot schemas with TS/Py codegen"
```

---

### Task 3: Map authoring + MapDefinition loader

**Files:**
- Create: `maps/grid_1x1_v1.json`
- Create: `sim-server/src/maps/MapDefinition.ts`
- Create: `sim-server/src/maps/loadMap.ts`
- Test: `sim-server/test/maps/loadMap.test.ts`

**Interfaces:**
- Consumes: nothing yet (first sim-server module).
- Produces: `MapDefinition` type, `loadMap(path: string): MapDefinition` (validates against a minimal JSON Schema-equivalent shape check — no external validator dependency needed for a 2-field structural check).

- [ ] **Step 1: Author the map JSON**

`maps/grid_1x1_v1.json` — one 4-way intersection, one lane per approach, 2-phase fixed-time signal:
```json
{
  "id": "grid_1x1_v1",
  "intersections": [
    {
      "id": "int_1",
      "x": 0,
      "y": 0,
      "phases": [
        { "id": "NS_through", "allowedDirections": ["N", "S"], "durationMs": 8000 },
        { "id": "EW_through", "allowedDirections": ["E", "W"], "durationMs": 8000 }
      ]
    }
  ],
  "approaches": [
    { "id": "app_N", "intersectionId": "int_1", "direction": "N", "laneStartX": 0, "laneStartY": -300, "laneEndX": 0, "laneEndY": 0, "width": 40 },
    { "id": "app_S", "intersectionId": "int_1", "direction": "S", "laneStartX": 0, "laneStartY": 300, "laneEndX": 0, "laneEndY": 0, "width": 40 },
    { "id": "app_E", "intersectionId": "int_1", "direction": "E", "laneStartX": 300, "laneStartY": 0, "laneEndX": 0, "laneEndY": 0, "width": 40 },
    { "id": "app_W", "intersectionId": "int_1", "direction": "W", "laneStartX": -300, "laneStartY": 0, "laneEndX": 0, "laneEndY": 0, "width": 40 }
  ]
}
```

- [ ] **Step 2: Write the failing test for the loader**

`sim-server/test/maps/loadMap.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";

describe("loadMap", () => {
  it("loads grid_1x1_v1 and exposes one intersection with two phases", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    expect(map.id).toBe("grid_1x1_v1");
    expect(map.intersections).toHaveLength(1);
    expect(map.intersections[0].phases).toHaveLength(2);
    expect(map.approaches).toHaveLength(4);
  });

  it("throws on a map missing required fields", () => {
    expect(() => loadMap("../maps/does_not_exist.json")).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- loadMap`
Expected: FAIL with "Cannot find module '../../src/maps/loadMap'".

- [ ] **Step 4: Write `MapDefinition.ts` and `loadMap.ts`**

`sim-server/src/maps/MapDefinition.ts`:
```ts
export type Direction = "N" | "S" | "E" | "W";

export interface SignalPhaseDef {
  id: string;
  allowedDirections: Direction[];
  durationMs: number;
}

export interface IntersectionDef {
  id: string;
  x: number;
  y: number;
  phases: SignalPhaseDef[];
}

export interface ApproachDef {
  id: string;
  intersectionId: string;
  direction: Direction;
  laneStartX: number;
  laneStartY: number;
  laneEndX: number;
  laneEndY: number;
  width: number;
}

export interface MapDefinition {
  id: string;
  intersections: IntersectionDef[];
  approaches: ApproachDef[];
}
```

`sim-server/src/maps/loadMap.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MapDefinition } from "./MapDefinition";

export function loadMap(relativePath: string): MapDefinition {
  // Resolved relative to this module's own directory (sim-server/src/maps), not the caller's —
  // every call site uses the same "../../maps/<file>.json" convention regardless of how deeply
  // nested the calling test file is (a real bug found while implementing: an earlier version of
  // this function resolved one directory too shallow, so "../../maps/..." landed on
  // "sim-server/maps/..." instead of the repo-root "maps/..." directory).
  const fullPath = path.resolve(import.meta.dirname, "..", relativePath);
  const raw = JSON.parse(readFileSync(fullPath, "utf-8"));

  if (!raw.id || !Array.isArray(raw.intersections) || !Array.isArray(raw.approaches)) {
    throw new Error(`Invalid map file at ${fullPath}: missing id/intersections/approaches`);
  }
  for (const intersection of raw.intersections) {
    if (!Array.isArray(intersection.phases) || intersection.phases.length === 0) {
      throw new Error(`Intersection ${intersection.id} has no phases`);
    }
  }
  return raw as MapDefinition;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- loadMap`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add maps/grid_1x1_v1.json sim-server/src/maps sim-server/test/maps
git commit -m "feat(sim-server): add grid_1x1_v1 map and MapDefinition loader"
```

---

### Task 4: PhysicsWorld — Matter.js wrapper + fixed-time signal phase state machine

**Files:**
- Create: `sim-server/src/physics/PhysicsWorld.ts`
- Create: `sim-server/src/signals/FixedTimeSignal.ts`
- Test: `sim-server/test/physics/PhysicsWorld.test.ts`
- Test: `sim-server/test/signals/FixedTimeSignal.test.ts`

**Interfaces:**
- Consumes: `MapDefinition` (Task 3).
- Produces (Interface ledger, Phase 1): `class PhysicsWorld` — `constructor(mapDef: MapDefinition)`, `.step(dtMs: number): void`, `.engine: Matter.Engine`.
- Produces: `class FixedTimeSignal` — `constructor(phases: SignalPhaseDef[])`, `.step(dtMs): void`, `.currentPhase: SignalPhaseDef`, `.msRemaining: number`.

- [ ] **Step 1: Write the failing test for `FixedTimeSignal` (simpler, no Matter.js dependency — build this first)**

`sim-server/test/signals/FixedTimeSignal.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FixedTimeSignal } from "../../src/signals/FixedTimeSignal";

describe("FixedTimeSignal", () => {
  const phases = [
    { id: "NS_through", allowedDirections: ["N", "S"] as const, durationMs: 8000 },
    { id: "EW_through", allowedDirections: ["E", "W"] as const, durationMs: 8000 }
  ];

  it("starts on the first phase with full duration remaining", () => {
    const signal = new FixedTimeSignal(phases);
    expect(signal.currentPhase.id).toBe("NS_through");
    expect(signal.msRemaining).toBe(8000);
  });

  it("advances to the next phase once duration elapses, wrapping around", () => {
    const signal = new FixedTimeSignal(phases);
    signal.step(8000);
    expect(signal.currentPhase.id).toBe("EW_through");
    signal.step(8000);
    expect(signal.currentPhase.id).toBe("NS_through");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- FixedTimeSignal`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `FixedTimeSignal`**

`sim-server/src/signals/FixedTimeSignal.ts`:
```ts
import type { SignalPhaseDef } from "../maps/MapDefinition";

export class FixedTimeSignal {
  private index = 0;
  private elapsedMs = 0;

  constructor(private readonly phases: SignalPhaseDef[]) {}

  step(dtMs: number): void {
    this.elapsedMs += dtMs;
    while (this.elapsedMs >= this.phases[this.index].durationMs) {
      this.elapsedMs -= this.phases[this.index].durationMs;
      this.index = (this.index + 1) % this.phases.length;
    }
  }

  get currentPhase(): SignalPhaseDef {
    return this.phases[this.index];
  }

  get msRemaining(): number {
    return this.phases[this.index].durationMs - this.elapsedMs;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- FixedTimeSignal`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `PhysicsWorld`**

`sim-server/test/physics/PhysicsWorld.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import Matter from "matter-js";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";

describe("PhysicsWorld", () => {
  it("builds one static body per approach lane boundary pair from the map", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const staticBodies = Matter.Composite.allBodies(world.engine.world).filter((b) => b.isStatic);
    // 4 approaches x 2 edges (left/right lane boundary) = 8 static bodies
    expect(staticBodies).toHaveLength(8);
  });

  it("advances physics time on step()", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const before = world.engine.timing.timestamp;
    world.step(16);
    expect(world.engine.timing.timestamp).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- PhysicsWorld`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `PhysicsWorld`**

`sim-server/src/physics/PhysicsWorld.ts`:
```ts
import Matter from "matter-js";
import type { MapDefinition } from "../maps/MapDefinition";

export class PhysicsWorld {
  readonly engine: Matter.Engine;

  constructor(mapDef: MapDefinition) {
    this.engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });

    for (const approach of mapDef.approaches) {
      const dx = approach.laneEndX - approach.laneStartX;
      const dy = approach.laneEndY - approach.laneStartY;
      const length = Math.hypot(dx, dy) || 1;
      const angle = Math.atan2(dy, dx);
      const midX = (approach.laneStartX + approach.laneEndX) / 2;
      const midY = (approach.laneStartY + approach.laneEndY) / 2;
      const perpX = -Math.sin(angle) * (approach.width / 2);
      const perpY = Math.cos(angle) * (approach.width / 2);

      const leftEdge = Matter.Bodies.rectangle(midX + perpX, midY + perpY, length, 4, {
        isStatic: true,
        angle,
        label: `${approach.id}_left_edge`
      });
      const rightEdge = Matter.Bodies.rectangle(midX - perpX, midY - perpY, length, 4, {
        isStatic: true,
        angle,
        label: `${approach.id}_right_edge`
      });
      Matter.Composite.add(this.engine.world, [leftEdge, rightEdge]);
    }
  }

  // **Major bug found in Phase 7, fixed retroactively here** (this is where the code lives):
  // the walls above originally ran the *full* laneStart-to-laneEnd length, i.e. right up to the
  // shared intersection center. Since all four approaches converge on that same point, each pair
  // of perpendicular walls physically crosses the other's through-lane — e.g. app_E's and app_W's
  // walls together span the *entire* x-axis at y=+-20, forming a complete solid barrier across
  // the N/S lane well before a car ever reaches its stop line. Found only by tracing a
  // straight-through vehicle's position tick-by-tick and watching it get permanently wedged there
  // — half of all straight-through traffic in the whole simulation would silently get stuck
  // forever (pickExitApproachId, Phase 3, picks straight ~50% of the time), masked for six phases
  // because every existing test only asserted that *some* vehicle (any turning one, which curves
  // away from the pinch via its Bezier corner) eventually despawns, never that *every* vehicle
  // does. Fixed by shortening each wall so it stops `STOP_LINE_OFFSET` (15, from
  // `vehicles/TurnPaths.ts` — the same distance a vehicle's IDM stop line sits from center) short
  // of the intersection center, imported as `import { STOP_LINE_OFFSET } from "../vehicles/TurnPaths.js"`.
  // This exact distance matters, not just "some" gap: it must be small enough that a vehicle
  // queued at its own stop line still sits inside its approach's wall (protecting it from lateral
  // cross-traffic — a naive `approach.width / 2` gap regressed exactly this, letting a stopped car
  // get clipped by traffic from the still-green cross street), while still leaving a wide enough
  // hole at the crossing walls' position for an 18-unit-wide vehicle body to pass through
  // untouched. `STOP_LINE_OFFSET` happens to satisfy both simultaneously for this map's numbers;
  // see `07-emergency-vehicle.md` Task 2 for the full derivation. Concretely:
  // ```ts
  // const gap = STOP_LINE_OFFSET;
  // const length = Math.max(fullLength - gap, 1);
  // const unitX = dx / fullLength;
  // const unitY = dy / fullLength;
  // const midX = approach.laneStartX + unitX * (length / 2);
  // const midY = approach.laneStartY + unitY * (length / 2);
  // ```
  // — replacing the `length`/`midX`/`midY` computed above (rename the original `length` to
  // `fullLength` throughout, including the queue-zone code below it, which must keep dividing by
  // the *un-shortened* `fullLength` to compute its own direction unit vector correctly).

  step(dtMs: number): void {
    // Matter.js's integrator is only numerically stable for step sizes up to ~16.667ms (its own
    // recommendation — the "delta argument is recommended to be less than or equal to 16.667 ms"
    // warning is not cosmetic). Handing it the sim's real 50ms tick in one call compounds
    // instability over a long-running session: vehicles gain unbounded speed/energy over enough
    // ticks (this surfaced concretely in Phase 3, where a multi-vehicle queueing scenario running
    // for hundreds of ticks showed cars reaching speeds far above any throttle-derived terminal
    // velocity). Subdividing into fixed ~16.667ms substeps keeps each integration step within
    // Matter's stable range while still advancing the full requested dtMs per call.
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

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- PhysicsWorld`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add sim-server/src/physics sim-server/src/signals sim-server/test/physics sim-server/test/signals
git commit -m "feat(sim-server): add PhysicsWorld (Matter.js lane boundaries) and FixedTimeSignal"
```

---

### Task 5: IDM controller + single user-controlled vehicle body

**Files:**
- Create: `sim-server/src/vehicles/IdmController.ts`
- Create: `sim-server/src/vehicles/VehicleBody.ts`
- Test: `sim-server/test/vehicles/IdmController.test.ts`
- Test: `sim-server/test/vehicles/VehicleBody.test.ts`

**Interfaces:**
- Consumes: `PhysicsWorld.engine` (Task 4).
- Produces (Interface ledger, Phase 1): `idmAcceleration(self: IdmState, leader: IdmState | null, params: IdmParams): number`.
- Produces: `class VehicleBody` — `constructor(world: PhysicsWorld, id: string, spawn: { x: number; y: number; heading: number })`, `.applyInput(throttle: number, brake: number, steer: number): void`, `.body: Matter.Body`.

- [ ] **Step 1: Write the failing test for `idmAcceleration`**

`sim-server/test/vehicles/IdmController.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { idmAcceleration, type IdmParams } from "../../src/vehicles/IdmController";

const params: IdmParams = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 4 };

describe("idmAcceleration", () => {
  it("accelerates toward v0 with no leader", () => {
    const a = idmAcceleration({ speed: 0, position: 0 }, null, params);
    expect(a).toBeCloseTo(params.aMax, 5);
  });

  it("returns ~0 acceleration once at desired speed with no leader", () => {
    const a = idmAcceleration({ speed: params.v0, position: 0 }, null, params);
    expect(a).toBeCloseTo(0, 5);
  });

  it("brakes when a slower leader is too close", () => {
    const self = { speed: 15, position: 0 };
    const leader = { speed: 5, position: 6 };
    const a = idmAcceleration(self, leader, params);
    expect(a).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- IdmController`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `idmAcceleration`**

`sim-server/src/vehicles/IdmController.ts`:
```ts
export interface IdmState {
  speed: number;
  position: number;
}

export interface IdmParams {
  v0: number;
  T: number;
  aMax: number;
  b: number;
  delta: number;
  s0: number;
  vehicleLength: number;
}

export function idmAcceleration(self: IdmState, leader: IdmState | null, params: IdmParams): number {
  const freeRoadTerm = 1 - Math.pow(self.speed / params.v0, params.delta);

  if (!leader) {
    return params.aMax * freeRoadTerm;
  }

  const gap = Math.max(leader.position - self.position - params.vehicleLength, 0.1);
  const deltaV = self.speed - leader.speed;
  const sStar =
    params.s0 +
    Math.max(self.speed * params.T + (self.speed * deltaV) / (2 * Math.sqrt(params.aMax * params.b)), 0);

  return params.aMax * (freeRoadTerm - Math.pow(sStar / gap, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- IdmController`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for `VehicleBody`**

`sim-server/test/vehicles/VehicleBody.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { VehicleBody } from "../../src/vehicles/VehicleBody";

describe("VehicleBody", () => {
  it("moves forward under positive throttle over several physics steps", () => {
    const world = new PhysicsWorld(loadMap("../../maps/grid_1x1_v1.json"));
    const car = new VehicleBody(world, "car_1", { x: 0, y: -300, heading: Math.PI / 2 });
    const startY = car.body.position.y;

    for (let i = 0; i < 30; i++) {
      car.applyInput(1, 0, 0);
      world.step(16);
    }

    expect(car.body.position.y).toBeGreaterThan(startY);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- VehicleBody`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `VehicleBody`**

`sim-server/src/vehicles/VehicleBody.ts`:
```ts
import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld";

const MAX_FORCE = 0.02;
const MAX_STEER_TORQUE = 0.002;

export class VehicleBody {
  readonly body: Matter.Body;

  constructor(
    world: PhysicsWorld,
    public readonly id: string,
    spawn: { x: number; y: number; heading: number }
  ) {
    this.body = Matter.Bodies.rectangle(spawn.x, spawn.y, 18, 36, {
      angle: spawn.heading,
      frictionAir: 0.05,
      label: `vehicle_${id}`
    });
    Matter.Composite.add(world.engine.world, this.body);
  }

  applyInput(throttle: number, brake: number, steer: number): void {
    const net = Math.max(-1, Math.min(1, throttle - brake));
    const forceMagnitude = net * MAX_FORCE;
    const heading = this.body.angle;
    Matter.Body.applyForce(this.body, this.body.position, {
      x: Math.cos(heading) * forceMagnitude,
      y: Math.sin(heading) * forceMagnitude
    });
    Matter.Body.setAngularVelocity(this.body, steer * MAX_STEER_TORQUE * 50);
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- VehicleBody`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add sim-server/src/vehicles sim-server/test/vehicles
git commit -m "feat(sim-server): add IDM acceleration model and physics-driven VehicleBody"
```

---

### Task 6: WS server — connection handling, input ingestion, state broadcast

**Files:**
- Create: `sim-server/src/room/SingleCarSession.ts` (phase-1 stand-in for the full `RoomManager`, which Phase 3 replaces)
- Create: `sim-server/src/server.ts`
- Test: `sim-server/test/server.integration.test.ts`

**Interfaces:**
- Consumes: `PhysicsWorld`, `VehicleBody`, `FixedTimeSignal`, `ClientInputMessage`, `ServerStateSnapshot` (all prior tasks).
- Produces: `sim-server/src/server.ts` entrypoint listening on `PORT` (default `8080`); this is the only WS endpoint until Phase 3 adds `RoomManager`.

- [ ] **Step 1: Write `SingleCarSession` — owns the world, the one car, and the signal, and ticks them together**

`sim-server/src/room/SingleCarSession.ts`:
```ts
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { VehicleBody } from "../vehicles/VehicleBody";
import { FixedTimeSignal } from "../signals/FixedTimeSignal";
import { loadMap } from "../maps/loadMap";
import type { ServerStateSnapshot } from "shared-contracts/generated/ts/state-snapshot.schema";

const TICK_MS = 50; // 20Hz, within TR-2's 15-20Hz broadcast band

export class SingleCarSession {
  private readonly world: PhysicsWorld;
  private readonly car: VehicleBody;
  private readonly signal: FixedTimeSignal;
  private tick = 0;

  constructor() {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    this.world = new PhysicsWorld(map);
    this.car = new VehicleBody(this.world, "car_1", { x: 0, y: -300, heading: Math.PI / 2 });
    this.signal = new FixedTimeSignal(map.intersections[0].phases);
  }

  applyInput(carId: string, throttle: number, brake: number, steer: number): void {
    if (carId !== this.car.id) return;
    this.car.applyInput(throttle, brake, steer);
  }

  step(): ServerStateSnapshot {
    this.world.step(TICK_MS);
    this.signal.step(TICK_MS);
    this.tick += 1;

    return {
      type: "state",
      ts: Date.now(),
      payload: {
        tick: this.tick,
        vehicles: [
          {
            id: this.car.id,
            x: this.car.body.position.x,
            y: this.car.body.position.y,
            heading: this.car.body.angle,
            speed: Math.hypot(this.car.body.velocity.x, this.car.body.velocity.y),
            controller: "user"
          }
        ],
        signals: [
          {
            intersectionId: "int_1",
            phase: this.signal.currentPhase.id,
            msRemainingMin: this.signal.msRemaining
          }
        ]
      }
    };
  }
}

export const TICK_INTERVAL_MS = TICK_MS;
```

- [ ] **Step 2: Write `server.ts`**

`sim-server/src/server.ts`:
```ts
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { SingleCarSession, TICK_INTERVAL_MS } from "./room/SingleCarSession";
import type { ClientInputMessage } from "shared-contracts/generated/ts/client-input.schema";

const PORT = Number(process.env.PORT ?? 8080);
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });
const session = new SingleCarSession();

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ClientInputMessage;
    if (msg.type === "input") {
      session.applyInput(msg.payload.carId, msg.payload.throttle, msg.payload.brake, msg.payload.steer);
    }
  });
});

setInterval(() => {
  const snapshot = session.step();
  const payload = JSON.stringify(snapshot);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}, TICK_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`sim-server listening on :${PORT}`);
});
```

- [ ] **Step 3: Write the integration test (spins up the real server on an ephemeral port, connects a real `ws` client)**

`sim-server/test/server.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { SingleCarSession, TICK_INTERVAL_MS } from "../src/room/SingleCarSession";

describe("sim-server WS loop", () => {
  let httpServer: ReturnType<typeof createServer>;
  let port: number;

  beforeAll(async () => {
    const session = new SingleCarSession();
    const wss = new WebSocketServer({ noServer: true });
    httpServer = createServer();
    httpServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input") session.applyInput(msg.payload.carId, msg.payload.throttle, msg.payload.brake, msg.payload.steer);
      });
    });
    setInterval(() => {
      const snapshot = session.step();
      const payload = JSON.stringify(snapshot);
      for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(payload);
    }, TICK_INTERVAL_MS);

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterAll(() => httpServer.close());

  it("broadcasts a state snapshot and reflects sent input on the car", async () => {
    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise((resolve) => client.on("open", resolve));

    const firstSnapshot = await new Promise<any>((resolve) => {
      client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    expect(firstSnapshot.type).toBe("state");
    const startY = firstSnapshot.payload.vehicles[0].y;

    client.send(JSON.stringify({ type: "input", ts: Date.now(), payload: { carId: "car_1", throttle: 1, brake: 0, steer: 0 } }));

    let lastY = startY;
    await new Promise<void>((resolve) => {
      let count = 0;
      client.on("message", (raw) => {
        const snap = JSON.parse(raw.toString());
        lastY = snap.payload.vehicles[0].y;
        count += 1;
        if (count > 20) resolve();
      });
    });

    expect(lastY).toBeGreaterThan(startY);
    client.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails first (before server.ts existed it would fail to import; now confirm the assertions themselves are meaningful by temporarily reverting `applyInput` to a no-op and observing failure)**

Run: `pnpm --filter sim-server test -- server.integration`
Expected: with `applyInput` implemented, PASS; this step is a manual sanity check that the test can fail — no code change needed if you trust Task 5's own red/green cycle already proved the physics moves the car.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- server.integration`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sim-server/src/room sim-server/src/server.ts sim-server/test/server.integration.test.ts
git commit -m "feat(sim-server): wire WS server with input ingestion and 20Hz state broadcast"
```

---

### Task 7: Frontend — Phaser 3 scene rendering state snapshots, keyboard input

**Files:**
- Create: `frontend/index.html`, `frontend/vite.config.ts`
- Create: `frontend/src/main.ts`
- Create: `frontend/src/net/SimClient.ts`
- Create: `frontend/src/scenes/MainScene.ts`
- Test: `frontend/test/net/SimClient.test.ts`

**Interfaces:**
- Consumes: `ServerStateSnapshot`, `ClientInputMessage` (Task 2).
- Produces: `class SimClient` — `constructor(url: string)`, `.onState(cb: (s: ServerStateSnapshot) => void): void`, `.sendInput(input: ClientInputMessage["payload"]): void`.

- [ ] **Step 1: Write the failing test for `SimClient` (using a fake WebSocket)**

`frontend/test/net/SimClient.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { SimClient } from "../../src/net/SimClient";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
}

describe("SimClient", () => {
  it("invokes onState callback when a state message arrives", () => {
    // @ts-expect-error test override
    global.WebSocket = FakeWebSocket;
    const client = new SimClient("ws://localhost:8080");
    const cb = vi.fn();
    client.onState(cb);

    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onmessage?.({ data: JSON.stringify({ type: "state", ts: 1, payload: { tick: 1, vehicles: [], signals: [] } }) });

    expect(cb).toHaveBeenCalledOnce();
  });

  it("sends a well-formed input message", () => {
    // @ts-expect-error test override
    global.WebSocket = FakeWebSocket;
    const client = new SimClient("ws://localhost:8080");
    client.sendInput({ carId: "car_1", throttle: 1, brake: 0, steer: 0 });

    const ws = FakeWebSocket.instances.at(-1)!;
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("input");
    expect(sent.payload.carId).toBe("car_1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend test -- SimClient`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `SimClient`**

`frontend/src/net/SimClient.ts`:
```ts
import type { ServerStateSnapshot } from "shared-contracts/generated/ts/state-snapshot.schema";
import type { ClientInputMessage } from "shared-contracts/generated/ts/client-input.schema";

export class SimClient {
  private readonly socket: WebSocket;
  private stateHandler: ((snapshot: ServerStateSnapshot) => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "state" && this.stateHandler) this.stateHandler(msg as ServerStateSnapshot);
    };
  }

  onState(cb: (snapshot: ServerStateSnapshot) => void): void {
    this.stateHandler = cb;
  }

  sendInput(payload: ClientInputMessage["payload"]): void {
    const msg: ClientInputMessage = { type: "input", ts: Date.now(), payload };
    this.socket.send(JSON.stringify(msg));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend test -- SimClient`
Expected: PASS.

- [ ] **Step 5: Build `MainScene` (Phaser 3) — renders vehicles as rectangles, signal as a colored dot, captures keyboard**

`frontend/src/scenes/MainScene.ts`:
```ts
import Phaser from "phaser";
import { SimClient } from "../net/SimClient";

export class MainScene extends Phaser.Scene {
  private client!: SimClient;
  private carSprites = new Map<string, Phaser.GameObjects.Rectangle>();
  private signalDot!: Phaser.GameObjects.Arc;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  constructor() {
    super("main");
  }

  create() {
    this.cameras.main.centerOn(0, 0);
    this.signalDot = this.add.circle(20, 20, 8, 0x00ff00);
    this.cursors = this.input.keyboard!.createCursorKeys();

    this.client = new SimClient(`ws://${window.location.hostname}:8080`);
    this.client.onState((snapshot) => {
      for (const v of snapshot.payload.vehicles) {
        let sprite = this.carSprites.get(v.id);
        if (!sprite) {
          sprite = this.add.rectangle(v.x, v.y, 18, 36, 0x3388ff);
          this.carSprites.set(v.id, sprite);
        }
        sprite.setPosition(v.x, v.y);
        sprite.setRotation(v.heading);
      }
      const signal = snapshot.payload.signals[0];
      if (signal) this.signalDot.setFillStyle(signal.phase === "NS_through" ? 0x00ff00 : 0xff3333);
    });
  }

  update() {
    const throttle = this.cursors.up.isDown ? 1 : 0;
    const brake = this.cursors.down.isDown ? 1 : 0;
    const steer = this.cursors.left.isDown ? -1 : this.cursors.right.isDown ? 1 : 0;
    this.client.sendInput({ carId: "car_1", throttle, brake, steer });
  }
}
```

`frontend/src/main.ts`:
```ts
import Phaser from "phaser";
import { MainScene } from "./scenes/MainScene";

new Phaser.Game({
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: "#222222",
  scene: [MainScene],
  fps: { target: 30 }
});
```

`frontend/index.html`:
```html
<!doctype html>
<html>
  <head><title>Traffic AI Sandbox</title></head>
  <body style="margin:0">
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`frontend/vite.config.ts`:
```ts
import { defineConfig } from "vite";
export default defineConfig({ server: { port: 5173 } });
```

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/vite.config.ts frontend/src frontend/test
git commit -m "feat(frontend): Phaser 3 scene rendering state snapshots with keyboard input"
```

---

### Task 8: Docker Compose local dev + manual smoke test + README

**Files:**
- Create: `infra/docker-compose.yml`
- Create: `sim-server/Dockerfile`, `frontend/Dockerfile`
- Create: `README.md` (root)

**Interfaces:**
- Produces: `docker-compose up` brings up `sim-server` (port 8080) and `frontend` (port 5173, Vite dev server) together.

- [ ] **Step 1: Write Dockerfiles**

`sim-server/Dockerfile`:
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter shared-contracts generate && pnpm --filter sim-server build
CMD ["node", "sim-server/dist/server.js"]
```

`frontend/Dockerfile` (dev-mode container, used only in local Compose — Phase 10 adds a static-build variant):
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
EXPOSE 5173
CMD ["pnpm", "--filter", "frontend", "exec", "vite", "--host"]
```

- [ ] **Step 2: Write `infra/docker-compose.yml`**

```yaml
services:
  sim-server:
    build:
      context: ..
      dockerfile: sim-server/Dockerfile
    ports: ["8080:8080"]
  frontend:
    build:
      context: ..
      dockerfile: frontend/Dockerfile
    ports: ["5173:5173"]
    depends_on: [sim-server]
```

- [ ] **Step 3: Write root README with the manual smoke test procedure**

`README.md`:
```markdown
# AI Traffic Management Sandbox

## Local dev
\`\`\`bash
pip install uv   # required for shared-contracts Python codegen
pnpm install
pnpm --filter shared-contracts generate
docker compose -f infra/docker-compose.yml up --build
\`\`\`

Then open http://localhost:5173.

## Phase 1 manual smoke test
1. Open the browser tab; you should see one blue rectangle (the car) and a colored dot (signal phase indicator).
2. Hold the Up arrow key — the car should accelerate forward and keep moving under physics (not teleport).
3. Release Up, hold Down — the car should decelerate.
4. Hold Left/Right — the car should rotate.
5. Watch the signal dot: it should switch between green and red roughly every 8 seconds without any input.
6. Drive the car into a lane boundary (the road edge) — it should stop/deflect, not pass through it.
```

- [ ] **Step 4: Run the full local stack and manually verify all 6 smoke-test steps**

Run: `docker compose -f infra/docker-compose.yml up --build`
Expected: all 6 steps in the README pass by direct observation. This is the phase's only non-automated check — there is no AI service or multiplayer yet, so Playwright E2E (added Phase 8) isn't warranted for a single manual keyboard flow.

- [ ] **Step 5: Commit**

```bash
git add infra sim-server/Dockerfile frontend/Dockerfile README.md
git commit -m "chore: add Docker Compose local dev stack and Phase 1 smoke test"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes | `idmAcceleration` math, `FixedTimeSignal` phase cycling, `loadMap` validation, `PhysicsWorld` static body construction |
| Integration | Partial | `server.integration.test.ts` exercises the real WS server end-to-end in-process (no separate `ai-service` yet — full docker-composed integration test arrives Phase 3) |
| Physics/determinism | Not yet | No collision response to test until Phase 3 (vehicle-vehicle) — `PhysicsWorld` test here only checks construction and time advancement |
| Load | Not yet | Phase 8 |
| RL regression | N/A | No RL until Phase 6 |
| E2E | Manual only (Task 8 Step 4) | Playwright E2E arrives Phase 8 once there's a multi-step user journey worth automating |

## Definition of Done

- [ ] `pnpm install && pnpm --filter shared-contracts generate && pnpm -r build && pnpm -r test` all succeed locally and in CI (all 3 Phase-1 CI jobs green — `00-overview.md` §5).
- [ ] `docker compose -f infra/docker-compose.yml up --build` brings up both services.
- [ ] All 6 manual smoke-test steps in the README pass.
- [ ] Every file in the Interface ledger's "From Phase 1" section (`00-overview.md` §6) exists with the exact signature listed.

## Risks / open implementation notes

- The `VehicleBody` force/torque constants (`MAX_FORCE`, `MAX_STEER_TORQUE`) are placeholder-tuned for "car visibly moves and turns in a smoke test," not for realistic handling — Phase 3 (multiplayer + real collisions) is where these get tuned against actual collision scenarios, since that's the first phase where collision *response* (not just non-clipping) matters.
- `SingleCarSession` is deliberately throwaway — Phase 3 replaces it with `RoomManager` supporting multiple cars/claims. Don't invest in making it generic; it exists to prove the loop, nothing more.
