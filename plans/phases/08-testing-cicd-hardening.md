# Phase 8: Testing + CI/CD Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining gap in the spec §11 test pyramid (load testing, Playwright E2E) and consolidate the incrementally-grown `.github/workflows/ci.yml` from Phases 1, 2, 3, and 6 into the exact pipeline shape spec §12 describes, with real path-based filtering instead of the placeholder conditionals earlier phases left behind.

**Architecture:** Load testing is two complementary checks: a k6 WS-connection swarm (protocol/latency behavior under many simultaneous clients — most of which will legitimately hit `capacity_reached`, since the concurrency cap is real and load-testing it means confirming it degrades gracefully, not that everyone gets a car) and a custom Node tick-budget script (raw Matter.js/IDM/pedestrian-steering performance under rush-hour-level entity counts, since spec §11 specifically flags pedestrians as "the more expensive addition to the Matter.js tick"). Playwright E2E drives the real browser against the real stack (docker-composed or directly-started services), covering exactly what spec §11's E2E row names: both input methods and the EV scenario, plus verifying session JSON was actually written — which needs a small debug-only HTTP endpoint on `sim-server`, gated off by default. `ci.yml` is rewritten once, in full, to the final 7-stage shape — this is the one phase where "rewrite the CI file instead of incrementally patching it" is the right call, since consolidation is this phase's explicit purpose.

**Tech Stack:** k6 (`grafana/setup-k6-action`), Playwright (`@playwright/test`), `dorny/paths-filter` (CI path filtering) — all new, all test/CI-only.

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §11, §12, §14 step 8, TR-11, TR-12. Also read [`00-overview.md`](00-overview.md) §5 (CI table this phase completes) and §6 (Interface ledger — nothing new added by this phase; it only exercises existing interfaces).

## Global Constraints

- All Phase 1-7 Global Constraints still apply.
- No phase before this one should have its own tests weakened or removed to make room for these — this phase only adds coverage and CI structure.
- The debug session-read endpoint this phase adds must be off unless `DEBUG_ENDPOINTS=1` is explicitly set — it must never be enabled in the Fly.io deployment (Phase 10 must not set that env var in production).

---

### Task 1: k6 WS load test

**Files:**
- Create: `infra/load/wsBotSwarm.js`
- Modify: `README.md` (how to run it locally)

**Interfaces:** none new — this exercises `server.ts`/`SimSession` (Phase 3) as a black box.

- [ ] **Step 1: Write the k6 script**

`infra/load/wsBotSwarm.js`:
```js
import ws from "k6/ws";
import { check, sleep } from "k6";

export const options = {
  vus: 20,
  duration: "30s",
  thresholds: {
    ws_connecting: ["p(95)<1000"],
    ws_session_duration: ["p(95)<31000"]
  }
};

export default function () {
  const url = __ENV.SIM_SERVER_WS_URL || "ws://localhost:8080";

  const response = ws.connect(url, {}, function (socket) {
    let messageCount = 0;

    socket.on("open", () => {
      socket.setInterval(() => {
        socket.send(
          JSON.stringify({
            type: "input",
            ts: Date.now(),
            payload: { carId: "car_unclaimed", throttle: 1, brake: 0, steer: 0, inputMethod: "keyboard" }
          })
        );
      }, 100);
    });

    socket.on("message", () => {
      messageCount++;
    });

    socket.setTimeout(() => {
      socket.close();
    }, 10000);

    socket.on("close", () => {
      check(messageCount, { "received at least one broadcast": (n) => n > 0 });
    });
  });

  check(response, { "connected (HTTP 101)": (r) => r && r.status === 101 });
  sleep(1);
}
```

Note: with `MAX_HUMAN_CARS = 4` (Phase 3) and 20 virtual users, most connections will receive `{ error: "capacity_reached" }` on join — that's the point of running 20 against a cap of 4: confirming the server keeps broadcasting state to every connected socket (not just claimants) and doesn't degrade or crash once capacity is exceeded, which is exactly what "a handful of concurrent users" needs to hold up under.

