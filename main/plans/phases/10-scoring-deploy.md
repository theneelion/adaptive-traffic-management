# Phase 10: Scoring + Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All four challenge scenarios (rush hour, emergency vehicle, chaos, pedestrian pressure) selectable and scored pass/fail, an in-app KPI panel replacing the need for any external observability stack, and a working Fly.io deployment with a persistent volume for session JSON — the final phase; nothing else in the build order depends on it.

**Architecture:** Scenarios are a configuration + timer concept layered on top of everything built in Phases 1-9 — starting one reconfigures `TrafficController`/`PedestrianController` arrival rates (and, for the EV scenario, auto-spawns the ambulance), runs for a fixed duration, and ends by calling `scoreScenario()` against the accumulated `SessionFile` (KPI snapshots + events already being recorded since Phase 2/5/7). The in-app KPI panel is just another WS broadcast (`KpiUpdateMessage`) consumed by a small frontend HUD — no new backend concept, since the metrics it shows are the same ones already computed for scoring. Deployment consolidates to **two** Fly.io apps, not three: per spec §10's own suggestion, `sim-server` serves the built frontend as static files itself, so only `sim-server` and `ai-service` are deployed services.

**Tech Stack:** `flyctl` (Fly.io CLI, deploy-time only), no new application dependencies.

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §8, §9, §10, §13, §14 step 10, FR-11, FR-12, FR-13, TR-10, TR-13. Also read [`00-overview.md`](00-overview.md) §6 Phase-10 ledger entry. Also read [`02-signal-ai-v1.md`](02-signal-ai-v1.md) Task 8 (`SessionStore`), [`03-multiplayer-collisions.md`](03-multiplayer-collisions.md) Task 6 (`SimSession`), and [`08-testing-cicd-hardening.md`](08-testing-cicd-hardening.md) Task 5 (`ci.yml`'s final shape, which this phase adds one job to).

## Global Constraints

- All Phase 1-9 Global Constraints still apply.
- `FinalScore`'s shape (`{ scenario, result, avgWaitDeltaPct }`, fixed since Phase 2) is reused as-is across all four scenarios — `avgWaitDeltaPct` is repurposed per scenario as "percentage margin relative to that scenario's threshold" (positive = comfortably passed, negative = missed threshold), documented per scenario in Task 3, not redefined as a new field per scenario.
- `DEBUG_ENDPOINTS` (Phase 8) must **not** be set in any Fly.io deployment configuration — it stays test/dev-only.
- The deploy job requires manual approval even though the target is free-tier, per spec §12's explicit reasoning: an accidental deploy could disrupt the persistent session volume mid-demo.

---

### Task 1: Scenario configuration + live reconfiguration

**Files:**
- Create: `shared-contracts/schemas/scenario-control.schema.json`
- Modify: `sim-server/src/vehicles/TrafficController.ts` (add `setArrivalRate`)
- Modify: `sim-server/src/pedestrians/PedestrianController.ts` (add `setArrivalRate`)
- Create: `sim-server/src/scoring/scenarios.ts` (config table; scoring function added in Task 3)
- Modify: `sim-server/src/room/SimSession.ts` (`startScenario`, scenario timer)
- Modify: `sim-server/src/server.ts` (route `start_scenario` message)
- Test: `sim-server/test/scoring/scenarios.config.test.ts`
- Test: `sim-server/test/room/SimSession.scenario.test.ts`

**Interfaces:**
- Produces: `StartScenarioMessage = { type: "start_scenario"; payload: { scenario: Scenario }; ts: number }`.
- Produces (Interface ledger, Phase 10): `type Scenario = "rush_hour" | "emergency_vehicle" | "chaos" | "pedestrian_pressure"`, `SCENARIO_CONFIGS: Record<Scenario, ScenarioConfig>` where `ScenarioConfig = { vehicleArrivalRatePerMin: number; pedestrianArrivalRatePerMin: number; durationS: number; autoSpawnEv: boolean }`.
- Produces: `TrafficController.setArrivalRate(ratePerMinPerApproach: number): void`, `PedestrianController.setArrivalRate(ratePerMinPerNode: number): void` (both replace the internal `TrafficSpawner` with a freshly-configured one, preserving already-tracked entities).

- [ ] **Step 1: Add the schema**

`shared-contracts/schemas/scenario-control.schema.json`:
```json
{
  "$id": "StartScenarioMessage",
  "type": "object",
  "required": ["type", "payload", "ts"],
  "properties": {
    "type": { "const": "start_scenario" },
    "ts": { "type": "number" },
    "payload": {
      "type": "object",
      "required": ["scenario"],
      "properties": {
        "scenario": { "enum": ["rush_hour", "emergency_vehicle", "chaos", "pedestrian_pressure"] }
      }
    }
  }
}
```

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 2: Write the scenario config table + failing test**

`sim-server/test/scoring/scenarios.config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { SCENARIO_CONFIGS } from "../../src/scoring/scenarios";

describe("SCENARIO_CONFIGS", () => {
  it("defines all four required scenarios", () => {
    expect(Object.keys(SCENARIO_CONFIGS).sort()).toEqual(
      ["chaos", "emergency_vehicle", "pedestrian_pressure", "rush_hour"].sort()
    );
  });

  it("rush_hour elevates both vehicle and pedestrian arrival rates above pedestrian_pressure's baseline vehicle rate", () => {
    expect(SCENARIO_CONFIGS.rush_hour.vehicleArrivalRatePerMin).toBeGreaterThan(SCENARIO_CONFIGS.chaos.vehicleArrivalRatePerMin);
  });

  it("only emergency_vehicle auto-spawns an EV", () => {
    expect(SCENARIO_CONFIGS.emergency_vehicle.autoSpawnEv).toBe(true);
    expect(SCENARIO_CONFIGS.rush_hour.autoSpawnEv).toBe(false);
  });

  it("pedestrian_pressure elevates pedestrian rate well above vehicle rate", () => {
    const cfg = SCENARIO_CONFIGS.pedestrian_pressure;
    expect(cfg.pedestrianArrivalRatePerMin).toBeGreaterThan(cfg.vehicleArrivalRatePerMin);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- scenarios.config`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the scenario config table**

`sim-server/src/scoring/scenarios.ts`:
```ts
export type Scenario = "rush_hour" | "emergency_vehicle" | "chaos" | "pedestrian_pressure";

export interface ScenarioConfig {
  vehicleArrivalRatePerMin: number;
  pedestrianArrivalRatePerMin: number;
  durationS: number;
  autoSpawnEv: boolean;
}

export const SCENARIO_CONFIGS: Record<Scenario, ScenarioConfig> = {
  rush_hour: { vehicleArrivalRatePerMin: 60, pedestrianArrivalRatePerMin: 40, durationS: 120, autoSpawnEv: false },
  emergency_vehicle: { vehicleArrivalRatePerMin: 30, pedestrianArrivalRatePerMin: 20, durationS: 60, autoSpawnEv: true },
  chaos: { vehicleArrivalRatePerMin: 30, pedestrianArrivalRatePerMin: 20, durationS: 90, autoSpawnEv: false },
  pedestrian_pressure: { vehicleArrivalRatePerMin: 20, pedestrianArrivalRatePerMin: 70, durationS: 120, autoSpawnEv: false }
};
```
(These rates are starting points, not tuned — reasonable to revisit after watching a few real scenario runs, same caveat as Phase 6's reward weights.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- scenarios.config`
Expected: PASS (4 tests).

- [ ] **Step 6: Add `setArrivalRate` to `PedestrianController`**

`TrafficController.setArrivalRate()` already exists — Phase 3's Task 3 built it in from the start (storing the constructor's `rng` as `this.rng` specifically so this method could reuse it deterministically, rather than falling back to `Math.random`). Only `PedestrianController` still needs it here.

Modify `sim-server/src/pedestrians/PedestrianController.ts` — store the constructor's `rng` parameter as `private readonly rng: () => number` (Phase 5 passed it straight through to the initial `TrafficSpawner` without keeping a reference; keep one now), drop `readonly` from the `spawner` field, and add:
```ts
setArrivalRate(ratePerMinPerNode: number): void {
  this.spawner = new TrafficSpawner(this.farNodeIds, this.rng, ratePerMinPerNode);
}
```

Modify `sim-server/src/pedestrians/PedestrianController.ts` similarly — store `this.rng`, drop `readonly` from `spawner`, add:
```ts
setArrivalRate(ratePerMinPerNode: number): void {
  this.spawner = new TrafficSpawner(this.farNodeIds, this.rng, ratePerMinPerNode);
}
```

- [ ] **Step 7: Wire scenario start into `SimSession`**

Modify `sim-server/src/room/SimSession.ts` — add fields `private activeScenario: Scenario | null = null;` and `private scenarioElapsedS = 0;`, and a method:
```ts
startScenario(scenario: Scenario): void {
  const config = SCENARIO_CONFIGS[scenario];
  this.traffic.setArrivalRate(config.vehicleArrivalRatePerMin);
  this.pedestrians.setArrivalRate(config.pedestrianArrivalRatePerMin);
  this.activeScenario = scenario;
  this.scenarioElapsedS = 0;
  this.store.create(this.sessionId, { mapId: this.mapId, scenario }); // re-tag the session with the chosen scenario
  if (config.autoSpawnEv) this.spawnEmergencyVehicle("app_N", "app_S"); // straight through, matching Phase 7's default debug trigger
}
```
(Add a `private readonly mapId: string;` field set in the constructor from `map.id`, since `store.create` needs it and wasn't previously kept around after construction.)

In `step()`, after the existing per-tick work, add:
```ts
if (this.activeScenario) {
  this.scenarioElapsedS += TICK_MS / 1000;
  if (this.scenarioElapsedS >= SCENARIO_CONFIGS[this.activeScenario].durationS) {
    // Task 3 fills in the actual scoring call here
  }
}
```

- [ ] **Step 8: Route the WS message**

Modify `sim-server/src/server.ts` — add: `if (msg.type === "start_scenario") session.startScenario(msg.payload.scenario);`

- [ ] **Step 9: Write the `SimSession` scenario test**

`sim-server/test/room/SimSession.scenario.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("SimSession scenarios", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "scenario-test-"));
    store = new LocalDiskSessionStore(dir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("starting emergency_vehicle auto-spawns an EV", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 30, 10);
    session.startScenario("emergency_vehicle");
    const { snapshot } = await session.step();
    expect(snapshot.payload.vehicles.some((v) => v.controller === "ev")).toBe(true);
  });

  it("starting a scenario retags the session file with that scenario", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 30, 11);
    session.startScenario("rush_hour");
    expect(store.read(session.sessionId).scenario).toBe("rush_hour");
  });
});
```

- [ ] **Step 10: Run test to verify it passes, commit**

Run: `pnpm --filter sim-server test -- SimSession.scenario scenarios.config`
Expected: PASS.

```bash
git add shared-contracts/schemas/scenario-control.schema.json shared-contracts/generated ai-service/app/contracts sim-server/src/vehicles/TrafficController.ts sim-server/src/pedestrians/PedestrianController.ts sim-server/src/scoring/scenarios.ts sim-server/src/room/SimSession.ts sim-server/src/server.ts sim-server/test/scoring/scenarios.config.test.ts sim-server/test/room/SimSession.scenario.test.ts
git commit -m "feat(sim-server): scenario configuration and live arrival-rate reconfiguration"
```

---

### Task 2: KPI snapshots + in-app KPI panel

**Files:**
- Create: `shared-contracts/schemas/kpi-update.schema.json`
- Modify: `sim-server/src/room/SimSession.ts` (periodic KPI snapshot computation + broadcast)
- Modify: `frontend/src/scenes/MainScene.ts` (KPI HUD)
- Test: `sim-server/test/room/SimSession.kpi.test.ts`

**Interfaces:**
- Produces: `KpiUpdateMessage = { type: "kpi_update"; payload: { avgVehicleWaitS: number; throughput: number; avgPedWaitS: number; jaywalkEvents: number; currentMode: "rule_based" | "rl" }; ts: number }`.

- [ ] **Step 1: Add the schema**

`shared-contracts/schemas/kpi-update.schema.json`:
```json
{
  "$id": "KpiUpdateMessage",
  "type": "object",
  "required": ["type", "payload", "ts"],
  "properties": {
    "type": { "const": "kpi_update" },
    "ts": { "type": "number" },
    "payload": {
      "type": "object",
      "required": ["avgVehicleWaitS", "throughput", "avgPedWaitS", "jaywalkEvents", "currentMode"],
      "properties": {
        "avgVehicleWaitS": { "type": "number" },
        "throughput": { "type": "number" },
        "avgPedWaitS": { "type": "number" },
        "jaywalkEvents": { "type": "integer" },
        "currentMode": { "enum": ["rule_based", "rl"] }
      }
    }
  }
}
```

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 2: Write the failing test for periodic KPI snapshotting**

`sim-server/test/room/SimSession.kpi.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("SimSession KPI snapshots", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kpi-test-"));
    store = new LocalDiskSessionStore(dir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes a KPI snapshot roughly every 10 seconds of simulated time", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 60, 20);
    for (let i = 0; i < 400; i++) await session.step(); // 400 * 50ms = 20s

    const file = store.read(session.sessionId);
    expect(file.kpiSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(file.kpiSnapshots[0]).toHaveProperty("avgVehicleWaitS");
    expect(file.kpiSnapshots[0]).toHaveProperty("avgPedWaitS");
  });

  it("step() returns a kpiUpdate alongside the snapshot and roomEvents whenever a new KPI snapshot is taken", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 60, 21);
    let sawKpiUpdate = false;
    for (let i = 0; i < 400; i++) {
      const result = await session.step();
      if (result.kpiUpdate) sawKpiUpdate = true;
    }
    expect(sawKpiUpdate).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- SimSession.kpi`
Expected: FAIL — `kpiUpdate` isn't part of `step()`'s return value yet.

- [ ] **Step 4: Implement periodic KPI computation in `SimSession`**

Modify `sim-server/src/room/SimSession.ts`:
- Add `private kpiElapsedMs = 0;` and a constant `const KPI_SNAPSHOT_INTERVAL_MS = 10_000;`.
- Add a running counter `private cumulativeJaywalkEvents = 0;` incremented whenever a `vehicle_pedestrian` collision with `cause: "jaywalk"` is logged (in the existing `CollisionLogger` callback).
- In `step()`, after the existing per-tick work:
```ts
this.kpiElapsedMs += TICK_MS;
let kpiUpdate: KpiUpdateMessage | null = null;
if (this.kpiElapsedMs >= KPI_SNAPSHOT_INTERVAL_MS) {
  this.kpiElapsedMs = 0;
  const approachStates = ["app_N", "app_S", "app_E", "app_W"].map((id) => this.detector.getApproachState(id));
  const avgVehicleWaitS = approachStates.reduce((sum, s) => sum + s.waitS, 0) / approachStates.length;
  const throughput = this.traffic.vehicles.length; // current count as a simple proxy — see Risks
  const crossingStates = ["cross_N", "cross_S", "cross_E", "cross_W"].map((id) => this.pedestrians.getCrossingState(id));
  const avgPedWaitS = crossingStates.reduce((sum, s) => sum + s.waitS, 0) / crossingStates.length;

  const snapshot: KpiSnapshot = {
    t: this.tick * (TICK_MS / 1000),
    avgVehicleWaitS,
    throughput,
    avgPedWaitS,
    jaywalkEvents: this.cumulativeJaywalkEvents
  };
  this.store.writeKpiSnapshot(this.sessionId, snapshot);
  kpiUpdate = {
    type: "kpi_update",
    ts: Date.now(),
    payload: { avgVehicleWaitS, throughput, avgPedWaitS, jaywalkEvents: this.cumulativeJaywalkEvents, currentMode: this.lastControllerMode }
  };
}
```
- Track `private lastControllerMode: "rule_based" | "rl" = "rule_based";`, updated from the `/signal-decision` response's `controller` field each time `signalController.step()` resolves (read `decision.controller` — Phase 2's `SignalController.step()` currently only returns `{ phaseId, changed }`; extend it to also return `controller` so `SimSession` can track it without a second round-trip).
- Add `kpiUpdate` to `step()`'s return type and value: `return { snapshot, roomEvents, kpiUpdate };`.

Modify `sim-server/src/signals/SignalController.ts` — widen `step()`'s return type to `{ phaseId: string; changed: boolean; controller: string }`, including `controller: decision.controller` from the resolved `SignalDecisionResponse`. Update Phase 2/5/6's `SignalController` tests only if this breaks their return-value assertions (it doesn't — none of them destructure or assert on a `controller` field today, so this is purely additive to the return object).

- [ ] **Step 5: Broadcast `kpiUpdate` from `server.ts`**

Modify `sim-server/src/server.ts` — in the `setInterval` callback, after broadcasting `roomEvents`:
```ts
if (kpiUpdate) {
  const payload = JSON.stringify(kpiUpdate);
  for (const socket of socketsByClientId.values()) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- SimSession.kpi`
Expected: PASS (2 tests).

- [ ] **Step 7: Add the KPI HUD to the frontend**

Modify `frontend/src/scenes/MainScene.ts` — add a text object and a `SimClient` handler:
```ts
private kpiText!: Phaser.GameObjects.Text;

// in create():
this.kpiText = this.add.text(10, 40, "", { fontSize: "12px", color: "#ffffff" }).setScrollFactor(0);
this.client.onKpiUpdate((kpi) => {
  this.kpiText.setText(
    `Avg wait: ${kpi.avgVehicleWaitS.toFixed(1)}s | Throughput: ${kpi.throughput} | ` +
    `Ped wait: ${kpi.avgPedWaitS.toFixed(1)}s | Jaywalks: ${kpi.jaywalkEvents} | Mode: ${kpi.currentMode}`
  );
});
```

Modify `frontend/src/net/SimClient.ts` — add the `onKpiUpdate` handler mirroring `onState`/`onJoined`:
```ts
private kpiHandler: ((payload: KpiUpdateMessage["payload"]) => void) | null = null;

onKpiUpdate(cb: (payload: KpiUpdateMessage["payload"]) => void): void {
  this.kpiHandler = cb;
}
// in onmessage: if (msg.type === "kpi_update" && this.kpiHandler) this.kpiHandler(msg.payload);
```

- [ ] **Step 8: Run the frontend suite, commit**

Run: `pnpm --filter frontend test`
Expected: PASS.

```bash
git add shared-contracts/schemas/kpi-update.schema.json shared-contracts/generated ai-service/app/contracts sim-server/src/room/SimSession.ts sim-server/src/signals/SignalController.ts sim-server/src/server.ts frontend/src/scenes/MainScene.ts frontend/src/net/SimClient.ts
git commit -m "feat: periodic KPI snapshots recorded and broadcast; in-app KPI panel"
```

---

### Task 3: Scenario scoring + end-of-run flow

**Files:**
- Modify: `sim-server/src/session/SessionEvent.ts` (add `EvCompleteEvent`)
- Modify: `sim-server/src/ev/EvRouter.ts` — **no change needed**; despawn is already observable from `SimSession` by diffing `activeVehicle()` before/after `evRouter.step()`
- Modify: `sim-server/src/room/SimSession.ts` (detect EV completion, log it; call `scoreScenario` at scenario end)
- Create: `sim-server/src/scoring/scoreScenario.ts`
- Modify: `shared-contracts/schemas/scenario-control.schema.json` (add `ScenarioCompleteMessage`)
- Modify: `frontend/src/scenes/MainScene.ts` (show pass/fail result)
- Test: `sim-server/test/scoring/scoreScenario.test.ts`

**Interfaces:**
- Produces (Interface ledger, Phase 10): `function scoreScenario(scenario: Scenario, session: SessionFile): FinalScore`.
- Produces: `ScenarioCompleteMessage = { type: "scenario_complete"; payload: FinalScore; ts: number }`.

- [ ] **Step 1: Add `EvCompleteEvent`**

Modify `sim-server/src/session/SessionEvent.ts`:
```ts
export interface EvCompleteEvent {
  t: number;
  type: "ev_complete";
  evId: string;
  transitTimeS: number;
}

export type SessionEvent =
  | PhaseChangeEvent
  | UserJoinEvent
  | UserLeaveEvent
  | CollisionEvent
  | EvSpawnEvent
  | EvPreemptEvent
  | EvCompleteEvent;
```

- [ ] **Step 2: Write the failing test for `scoreScenario`**

`sim-server/test/scoring/scoreScenario.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { scoreScenario } from "../../src/scoring/scoreScenario";
import type { SessionFile } from "../../src/session/SessionEvent";

function baseSession(overrides: Partial<SessionFile>): SessionFile {
  return {
    sessionId: "s1",
    startedAt: new Date(0).toISOString(),
    mapId: "grid_1x1_v1",
    scenario: null,
    participants: [],
    events: [],
    kpiSnapshots: [],
    finalScore: null,
    ...overrides
  };
}

describe("scoreScenario", () => {
  it("rush_hour passes when avg wait stays under threshold", () => {
    const session = baseSession({
      kpiSnapshots: [{ t: 10, avgVehicleWaitS: 10, throughput: 5, avgPedWaitS: 5, jaywalkEvents: 0 }]
    });
    const score = scoreScenario("rush_hour", session);
    expect(score.result).toBe("pass");
  });

  it("rush_hour fails when avg wait exceeds threshold", () => {
    const session = baseSession({
      kpiSnapshots: [{ t: 10, avgVehicleWaitS: 45, throughput: 2, avgPedWaitS: 5, jaywalkEvents: 0 }]
    });
    const score = scoreScenario("rush_hour", session);
    expect(score.result).toBe("fail");
  });

  it("emergency_vehicle passes when ev_preempt fired and transit time is under threshold", () => {
    const session = baseSession({
      events: [
        { t: 0, type: "ev_spawn", evId: "amb_1", route: ["app_N", "int_1", "app_S"] },
        { t: 4, type: "ev_preempt", intersection: "int_1", etaS: 8 },
        { t: 20, type: "ev_complete", evId: "amb_1", transitTimeS: 20 }
      ]
    });
    const score = scoreScenario("emergency_vehicle", session);
    expect(score.result).toBe("pass");
  });

  it("emergency_vehicle fails when no preemption occurred", () => {
    const session = baseSession({
      events: [
        { t: 0, type: "ev_spawn", evId: "amb_1", route: ["app_N", "int_1", "app_S"] },
        { t: 30, type: "ev_complete", evId: "amb_1", transitTimeS: 30 }
      ]
    });
    const score = scoreScenario("emergency_vehicle", session);
    expect(score.result).toBe("fail");
  });

  it("chaos passes when wait rose substantially between the start and end of the run", () => {
    const session = baseSession({
      kpiSnapshots: [
        { t: 10, avgVehicleWaitS: 5, throughput: 5, avgPedWaitS: 3, jaywalkEvents: 0 },
        { t: 20, avgVehicleWaitS: 5, throughput: 5, avgPedWaitS: 3, jaywalkEvents: 0 },
        { t: 80, avgVehicleWaitS: 20, throughput: 2, avgPedWaitS: 3, jaywalkEvents: 0 },
        { t: 90, avgVehicleWaitS: 22, throughput: 2, avgPedWaitS: 3, jaywalkEvents: 0 }
      ]
    });
    const score = scoreScenario("chaos", session);
    expect(score.result).toBe("pass");
  });

  it("chaos passes when at least one collision occurred, even without a large wait increase", () => {
    const session = baseSession({
      kpiSnapshots: [
        { t: 10, avgVehicleWaitS: 5, throughput: 5, avgPedWaitS: 3, jaywalkEvents: 0 },
        { t: 90, avgVehicleWaitS: 5, throughput: 5, avgPedWaitS: 3, jaywalkEvents: 0 }
      ],
      events: [{ t: 45, type: "collision", entities: ["car_1", "car_2"], kind: "vehicle_vehicle" }]
    });
    const score = scoreScenario("chaos", session);
    expect(score.result).toBe("pass");
  });

  it("pedestrian_pressure passes when ped wait stays under threshold", () => {
    const session = baseSession({
      kpiSnapshots: [{ t: 10, avgVehicleWaitS: 8, throughput: 5, avgPedWaitS: 6, jaywalkEvents: 1 }]
    });
    const score = scoreScenario("pedestrian_pressure", session);
    expect(score.result).toBe("pass");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- scoreScenario`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `scoreScenario`**

`sim-server/src/scoring/scoreScenario.ts`:
```ts
import type { SessionFile, FinalScore } from "../session/SessionEvent";
import type { Scenario } from "./scenarios";

const RUSH_HOUR_WAIT_THRESHOLD_S = 20;
const EV_TRANSIT_THRESHOLD_S = 35;
const CHAOS_WAIT_INCREASE_THRESHOLD_PCT = 15;
const PED_WAIT_THRESHOLD_S = 12;

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : 0;
}

export function scoreScenario(scenario: Scenario, session: SessionFile): FinalScore {
  switch (scenario) {
    case "rush_hour":
      return scoreThresholded(scenario, avg(session.kpiSnapshots.map((k) => k.avgVehicleWaitS)), RUSH_HOUR_WAIT_THRESHOLD_S);

    case "pedestrian_pressure":
      return scoreThresholded(scenario, avg(session.kpiSnapshots.map((k) => k.avgPedWaitS)), PED_WAIT_THRESHOLD_S);

    case "emergency_vehicle": {
      const preempted = session.events.some((e) => e.type === "ev_preempt");
      const complete = session.events.find((e) => e.type === "ev_complete");
      const transitTimeS = complete && complete.type === "ev_complete" ? complete.transitTimeS : Infinity;
      const pass = preempted && transitTimeS <= EV_TRANSIT_THRESHOLD_S;
      const deltaPct = ((EV_TRANSIT_THRESHOLD_S - transitTimeS) / EV_TRANSIT_THRESHOLD_S) * 100;
      return { scenario, result: pass ? "pass" : "fail", avgWaitDeltaPct: deltaPct };
    }

    case "chaos": {
      const hasCollision = session.events.some((e) => e.type === "collision");
      const snapshots = session.kpiSnapshots;
      const firstHalf = snapshots.slice(0, Math.ceil(snapshots.length / 2));
      const secondHalf = snapshots.slice(Math.ceil(snapshots.length / 2));
      const baselineWait = avg(firstHalf.map((k) => k.avgVehicleWaitS));
      const finalWait = avg(secondHalf.map((k) => k.avgVehicleWaitS));
      const increasePct = baselineWait === 0 ? (finalWait > 0 ? 100 : 0) : ((finalWait - baselineWait) / baselineWait) * 100;
      const pass = increasePct >= CHAOS_WAIT_INCREASE_THRESHOLD_PCT || hasCollision;
      return { scenario, result: pass ? "pass" : "fail", avgWaitDeltaPct: increasePct };
    }
  }
}

function scoreThresholded(scenario: Scenario, actual: number, thresholdS: number): FinalScore {
  const deltaPct = ((thresholdS - actual) / thresholdS) * 100;
  return { scenario, result: actual <= thresholdS ? "pass" : "fail", avgWaitDeltaPct: deltaPct };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- scoreScenario`
Expected: PASS (7 tests).

- [ ] **Step 6: Detect EV completion and wire scoring into `SimSession`**

Modify `sim-server/src/room/SimSession.ts`:
- Before calling `this.evRouter.step(TICK_MS)`, capture `const evBefore = this.evRouter.activeVehicle();` with its spawn tick recorded (add a `private evSpawnTick: number | null = null;` field, set in `spawnEmergencyVehicle` alongside the existing `ev_spawn` write). After stepping, if `evBefore` existed and `this.evRouter.activeVehicle()` is now `null`, log:
```ts
this.store.writeEvent(this.sessionId, {
  t: this.tick * (TICK_MS / 1000),
  type: "ev_complete",
  evId: evBefore.id,
  transitTimeS: this.tick * (TICK_MS / 1000) - (this.evSpawnTick ?? 0)
});
this.evSpawnTick = null;
```
- Add the schema/type for `ScenarioCompleteMessage` (Step 7 below), then complete the `step()` scenario-end block sketched in Task 1 Step 7:
```ts
if (this.activeScenario) {
  this.scenarioElapsedS += TICK_MS / 1000;
  if (this.scenarioElapsedS >= SCENARIO_CONFIGS[this.activeScenario].durationS) {
    const finalScore = scoreScenario(this.activeScenario, this.store.read(this.sessionId));
    this.store.finalize(this.sessionId, finalScore);
    scenarioCompleteMessage = { type: "scenario_complete", ts: Date.now(), payload: finalScore };
    this.activeScenario = null;
  }
}
```
(Declare `let scenarioCompleteMessage: ScenarioCompleteMessage | null = null;` near the top of `step()`, and add it to the returned object: `return { snapshot, roomEvents, kpiUpdate, scenarioCompleteMessage };`.)

- [ ] **Step 7: Add the `ScenarioCompleteMessage` schema**

Modify `shared-contracts/schemas/scenario-control.schema.json` — this file's top-level `$id` currently only describes `StartScenarioMessage`; restructure it the same way `signal-decision.schema.json` holds two named types (Phase 2 Task 1's pattern):
```json
{
  "$id": "ScenarioControl",
  "definitions": {},
  "type": "object",
  "properties": {
    "StartScenarioMessage": { "...": "as written in Task 1 Step 1, unchanged" },
    "ScenarioCompleteMessage": {
      "type": "object",
      "required": ["type", "payload", "ts"],
      "properties": {
        "type": { "const": "scenario_complete" },
        "ts": { "type": "number" },
        "payload": {
          "type": "object",
          "required": ["scenario", "result", "avgWaitDeltaPct"],
          "properties": {
            "scenario": { "type": "string" },
            "result": { "enum": ["pass", "fail"] },
            "avgWaitDeltaPct": { "type": "number" }
          }
        }
      }
    }
  }
}
```

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 8: Broadcast it from `server.ts`, show it in the frontend**

Modify `sim-server/src/server.ts` — broadcast `scenarioCompleteMessage` the same way `kpiUpdate` is broadcast (Task 2 Step 5's pattern).

Modify `frontend/src/scenes/MainScene.ts` — add `this.client.onScenarioComplete((result) => { this.showScenarioResult(result); });` and a simple `showScenarioResult` that displays a centered pass/fail banner for a few seconds (a `Phaser.GameObjects.Text`, removed via `this.time.delayedCall`).

Modify `frontend/src/net/SimClient.ts` — add `onScenarioComplete` mirroring the other handlers.

- [ ] **Step 9: Run the full sim-server and frontend suites, commit**

Run: `pnpm -r test`
Expected: PASS.

```bash
git add sim-server/src/session/SessionEvent.ts sim-server/src/scoring/scoreScenario.ts sim-server/src/room/SimSession.ts sim-server/src/server.ts shared-contracts/schemas/scenario-control.schema.json shared-contracts/generated ai-service/app/contracts frontend/src/scenes/MainScene.ts frontend/src/net/SimClient.ts sim-server/test/scoring/scoreScenario.test.ts
git commit -m "feat: scenario pass/fail scoring for all four challenge scenarios, broadcast end-to-end"
```

---

### Task 4: Frontend scenario selection UI

**Files:**
- Modify: `frontend/src/scenes/MainScene.ts`

- [ ] **Step 1: Add four scenario buttons**

Modify `frontend/src/scenes/MainScene.ts` — in `create()`:
```ts
const scenarios: Array<{ id: string; label: string }> = [
  { id: "rush_hour", label: "Rush Hour" },
  { id: "emergency_vehicle", label: "Emergency Vehicle" },
  { id: "chaos", label: "Chaos" },
  { id: "pedestrian_pressure", label: "Pedestrian Pressure" }
];
scenarios.forEach((s, i) => {
  const button = this.add.text(10, 60 + i * 18, `[${s.label}]`, { fontSize: "12px", color: "#88ccff" }).setInteractive();
  button.on("pointerdown", () => this.client.sendStartScenario(s.id as any));
});
```

Modify `frontend/src/net/SimClient.ts` — add:
```ts
sendStartScenario(scenario: "rush_hour" | "emergency_vehicle" | "chaos" | "pedestrian_pressure"): void {
  this.socket.send(JSON.stringify({ type: "start_scenario", ts: Date.now(), payload: { scenario } }));
}
```

- [ ] **Step 2: Run the frontend suite, commit**

Run: `pnpm --filter frontend test`
Expected: PASS.

```bash
git add frontend/src/scenes/MainScene.ts frontend/src/net/SimClient.ts
git commit -m "feat(frontend): scenario selection buttons"
```

---

### Task 5: Fly.io deployment configuration (two apps)

**Files:**
- Create: `infra/fly/sim-server.fly.toml`
- Create: `infra/fly/ai-service.fly.toml`
- Modify: `sim-server/Dockerfile` (multi-stage: build frontend, copy `dist` in)
- Modify: `sim-server/src/server.ts` (serve `frontend/dist` as static files)
- Modify: `README.md` (one-time manual Fly.io setup steps)

**Interfaces:** none new — deployment configuration only.

- [ ] **Step 1: Serve the built frontend from `sim-server`**

Modify `sim-server/src/server.ts` — widen the `createServer` request handler (already gated for `/debug/session` since Phase 8) to also serve static files:
```ts
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const FRONTEND_DIST = path.resolve(import.meta.dirname, "../../frontend/dist");
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png"
};

const httpServer = createServer((req, res) => {
  if (process.env.DEBUG_ENDPOINTS === "1" && req.url === "/debug/session") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(session.debugReadSession()));
    return;
  }

  const requestedPath = req.url === "/" || !req.url ? "/index.html" : req.url;
  const filePath = path.join(FRONTEND_DIST, requestedPath);
  if (existsSync(FRONTEND_DIST) && existsSync(filePath) && filePath.startsWith(FRONTEND_DIST)) {
    res.setHeader("Content-Type", MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream");
    res.end(readFileSync(filePath));
    return;
  }

  res.statusCode = 404;
  res.end();
});
```
(`filePath.startsWith(FRONTEND_DIST)` guards against a `..`-traversal request escaping the dist directory — a minimal but necessary check now that this server accepts arbitrary request paths.)

- [ ] **Step 2: Extend `sim-server`'s Dockerfile to a multi-stage build including the frontend**

Modify `sim-server/Dockerfile`:
```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter shared-contracts generate
RUN pnpm --filter frontend build
RUN pnpm --filter sim-server build

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/sim-server/dist ./sim-server/dist
COPY --from=build /app/sim-server/node_modules ./sim-server/node_modules
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/maps ./maps
CMD ["node", "sim-server/dist/server.js"]
```

- [ ] **Step 3: Write the Fly.io configs**

`infra/fly/sim-server.fly.toml`:
```toml
app = "traffic-sim-server"
primary_region = "iad"

[build]
  dockerfile = "../../sim-server/Dockerfile"

[env]
  AI_SERVICE_URL = "http://traffic-ai-service.internal:8000"
  SESSION_STORE_DIR = "/data/sessions"
  ARRIVAL_RATE_PER_MIN = "20"

[[mounts]]
  source = "sessions_data"
  destination = "/data"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    port = 80
    handlers = ["http"]
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

`infra/fly/ai-service.fly.toml`:
```toml
app = "traffic-ai-service"
primary_region = "iad"

[build]
  dockerfile = "../../ai-service/Dockerfile"

[[services]]
  internal_port = 8000
  protocol = "tcp"
  # No public [[services.ports]] — reached only via Fly's private .internal networking from traffic-sim-server.
```

- [ ] **Step 4: Document the one-time manual setup**

Append to `README.md`:
```markdown
## Fly.io deployment (one-time manual setup)
\`\`\`bash
flyctl auth login
flyctl apps create traffic-sim-server
flyctl apps create traffic-ai-service
flyctl volumes create sessions_data --app traffic-sim-server --size 1 --region iad
\`\`\`
After this, deploys happen via the `deploy` CI job (Task 6) — do not run `flyctl deploy` manually except to debug a failed CI deploy.
```

- [ ] **Step 5: Manual first deploy to confirm the configs work, before wiring CI**

Run: `flyctl deploy --config infra/fly/ai-service.fly.toml` then `flyctl deploy --config infra/fly/sim-server.fly.toml`
Expected: both apps deploy successfully; visiting `https://traffic-sim-server.fly.dev` serves the frontend and the sim runs end-to-end against the deployed `ai-service`.

- [ ] **Step 6: Commit**

```bash
git add infra/fly sim-server/Dockerfile sim-server/src/server.ts README.md
git commit -m "feat: Fly.io deployment configs (two apps, sim-server serves the built frontend, persistent session volume)"
```

---

### Task 6: `deploy` CI job with manual approval gate

**Files:**
- Modify: `.github/workflows/ci.yml` (add the final `deploy` job)

- [ ] **Step 1: Create a GitHub Environment requiring manual approval**

This is a one-time manual step in GitHub's UI, not expressible in YAML: repo Settings → Environments → New environment named `production` → add yourself (or the team) as a required reviewer. Do this before the workflow below can actually gate on it.

- [ ] **Step 2: Add the `deploy` job**

Append to `.github/workflows/ci.yml`:
```yaml
  deploy:
    runs-on: ubuntu-latest
    needs: [build]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --config infra/fly/ai-service.fly.toml --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      - run: flyctl deploy --config infra/fly/sim-server.fly.toml --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

`environment: production` is what makes this job pause for the manual approval configured in Step 1 — GitHub Actions will not run this job's steps until a required reviewer approves it in the Actions run's UI, exactly matching spec §12's "manual approval gate recommended even on free tier" note.

- [ ] **Step 3: Add the Fly.io API token to repo secrets**

Manual step: `flyctl tokens create deploy` (or equivalent from the Fly.io dashboard), then add it as `FLY_API_TOKEN` under repo Settings → Secrets and variables → Actions.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add gated Fly.io deploy job as the final pipeline stage"
```

---

### Task 7: Final full-system manual verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the final end-to-end checklist**

Append to `README.md`:
```markdown
## Final full-system manual verification (Phase 10)
Run this against the deployed Fly.io URL, not just localhost, at least once:
1. Load the deployed frontend URL; confirm it connects and a car can be claimed and driven (keyboard and touch).
2. Start each of the four scenarios in turn; confirm each ends with a visible pass/fail result matching the KPI values shown in the HUD during the run.
3. Confirm the KPI panel updates live: avg wait, throughput, pedestrian wait, jaywalk count, current AI mode.
4. Toggle classical/RL mode mid-session; confirm signal behavior visibly changes.
5. Trigger the emergency-vehicle scenario; confirm preemption and release both happen, and the session JSON (if `DEBUG_ENDPOINTS` is enabled in a throwaway local run — never against production) shows `ev_spawn`, `ev_preempt`, and `ev_complete`.
6. Restart the `traffic-sim-server` Fly.io app (`flyctl apps restart traffic-sim-server`) and confirm previously-written session files under the persistent volume survive the restart.
7. Confirm the repo is private and access has been shared only with the intended reviewers.
```

- [ ] **Step 2: Perform the 7-step checklist against the real deployment**

Run: (manual, against `https://traffic-sim-server.fly.dev`)
Expected: all 7 steps pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: final full-system verification checklist"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes | `SCENARIO_CONFIGS`, `scoreScenario` (all 4 scenarios, both pass and fail branches) |
| Integration | Extended implicitly | `SimSession` scenario/KPI tests exercise the full controller stack together |
| Physics/determinism | Unaffected | No physics changes this phase |
| Load | Unaffected | No new hot-path logic |
| RL regression | Unaffected | — |
| E2E | Extended (recommend, not required by this plan) | Phase 8's Playwright suite could gain a scenario-selection-and-scoring spec; not written here to keep this phase's scope to what the spec's build order actually asks for — flagged as a natural follow-up, not a gap in Definition of Done |

## Definition of Done

- [ ] All four scenarios are selectable from the frontend and each produces a pass/fail result matching `scoreScenario`'s logic.
- [ ] The in-app KPI panel updates live with all five fields spec §9 names.
- [ ] `sim-server` serves the built frontend directly; only two Fly.io apps are deployed.
- [ ] The persistent volume survives an app restart with session data intact.
- [ ] The `deploy` CI job requires manual approval and only triggers on push to `main`.
- [ ] The Phase 10 Task 7 checklist passes against the real deployed URL.
- [ ] Every FR/TR in the spec (§15/§16) has a corresponding implemented piece across Phases 1-10 — this is the point to do that final full read-through, not defer it further.

## Risks / open implementation notes

- `throughput` in the KPI snapshot (Task 2) is approximated as "current tracked vehicle count," not "vehicles served in the last interval" — a truer throughput metric would need `TrafficController` to expose a served-count delta, which it doesn't yet. This is a reasonable placeholder for a demo KPI panel; if it reads as misleading in practice, add a served-count counter to `TrafficController` (small, isolated change) rather than reworking the KPI pipeline.
- Scenario thresholds (`RUSH_HOUR_WAIT_THRESHOLD_S`, `EV_TRANSIT_THRESHOLD_S`, `CHAOS_WAIT_INCREASE_THRESHOLD_PCT`, `PED_WAIT_THRESHOLD_S`) are first-pass numbers, same caveat as Phase 6's reward weights and this phase's own `SCENARIO_CONFIGS` rates — expect to retune all of them after watching real playthroughs, not before.
- The chaos scenario's "pass = you successfully caused disruption" framing is an interpretation of the spec's own phrasing ("scored on how much they increase avg wait...this is the concrete, scoreable version of 'test the traffic yourself'") — if playtesting shows this reads as confusing (pass meaning "you made it worse" is an intentional inversion), it's a copy/UI clarity fix, not a scoring-logic bug.