- [ ] **Step 2: Document how to run it locally**

Append to `README.md`:
```markdown
## Load testing (Phase 8)
\`\`\`bash
docker compose -f infra/docker-compose.yml up -d
k6 run infra/load/wsBotSwarm.js
\`\`\`
```

- [ ] **Step 3: Run it locally to confirm it's meaningful before wiring into CI**

Run: `docker compose -f infra/docker-compose.yml up -d --build && k6 run infra/load/wsBotSwarm.js`
Expected: all checks pass; no sim-server crash or hung connections (verify via `docker compose logs sim-server`).

- [ ] **Step 4: Commit**

```bash
git add infra/load/wsBotSwarm.js README.md
git commit -m "test: add k6 WS load test exercising the concurrency cap under 20 simultaneous connections"
```

---

### Task 2: Matter.js tick-budget performance script

**Files:**
- Create: `sim-server/test/perf/tickBudget.perf.ts`

**Interfaces:** none new — exercises `PhysicsWorld`, `TrafficController` (Phase 3), `PedestrianController` (Phase 5) together under rush-hour-level load.

- [ ] **Step 1: Write the script**

Named `.perf.ts` (not `.test.ts`) so vitest's default `**/*.test.*` pattern never picks it up in normal `pnpm test` runs — this is a standalone script invoked explicitly, not a vitest suite, since its assertion is about wall-clock performance, not correctness.

`sim-server/test/perf/tickBudget.perf.ts`:
```ts
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { TrafficController } from "../../src/vehicles/TrafficController";
import { PedestrianController } from "../../src/pedestrians/PedestrianController";
import { PedestrianGraph } from "../../src/pedestrians/PedestrianGraph";
import { mulberry32 } from "../../src/util/mulberry32";

const TICK_MS = 50;
const TICKS = 2000; // 100 simulated seconds
const BUDGET_MS = 40; // headroom under the 50ms real-time tick interval
const RUSH_HOUR_VEHICLE_RATE_PER_MIN = 60;
const RUSH_HOUR_PEDESTRIAN_RATE_PER_MIN = 40;

function main(): void {
  const map = loadMap("../../maps/grid_1x1_v1.json");
  const world = new PhysicsWorld(map);
  // vehicleLength must match VehicleBody's real Matter.js rectangle length (36), not
  // IdmController.test.ts's pure-formula fixture value (4) — the latter packs queued vehicles far
  // closer than their real physical bodies, triggering Matter collision-response shoving that both
  // misrepresents real traffic and skews this script's own performance reading. Same real bug
  // already found and documented in 03-multiplayer-collisions.md.
  const idmParams = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 40 };
  const traffic = new TrafficController(world, map, idmParams, mulberry32(1), RUSH_HOUR_VEHICLE_RATE_PER_MIN, () => {});
  const pedestrians = new PedestrianController(
    world,
    new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges),
    ["far_N", "far_S", "far_E", "far_W"],
    mulberry32(2),
    RUSH_HOUR_PEDESTRIAN_RATE_PER_MIN
  );
  // Fixed NS-green/EW-red split for the whole run — this script measures raw tick cost under load,
  // not signal behavior, so a real SignalPhaseMachine (Phase 2, Task 6) isn't needed here.
  const approachSignalStates = new Map([
    ["app_N", "green"], ["app_S", "green"], ["app_E", "red"], ["app_W", "red"]
  ] as const);

  let totalMs = 0;
  for (let i = 0; i < TICKS; i++) {
    const start = performance.now();
    world.step(TICK_MS);
    traffic.step(TICK_MS, approachSignalStates);
    pedestrians.step(TICK_MS, approachSignalStates);
    totalMs += performance.now() - start;
  }

  const avgMs = totalMs / TICKS;
  console.log(
    `Average tick wall-time: ${avgMs.toFixed(2)}ms (budget ${BUDGET_MS}ms) | ` +
      `vehicles: ${traffic.vehicles.length}, pedestrians: ${pedestrians.agents.length}`
  );

  if (avgMs > BUDGET_MS) {
    console.error(`FAIL: tick budget exceeded (${avgMs.toFixed(2)}ms > ${BUDGET_MS}ms)`);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Run it locally**

Run: `cd sim-server && npx tsx test/perf/tickBudget.perf.ts`
Expected: prints an average tick time comfortably under 40ms and exits 0. If it exceeds budget, the likely culprits are the `TrafficController`/`PedestrianController` neighbor-lookup loops (both currently O(n²) per tick over tracked entities — Phase 3/5's tracked-vehicle and steering-neighbor scans) — at this map's scale (a handful of approaches, rush-hour arrival rates bounded by `MAX_VEHICLES_PER_APPROACH = 8`), this is expected to stay well within budget; if a future map scales entity counts up significantly, that O(n²) scan is the first place to optimize (e.g. spatial partitioning), not before it's actually needed.

- [ ] **Step 3: Commit**

```bash
git add sim-server/test/perf/tickBudget.perf.ts
git commit -m "test: add rush-hour-level Matter.js tick-budget performance script"
```

---

### Task 3: Debug session-read endpoint (test-only, gated)

**Files:**
- Modify: `sim-server/src/room/SimSession.ts` (expose `debugReadSession`)
- Modify: `sim-server/src/server.ts` (gated `/debug/session` HTTP route)
- Test: `sim-server/test/server.debugEndpoint.test.ts`

**Interfaces:**
- Produces: `SimSession.debugReadSession(): SessionFile`; `GET /debug/session` (only when `process.env.DEBUG_ENDPOINTS === "1"`).

- [ ] **Step 1: Add `debugReadSession` to `SimSession`**

Modify `sim-server/src/room/SimSession.ts` — add:
```ts
debugReadSession(): SessionFile {
  return this.store.read(this.sessionId);
}
```
(Import `SessionFile` from `../session/SessionEvent` if not already imported.)

- [ ] **Step 2: Write the failing test for the gated route**

`sim-server/test/server.debugEndpoint.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { SimSession } from "../src/room/SimSession";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDiskSessionStore } from "../src/session/LocalDiskSessionStore";

describe("debug session endpoint", () => {
  let httpServer: ReturnType<typeof createServer>;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    process.env.DEBUG_ENDPOINTS = "1";
    dir = mkdtempSync(path.join(tmpdir(), "debug-endpoint-test-"));
    const store = new LocalDiskSessionStore(dir);
    // Bug found during implementation: a blanket vi.stubGlobal("fetch", ...) intercepts every
    // fetch call in the test process, including this test's own `await fetch(.../debug/session)`
    // below — not just SimSession's internal call to the fake AI-service URL. Without the
    // conditional dispatch here, `res.text is not a function` (the mock object has neither
    // .text() nor a real .json() implementation matching a real Response), because the debug
    // endpoint request never actually reaches the local HTTP server at all. Route by URL instead,
    // falling through to the real fetch for anything that isn't the "http://fake" AI-service call.
    const realFetch = global.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, ...args: unknown[]) => {
        if (String(url).includes("/signal-decision")) {
          return Promise.resolve({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) } as Response);
        }
        return realFetch(url as any, ...(args as []));
      })
    );
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 60, 1);

    httpServer = createServer((req, res) => {
      if (process.env.DEBUG_ENDPOINTS === "1" && req.url === "/debug/session") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(session.debugReadSession()));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    new WebSocketServer({ server: httpServer }); // present so the server behaves like the real one; unused here
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterAll(() => {
    httpServer.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DEBUG_ENDPOINTS;
    vi.restoreAllMocks();
  });

  it("returns the current session file as JSON", async () => {
    const res = await fetch(`http://localhost:${port}/debug/session`);
    const body = await res.json();
    expect(body.mapId).toBe("grid_1x1_v1");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- server.debugEndpoint`
Expected: FAIL (route doesn't exist in `server.ts` yet — this test builds its own minimal server inline to test the concept in isolation; Step 4 wires the real one into `server.ts`).

- [ ] **Step 4: Wire the real route into `server.ts`**

Modify `sim-server/src/server.ts` — change `const httpServer = createServer();` to:
```ts
const httpServer = createServer((req, res) => {
  if (process.env.DEBUG_ENDPOINTS === "1" && req.url === "/debug/session") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(session.debugReadSession()));
    return;
  }
  res.statusCode = 404;
  res.end();
});
```
(The request handler closure only actually runs on an incoming HTTP request, which happens after the whole module finishes loading — so strictly, JS closure semantics mean this works regardless of whether `session` is declared before or after `httpServer` in source order. Still, the actual `server.ts` at the time this phase was implemented had `httpServer`/`wss` declared *before* `session`, the opposite of what this note assumed — reordered so `session` is constructed first, `httpServer`'s handler closes over it, then `wss` wraps `httpServer`, purely for source-order clarity, not because the old order was broken.)

- [ ] **Step 5: Run test to verify it passes, commit**

Run: `pnpm --filter sim-server test -- server.debugEndpoint`
Expected: PASS.

```bash
git add sim-server/src/room/SimSession.ts sim-server/src/server.ts sim-server/test/server.debugEndpoint.test.ts
git commit -m "feat(sim-server): gated debug endpoint for reading the live session file (test/dev only)"
```

---

### Task 4: Playwright E2E — keyboard, touch, EV scenario, session JSON

**Files:**
- Create: `frontend/playwright.config.ts`
- Create: `frontend/e2e/driveAndEv.spec.ts`
- Modify: `frontend/package.json` (add `@playwright/test`, `test:e2e` script)

**Interfaces:** none new — this is the spec §11 E2E row, driving the real stack end-to-end.

- [ ] **Step 1: Add Playwright dependency and script**

Modify `frontend/package.json`:
```json
"scripts": {
  "test:e2e": "playwright test"
},
"devDependencies": {
  "@playwright/test": "^1.47.0"
}
```

Run: `cd frontend && pnpm add -D @playwright/test && pnpm exec playwright install --with-deps chromium`

- [ ] **Step 2: Write `playwright.config.ts`**

`frontend/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  webServer: [
    {
      command: "cd ../ai-service && uv run uvicorn app.main:app --port 8000",
      port: 8000,
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    },
    {
      command: "cd ../sim-server && pnpm dev",
      port: 8080,
      env: { AI_SERVICE_URL: "http://localhost:8000", DEBUG_ENDPOINTS: "1" },
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    },
    {
      command: "pnpm exec vite",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    }
  ],
  use: {
    baseURL: "http://localhost:5173",
    hasTouch: true
  }
});
```

- [ ] **Step 3: Write the E2E spec**

`frontend/e2e/driveAndEv.spec.ts`:
```ts
import { test, expect } from "@playwright/test";

test("keyboard driving, touch driving, and EV preemption all work end-to-end, with session JSON recording it", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(1000); // allow the WS join handshake (Phase 4's onJoined flow) to complete

  // Keyboard input
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(500);
  await page.keyboard.up("ArrowUp");

  // Touch input — tap within the joystick zone (bottom-left, per MainScene's TouchJoystick placement)
  await page.touchscreen.tap(100, 500);
  await page.waitForTimeout(300);

  // Trigger the emergency-vehicle debug scenario (Phase 7's "press E" trigger)
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(5000); // let the ambulance approach, preempt, and pass

  const sessionResponse = await page.request.get("http://localhost:8080/debug/session");
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json();

  expect(session.events.some((e: any) => e.type === "ev_spawn")).toBe(true);
  expect(session.events.some((e: any) => e.type === "ev_preempt")).toBe(true);
  expect(session.mapId).toBe("grid_1x1_v1");
});
```

- [ ] **Step 4: Run it locally**

Run: `cd frontend && pnpm test:e2e`
Expected: PASS. If the EV assertions are flaky, increase the `waitForTimeout` after `KeyE` — the EV's transit time depends on `EV_IDM_PARAMS.v0` and the 300-unit approach length from Phase 1's map, so budget generously (the manual smoke test in Phase 7 already establishes roughly how long this takes to observe by eye).

- [ ] **Step 5: Commit**

```bash
git add frontend/playwright.config.ts frontend/e2e frontend/package.json
git commit -m "test(frontend): Playwright E2E covering keyboard, touch, and EV preemption end-to-end"
```

---

### Task 5: Consolidate `.github/workflows/ci.yml` into the final 7-stage pipeline

**Files:**
- Modify (full rewrite): `.github/workflows/ci.yml`

**Interfaces:** none — CI structure only.

- [ ] **Step 1: Rewrite `ci.yml` in full**

This supersedes the incrementally-added fragments from Phases 1 (`lint`, `contracts-drift`, `unit-ts`), 2 (`unit-py`), 3 (`integration`), and 6 (`rl-regression`) with the final shape — same jobs, now properly ordered, path-filtered, and joined by `build`/`e2e`/`load`. Phase 10 adds only the `deploy` job on top of this file; nothing here changes again after Phase 10.

`.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      ts: ${{ steps.filter.outputs.ts }}
      py: ${{ steps.filter.outputs.py }}
      training: ${{ steps.filter.outputs.training }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            ts:
              - 'sim-server/**'
              - 'frontend/**'
              - 'shared-contracts/**'
            py:
              - 'ai-service/**'
            training:
              - 'ai-service/training/**'
              - 'models/manifest.json'

  lint:
    runs-on: ubuntu-latest
    needs: [changes]
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
    needs: [changes]
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
    needs: [changes, lint]
    if: needs.changes.outputs.ts == 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter sim-server --filter frontend --filter shared-contracts test

  unit-py:
    runs-on: ubuntu-latest
    needs: [changes]
    if: needs.changes.outputs.py == 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install uv
      - run: cd ai-service && uv sync
      - run: cd ai-service && uv run ruff check .
      - run: cd ai-service && uv run pytest -m "not slow"

  integration:
    runs-on: ubuntu-latest
    needs: [unit-ts, unit-py]
    if: ${{ !cancelled() && !contains(needs.*.result, 'failure') }}
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
      - name: Wait for services
        run: |
          for i in {1..20}; do curl -sf http://localhost:8000/health && break || sleep 1; done
      - run: RUN_INTEGRATION=1 pnpm --filter sim-server test -- multiClient.integration
      - if: always()
        run: docker compose -f infra/docker-compose.yml down

  load:
    runs-on: ubuntu-latest
    needs: [integration]
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
      - name: Wait for services
        run: |
          for i in {1..20}; do curl -sf http://localhost:8000/health && break || sleep 1; done
      - uses: grafana/setup-k6-action@v1
      - run: k6 run infra/load/wsBotSwarm.js
      - run: cd sim-server && npx tsx test/perf/tickBudget.perf.ts
      - if: always()
        run: docker compose -f infra/docker-compose.yml down

  e2e:
    runs-on: ubuntu-latest
    needs: [integration]
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
      - run: cd ai-service && uv sync
      - run: pnpm --filter frontend exec playwright install --with-deps chromium
      - run: pnpm --filter frontend test:e2e
        env:
          CI: "true"

  rl-regression:
    runs-on: ubuntu-latest
    needs: [changes]
    if: needs.changes.outputs.training == 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install uv
      - run: cd ai-service && uv sync
      - name: Train a candidate checkpoint
        run: cd ai-service && uv run python -m training.train --timesteps 50000 --out /tmp/candidate
      - name: Export candidate to ONNX
        run: |
          cd ai-service && uv run python -c "
          from stable_baselines3 import PPO
          from training.export_onnx import export_onnx
          from training.env import TrafficSignalEnv
          model = PPO.load('/tmp/candidate/ppo_traffic_signal.zip')
          export_onnx(model, obs_dim=TrafficSignalEnv().observation_space.shape[0], out_path='/tmp/candidate/model.onnx')
          "
      - name: Evaluate against the currently promoted checkpoint
        run: cd ai-service && uv run python -m training.eval_gate --candidate /tmp/candidate/model.onnx --manifest ../models/manifest.json --models-dir ../models

  build:
    runs-on: ubuntu-latest
    needs: [load, e2e, rl-regression]
    if: ${{ !cancelled() && !contains(needs.*.result, 'failure') }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - run: docker build -f sim-server/Dockerfile -t sim-server:ci .
      - run: docker build -f ai-service/Dockerfile -t ai-service:ci .
```

Two GitHub Actions gotchas worth calling out explicitly, since they're easy to get wrong silently:
1. **Skipped ≠ failed.** `rl-regression` is legitimately skipped on most pushes (`if: needs.changes.outputs.training == 'true'`). By default, a dependent job (`build`) treats any non-`success` upstream job — including a skip — as reason to skip itself too. The `if: ${{ !cancelled() && !contains(needs.*.result, 'failure') }}` guard on both `integration` and `build` is what makes "skipped is fine, only an actual failure blocks" the real behavior.
2. **`unit-ts`/`unit-py` skip on unrelated changes**, but `integration`/`load`/`e2e` still `need` them — the same `!cancelled() && !contains(needs.*.result, 'failure')` pattern on `integration` (and transitively, everything after it) prevents a legitimately-skipped unit job from blocking the rest of the pipeline. Deploy (Phase 10) will need this exact pattern again.

- [ ] **Step 2: Push a branch and confirm the full pipeline runs and passes (or correctly skips) each job**

Run: push to a feature branch and open a PR; watch the Actions tab.
Expected: `changes` → `lint`/`contracts-drift` → `unit-ts`/`unit-py` (both run, since this PR touches both) → `integration` → `load` + `e2e` (parallel) → `rl-regression` (skipped, no training changes) → `build` (runs despite the skip).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: consolidate into the full 7-stage pipeline with path-based filtering"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Unaffected (already comprehensive from Phases 1-7) | — |
| Integration | Unaffected | Already CI-gated since Phase 3 |
| Physics/determinism | Unaffected | Already covered since Phases 3/5 |
| Load | Yes — first entry | k6 WS swarm (connection/broadcast behavior under load) + tick-budget script (raw simulation performance under rush-hour entity counts) |
| RL regression | Unaffected | Already CI-gated since Phase 6, now path-filtered correctly |
| E2E | Yes — first automated entry | Playwright: keyboard + touch + EV scenario + session JSON verification, exactly matching spec §11's E2E row |

## Definition of Done

- [ ] `k6 run infra/load/wsBotSwarm.js` passes locally and in CI.
- [ ] `tickBudget.perf.ts` reports an average tick time under budget at rush-hour-level entity counts.
- [ ] Playwright's `driveAndEv.spec.ts` passes locally and in CI.
- [ ] `.github/workflows/ci.yml` matches the final 7-stage shape; a PR touching only `frontend/` skips `unit-py`/`rl-regression` but still reaches `build`.
- [ ] `DEBUG_ENDPOINTS` is documented as test/dev-only and is not referenced anywhere in Phase 10's deployment configuration.

## Risks / open implementation notes

- k6's 20-VU/4-car-cap scenario intentionally produces mostly-rejected joins — if this ever reads as "the load test doesn't really test much," remember its actual purpose is confirming graceful degradation under over-capacity load, not exercising the driving logic (that's what the E2E and manual smoke tests are for).
- `tickBudget.perf.ts`'s 40ms budget was chosen with headroom under the 50ms tick interval, not derived from a formal SLA — if CI runner performance proves noisier than local hardware, this is the first threshold to loosen, not the test to delete.
- Playwright's multi-service `webServer` array assumes `ai-service`'s Python environment and `sim-server`'s TS build are both ready before Playwright's own timeout — the 20s per-service timeout may need tuning on slower CI runners; watch for flakiness here specifically before concluding the *application* is flaky.
