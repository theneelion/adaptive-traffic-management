# Phase 2: Signal AI v1 (Rule-Based) + Safety Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 1's `FixedTimeSignal` with a real actuated (demand-responsive) signal controller: the sim server detects per-approach queue length/wait time via Matter.js sensor zones, calls a new Python `ai-service` for a phase decision every ~1.5 sim-seconds, that decision passes through a rule-based safety wrapper enforcing min/max green, and every phase change plus KPI snapshot is now recorded to a session JSON file on disk.

**Architecture:** Two-language boundary opens for the first time. `shared-contracts` gets its first RPC schema (`signal-decision`). `ai-service` is bootstrapped as a FastAPI app with two pure-function rule modules (`rule_based.py` proposes, `safety_wrapper.py` clamps) — this is also where the spec's three-tier hierarchy's *shape* (propose → clamp) is first built, even though tiers 1 and 3 (RL, EV override) don't exist until Phases 6–7. `sim-server` gains queue-detection sensors, a `SignalController` orchestrator that polls the AI service, and a `SessionStore` + recorder.

**Tech Stack:** FastAPI, `uv`, `pytest`, `ruff` (new, `ai-service`); Matter.js sensor bodies, `fetch` (Node 20 native), Node `fs` (sim-server, extending Phase 1's stack).

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §2.2, §4, §7 (structure only — full reward function is Phase 6), §8, §14 step 2, FR-7, FR-8, TR-4, TR-5 (tiers 1+3 deferred), TR-10. Also read [`00-overview.md`](00-overview.md) §4 (shared-contracts flow), §5 (CI table — `unit-py` job added here), §6 (Interface ledger — Phase 1 entries you're building on, Phase 2 entries you're producing). Also read [`01-core-loop.md`](01-core-loop.md) — this phase modifies `SingleCarSession`, `PhysicsWorld`, and `server.ts` from that plan directly.

## Global Constraints

- All Phase 1 Global Constraints still apply.
- Every new Node↔Python message shape starts with a shared-contracts schema edit, never a hand-written type on either side (`00-overview.md` §4).
- `SessionEvent`/`SessionFile`/`KpiSnapshot`/`FinalScore` are **not** shared-contracts types — they're sim-server-internal TS, per the note added to `00-overview.md` §6.
- Session JSON schema fields match spec §8 exactly (`session_id`, `started_at`, `map_id`, `scenario`, `participants`, `events`, `kpi_snapshots`, `final_score`) — camelCase in TS code, but serialize to the snake_case field names shown in §8 so the on-disk format matches spec exactly (JSON.stringify with explicit key mapping, not `JSON.stringify(this)`).

---

### Task 1: shared-contracts — `signal-decision` schema

**Files:**
- Create: `shared-contracts/schemas/signal-decision.schema.json`
- Test: `shared-contracts/test/generated.test.ts` (extend)

**Interfaces:**
- Produces: TS + Py `SignalDecisionRequest`, `SignalDecisionResponse` (Interface ledger, Phase 2).

- [ ] **Step 1: Write the schema**

`shared-contracts/schemas/signal-decision.schema.json`:
```json
{
  "$id": "SignalDecision",
  "definitions": {
    "PhaseCandidate": {
      "type": "object",
      "required": ["phaseId", "queueLength", "waitS"],
      "properties": {
        "phaseId": { "type": "string" },
        "queueLength": { "type": "integer", "minimum": 0 },
        "waitS": { "type": "number", "minimum": 0 }
      }
    }
  },
  "type": "object",
  "properties": {
    "SignalDecisionRequest": {
      "type": "object",
      "required": ["intersectionId", "currentPhaseId", "timeInPhaseMs", "phaseCandidates"],
      "properties": {
        "intersectionId": { "type": "string" },
        "currentPhaseId": { "type": "string" },
        "timeInPhaseMs": { "type": "number", "minimum": 0 },
        "phaseCandidates": { "type": "array", "items": { "$ref": "#/definitions/PhaseCandidate" } }
      }
    },
    "SignalDecisionResponse": {
      "type": "object",
      "required": ["phaseId", "controller"],
      "properties": {
        "phaseId": { "type": "string" },
        "controller": { "enum": ["rule_based"] }
      }
    }
  }
}
```

Note: `controller` is an `enum` with a single value now; Phase 6 extends it to `["rule_based", "rl"]` — additive, so no consumer written against this phase breaks.

- [ ] **Step 2: Regenerate and verify**

Run: `pnpm --filter shared-contracts generate`
Expected: `generated/ts/signal-decision.schema.d.ts` exports `SignalDecisionRequest`/`SignalDecisionResponse`; `ai-service/app/contracts/signal_decision_schema.py` exports matching pydantic models (see Task 1 fix in `01-core-loop.md` for the underscore-filename rule this relies on).

- [ ] **Step 3: Extend the generated-contracts smoke test**

Add to `shared-contracts/test/generated.test.ts`:
```ts
import type { SignalDecisionRequest } from "../generated/ts/signal-decision.schema";

it("accepts a well-formed SignalDecisionRequest", () => {
  const req: SignalDecisionRequest = {
    intersectionId: "int_1",
    currentPhaseId: "NS_through",
    timeInPhaseMs: 3000,
    phaseCandidates: [
      { phaseId: "NS_through", queueLength: 1, waitS: 4.2 },
      { phaseId: "EW_through", queueLength: 3, waitS: 9.1 }
    ]
  };
  expect(req.phaseCandidates).toHaveLength(2);
});
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm --filter shared-contracts test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared-contracts/schemas/signal-decision.schema.json shared-contracts/generated shared-contracts/test ai-service/app/contracts
git commit -m "feat(contracts): add signal-decision RPC schema"
```

---

### Task 2: `ai-service` bootstrap (FastAPI, uv, pytest, ruff) + CI `unit-py` job

**Files:**
- Create: `ai-service/pyproject.toml`
- Create: `ai-service/app/__init__.py`, `ai-service/app/main.py`
- Create: `ai-service/tests/test_health.py`
- Modify: `.github/workflows/ci.yml` (add `unit-py` job — `00-overview.md` §5 phase-2 row)

**Interfaces:**
- Produces: `ai-service` runnable via `uv run uvicorn app.main:app --port 8000`, with a `GET /health` endpoint for the integration smoke check used later in this phase's Task 5.

- [ ] **Step 1: Write `pyproject.toml`**

`ai-service/pyproject.toml`:
```toml
[project]
name = "ai-service"
version = "0.0.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115.0",
  "uvicorn[standard]>=0.30.6",
  "pydantic>=2.9.0"
]

[tool.uv]
package = false
dev-dependencies = ["pytest>=8.3.2", "httpx>=0.27.2", "ruff>=0.6.4"]

[tool.pytest.ini_options]
pythonpath = ["."]

[tool.ruff.lint]
# I001 (isort import-block grouping) is intentionally off: this project's code consistently
# mixes third-party and first-party imports without a blank-line separator, and enforcing it
# would mean touching nearly every file for a purely cosmetic reason.
ignore = ["I001"]
```

Three things this fixes versus a naive FastAPI-app pyproject.toml, both only visible once you actually try to run it: `package = false` tells uv not to build this application as an installable wheel (hatchling has no way to guess what to ship for a project named `ai-service` with no `ai_service`-named source directory); `pythonpath = ["."]` is what makes `from app.main import app` resolve at all in `tests/test_health.py` — without it, pytest never puts the project root on `sys.path`, and every test file's first import fails with `ModuleNotFoundError: No module named 'app'`. The `ruff` ignore is there because this codebase's Python files consistently interleave third-party and first-party imports without isort's expected blank-line grouping — worth knowing before `uv run ruff check .` reports a wall of `I001` findings across nearly every file in later phases.

- [ ] **Step 2: Write the failing health-check test**

`ai-service/tests/test_health.py`:
```python
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_health.py -v`
Expected: FAIL — `app.main` doesn't exist yet.

- [ ] **Step 4: Write `app/main.py` with the health endpoint**

`ai-service/app/main.py`:
```python
from fastapi import FastAPI

app = FastAPI(title="ai-service")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

`ai-service/app/__init__.py`: empty file.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_health.py -v`
Expected: PASS.

- [ ] **Step 6: Add the `unit-py` CI job**

Append to `.github/workflows/ci.yml`:
```yaml
  unit-py:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install uv
      - run: cd ai-service && uv sync
      - run: cd ai-service && uv run ruff check .
      - run: cd ai-service && uv run pytest
```

- [ ] **Step 7: Commit**

```bash
git add ai-service/pyproject.toml ai-service/app ai-service/tests .github/workflows/ci.yml
git commit -m "feat(ai-service): bootstrap FastAPI app with health check; add unit-py CI job"
```

---

### Task 3: Rule-based actuated proposal + safety wrapper

**Files:**
- Create: `ai-service/app/rule_based.py`
- Create: `ai-service/app/safety_wrapper.py`
- Create: `ai-service/app/routes.py`
- Modify: `ai-service/app/main.py` (mount router)
- Test: `ai-service/tests/test_rule_based.py`
- Test: `ai-service/tests/test_safety_wrapper.py`
- Test: `ai-service/tests/test_signal_decision_route.py`

**Interfaces:**
- Produces (Interface ledger, Phase 2): `apply_safety_constraints(proposed: PhaseDecision, state: IntersectionState, rules: SafetyRules) -> PhaseDecision`.
- Produces: `decide_phase(req: SignalDecisionRequest) -> str` (proposed `phaseId`).
- Produces: `POST /signal-decision` route wiring both together.

- [ ] **Step 1: Write the failing test for `decide_phase`**

`ai-service/tests/test_rule_based.py`:
```python
from app.contracts.signal_decision_schema import SignalDecisionRequest, PhaseCandidate
from app.rule_based import decide_phase


def _req(current: str, candidates: list[tuple[str, int, float]]) -> SignalDecisionRequest:
    return SignalDecisionRequest(
        intersectionId="int_1",
        currentPhaseId=current,
        timeInPhaseMs=5000,
        phaseCandidates=[PhaseCandidate(phaseId=p, queueLength=q, waitS=w) for p, q, w in candidates],
    )


def test_stays_on_current_phase_when_it_has_more_pressure():
    req = _req("NS_through", [("NS_through", 5, 10.0), ("EW_through", 1, 1.0)])
    assert decide_phase(req) == "NS_through"


def test_switches_when_other_phase_has_much_more_pressure():
    req = _req("NS_through", [("NS_through", 0, 0.0), ("EW_through", 6, 15.0)])
    assert decide_phase(req) == "EW_through"


def test_stays_when_advantage_is_below_threshold():
    req = _req("NS_through", [("NS_through", 2, 4.0), ("EW_through", 3, 4.0)])
    assert decide_phase(req) == "NS_through"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_rule_based.py -v`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `rule_based.py`**

`ai-service/app/rule_based.py`:
```python
from app.contracts.signal_decision_schema import SignalDecisionRequest

MIN_ADVANTAGE_RATIO = 1.5


def decide_phase(req: SignalDecisionRequest) -> str:
    current = next(c for c in req.phaseCandidates if c.phaseId == req.currentPhaseId)
    best = max(req.phaseCandidates, key=lambda c: c.queueLength + c.waitS)

    if best.phaseId == current.phaseId:
        return current.phaseId

    current_pressure = current.queueLength + current.waitS
    best_pressure = best.queueLength + best.waitS

    if current_pressure == 0 or best_pressure > current_pressure * MIN_ADVANTAGE_RATIO:
        return best.phaseId
    return current.phaseId
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_rule_based.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for `apply_safety_constraints`**

`ai-service/tests/test_safety_wrapper.py`:
```python
from app.safety_wrapper import apply_safety_constraints, PhaseDecision, IntersectionState, SafetyRules


def test_vetoes_switch_before_min_green_elapsed():
    proposed = PhaseDecision(phase_id="EW_through", controller="rule_based")
    state = IntersectionState(current_phase_id="NS_through", time_in_phase_ms=1000, all_phase_ids=["NS_through", "EW_through"])
    result = apply_safety_constraints(proposed, state, SafetyRules(min_green_ms=4000, max_green_ms=20000))
    assert result.phase_id == "NS_through"


def test_allows_switch_after_min_green_elapsed():
    proposed = PhaseDecision(phase_id="EW_through", controller="rule_based")
    state = IntersectionState(current_phase_id="NS_through", time_in_phase_ms=5000, all_phase_ids=["NS_through", "EW_through"])
    result = apply_safety_constraints(proposed, state, SafetyRules(min_green_ms=4000, max_green_ms=20000))
    assert result.phase_id == "EW_through"


def test_forces_switch_after_max_green_even_if_proposal_says_stay():
    proposed = PhaseDecision(phase_id="NS_through", controller="rule_based")
    state = IntersectionState(current_phase_id="NS_through", time_in_phase_ms=21000, all_phase_ids=["NS_through", "EW_through"])
    result = apply_safety_constraints(proposed, state, SafetyRules(min_green_ms=4000, max_green_ms=20000))
    assert result.phase_id == "EW_through"
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_safety_wrapper.py -v`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `safety_wrapper.py`**

`ai-service/app/safety_wrapper.py`:
```python
from dataclasses import dataclass


@dataclass
class PhaseDecision:
    phase_id: str
    controller: str  # "rule_based" (Phase 2) | "rl" (Phase 6)


@dataclass
class IntersectionState:
    current_phase_id: str
    time_in_phase_ms: float
    all_phase_ids: list[str]


@dataclass
class SafetyRules:
    min_green_ms: float = 4000
    max_green_ms: float = 20000


def apply_safety_constraints(proposed: PhaseDecision, state: IntersectionState, rules: SafetyRules) -> PhaseDecision:
    if proposed.phase_id != state.current_phase_id and state.time_in_phase_ms < rules.min_green_ms:
        return PhaseDecision(phase_id=state.current_phase_id, controller=proposed.controller)

    if proposed.phase_id == state.current_phase_id and state.time_in_phase_ms >= rules.max_green_ms:
        idx = state.all_phase_ids.index(state.current_phase_id)
        next_phase = state.all_phase_ids[(idx + 1) % len(state.all_phase_ids)]
        return PhaseDecision(phase_id=next_phase, controller=proposed.controller)

    return proposed
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_safety_wrapper.py -v`
Expected: PASS (3 tests).

- [ ] **Step 9: Write the failing test for the `/signal-decision` route**

`ai-service/tests/test_signal_decision_route.py`:
```python
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_signal_decision_returns_rule_based_controller():
    response = client.post(
        "/signal-decision",
        json={
            "intersectionId": "int_1",
            "currentPhaseId": "NS_through",
            "timeInPhaseMs": 5000,
            "phaseCandidates": [
                {"phaseId": "NS_through", "queueLength": 0, "waitS": 0.0},
                {"phaseId": "EW_through", "queueLength": 6, "waitS": 15.0},
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["phaseId"] == "EW_through"
    assert body["controller"] == "rule_based"
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_signal_decision_route.py -v`
Expected: FAIL — no `/signal-decision` route yet.

- [ ] **Step 11: Implement the route and mount it**

`ai-service/app/routes.py`:
```python
from fastapi import APIRouter
from app.contracts.signal_decision_schema import SignalDecisionRequest, SignalDecisionResponse
from app.rule_based import decide_phase
from app.safety_wrapper import apply_safety_constraints, PhaseDecision, IntersectionState, SafetyRules

router = APIRouter()


@router.post("/signal-decision", response_model=SignalDecisionResponse)
def signal_decision(req: SignalDecisionRequest) -> SignalDecisionResponse:
    proposed = PhaseDecision(phase_id=decide_phase(req), controller="rule_based")
    state = IntersectionState(
        current_phase_id=req.currentPhaseId,
        time_in_phase_ms=req.timeInPhaseMs,
        all_phase_ids=[c.phaseId for c in req.phaseCandidates],
    )
    final = apply_safety_constraints(proposed, state, SafetyRules())
    return SignalDecisionResponse(phaseId=final.phase_id, controller=final.controller)
```

Modify `ai-service/app/main.py`:
```python
from fastapi import FastAPI
from app.routes import router

app = FastAPI(title="ai-service")
app.include_router(router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd ai-service && uv run pytest -v`
Expected: PASS (all tests in `ai-service/tests/`).

- [ ] **Step 13: Commit**

```bash
git add ai-service/app
git commit -m "feat(ai-service): rule-based actuated proposal + min/max-green safety wrapper"
```

---

### Task 4: Queue-detection sensor zones (sim-server)

**Files:**
- Modify: `sim-server/src/physics/PhysicsWorld.ts` (add sensor bodies)
- Create: `sim-server/src/signals/QueueDetector.ts`
- Test: `sim-server/test/signals/QueueDetector.test.ts`

**Interfaces:**
- Consumes: `PhysicsWorld`, `VehicleBody`, `ApproachDef` (Phase 1).
- Produces: `class QueueDetector` — `constructor(world: PhysicsWorld, approaches: ApproachDef[])`, `.step(dtMs: number, vehicles: VehicleBody[]): void`, `.getApproachState(approachId: string): { queueLength: number; waitS: number }`.

- [ ] **Step 1: Add sensor zone bodies to `PhysicsWorld`**

Modify `sim-server/src/physics/PhysicsWorld.ts` — inside the `for (const approach of mapDef.approaches)` loop, after the two lane-edge bodies are added, add a sensor rectangle covering the 60 units of lane closest to the intersection:

```ts
const zoneLength = 60;
const zoneCenterOffset = zoneLength / 2;
const towardIntersectionX = (approach.laneEndX - approach.laneStartX) / length;
const towardIntersectionY = (approach.laneEndY - approach.laneStartY) / length;
const zoneCenterX = approach.laneEndX - towardIntersectionX * zoneCenterOffset;
const zoneCenterY = approach.laneEndY - towardIntersectionY * zoneCenterOffset;

const queueZone = Matter.Bodies.rectangle(zoneCenterX, zoneCenterY, zoneLength, approach.width, {
  isStatic: true,
  isSensor: true,
  angle,
  label: `${approach.id}_queue_zone`
});
Matter.Composite.add(this.engine.world, queueZone);
```

(This sits inside the existing loop, using the same `length`, `angle` locals already computed for the lane edges — no new locals needed beyond the four shown.)

- [ ] **Step 2: Write the failing test for `QueueDetector`**

`sim-server/test/signals/QueueDetector.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import Matter from "matter-js";
import { PhysicsWorld } from "../../src/physics/PhysicsWorld";
import { loadMap } from "../../src/maps/loadMap";
import { VehicleBody } from "../../src/vehicles/VehicleBody";
import { QueueDetector } from "../../src/signals/QueueDetector";

describe("QueueDetector", () => {
  it("detects a stationary vehicle inside the queue zone as queued, with growing wait time", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    // app_N's queue zone sits just north of the intersection (laneEndY=0, laneStartY=-300, so zone center is near y=-30)
    const car = new VehicleBody(world, "car_1", { x: 0, y: -30, heading: Math.PI / 2 });
    const detector = new QueueDetector(world, map.approaches);

    for (let i = 0; i < 10; i++) {
      world.step(16);
      detector.step(16, [car]);
    }

    const state = detector.getApproachState("app_N");
    expect(state.queueLength).toBe(1);
    expect(state.waitS).toBeGreaterThan(0);
  });

  it("reports zero queue length once the vehicle leaves the zone", () => {
    const map = loadMap("../../maps/grid_1x1_v1.json");
    const world = new PhysicsWorld(map);
    const car = new VehicleBody(world, "car_1", { x: 200, y: -300, heading: Math.PI / 2 });
    const detector = new QueueDetector(world, map.approaches);

    for (let i = 0; i < 5; i++) {
      world.step(16);
      detector.step(16, [car]);
    }

    expect(detector.getApproachState("app_N").queueLength).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- QueueDetector`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `QueueDetector`**

`sim-server/src/signals/QueueDetector.ts`:
```ts
import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import type { ApproachDef } from "../maps/MapDefinition";
import type { VehicleBody } from "../vehicles/VehicleBody";

const QUEUE_SPEED_THRESHOLD = 0.5;

export class QueueDetector {
  private readonly inZone = new Map<string, Set<string>>();
  private readonly waitStartMs = new Map<string, number>();
  private nowMs = 0;

  constructor(world: PhysicsWorld, approaches: ApproachDef[]) {
    for (const approach of approaches) this.inZone.set(approach.id, new Set());

    Matter.Events.on(world.engine, "collisionStart", (event) => this.handleCollision(event, true));
    Matter.Events.on(world.engine, "collisionEnd", (event) => this.handleCollision(event, false));
  }

  private handleCollision(event: Matter.IEventCollision<Matter.Engine>, entering: boolean): void {
    for (const pair of event.pairs) {
      const bodies = [pair.bodyA, pair.bodyB];
      const sensor = bodies.find((b) => b.label.endsWith("_queue_zone"));
      const vehicle = bodies.find((b) => b.label.startsWith("vehicle_"));
      if (!sensor || !vehicle) continue;

      const approachId = sensor.label.replace("_queue_zone", "");
      const vehicleId = vehicle.label.replace("vehicle_", "");
      const set = this.inZone.get(approachId);
      if (!set) continue;

      if (entering) {
        set.add(vehicleId);
      } else {
        set.delete(vehicleId);
        this.waitStartMs.delete(vehicleId);
      }
    }
  }

  step(dtMs: number, vehicles: VehicleBody[]): void {
    this.nowMs += dtMs;
    for (const ids of this.inZone.values()) {
      for (const vehicleId of ids) {
        const vehicle = vehicles.find((v) => v.id === vehicleId);
        if (!vehicle) continue;
        const speed = Math.hypot(vehicle.body.velocity.x, vehicle.body.velocity.y);
        if (speed < QUEUE_SPEED_THRESHOLD) {
          if (!this.waitStartMs.has(vehicleId)) this.waitStartMs.set(vehicleId, this.nowMs);
        } else {
          this.waitStartMs.delete(vehicleId);
        }
      }
    }
  }

  getApproachState(approachId: string): { queueLength: number; waitS: number } {
    const ids = this.inZone.get(approachId) ?? new Set<string>();
    const waits = [...ids].map((id) => {
      const start = this.waitStartMs.get(id);
      return start === undefined ? 0 : (this.nowMs - start) / 1000;
    });
    return { queueLength: ids.size, waitS: waits.length ? Math.max(...waits) : 0 };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- QueueDetector`
Expected: PASS. If the vehicle isn't detected, check that the queue zone's `angle`/center math from Step 1 actually places the zone where the test's car spawns — print `Matter.Composite.allBodies(world.engine.world)` positions if debugging.

- [ ] **Step 6: Commit**

```bash
git add sim-server/src/physics/PhysicsWorld.ts sim-server/src/signals/QueueDetector.ts sim-server/test/signals/QueueDetector.test.ts
git commit -m "feat(sim-server): add Matter.js queue-detection sensor zones"
```

---

### Task 5: `SignalController` — polls `ai-service`, replaces `FixedTimeSignal`

**Files:**
- Create: `sim-server/src/signals/AiSignalClient.ts`
- Create: `sim-server/src/signals/SignalController.ts`
- Delete: nothing — `FixedTimeSignal` stays as a fallback type used only in this phase's tests for comparison; `SingleCarSession` stops constructing it
- Modify: `sim-server/src/room/SingleCarSession.ts` (use `SignalController` instead of `FixedTimeSignal`)
- Test: `sim-server/test/signals/AiSignalClient.test.ts`
- Test: `sim-server/test/signals/SignalController.test.ts`

**Interfaces:**
- Consumes: `SignalDecisionRequest`/`Response` (Task 1), `QueueDetector` (Task 4), `MapDefinition.intersections[].phases` (Phase 1).
- Produces: `class AiSignalClient` — `constructor(baseUrl: string)`, `.decide(req: SignalDecisionRequest): Promise<SignalDecisionResponse>`.
- Produces: `class SignalController` — `constructor(phases: SignalPhaseDef[], client: AiSignalClient, detector: QueueDetector, intersectionId: string)`, `.step(dtMs: number): Promise<{ phaseId: string; changed: boolean }>`, `.currentPhaseId: string`, `.timeInPhaseMs: number`.

- [ ] **Step 1: Write the failing test for `AiSignalClient` (using a stubbed global `fetch`)**

`sim-server/test/signals/AiSignalClient.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { AiSignalClient } from "../../src/signals/AiSignalClient";

describe("AiSignalClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the request and returns the parsed decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ phaseId: "EW_through", controller: "rule_based" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AiSignalClient("http://localhost:8000");
    const result = await client.decide({
      intersectionId: "int_1",
      currentPhaseId: "NS_through",
      timeInPhaseMs: 5000,
      phaseCandidates: [{ phaseId: "NS_through", queueLength: 0, waitS: 0 }]
    });

    expect(result.phaseId).toBe("EW_through");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/signal-decision",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const client = new AiSignalClient("http://localhost:8000");
    await expect(
      client.decide({ intersectionId: "int_1", currentPhaseId: "NS_through", timeInPhaseMs: 0, phaseCandidates: [] })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- AiSignalClient`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `AiSignalClient`**

`sim-server/src/signals/AiSignalClient.ts`:
```ts
import type { SignalDecisionRequest } from "shared-contracts/generated/ts/signal-decision.schema";
import type { SignalDecisionResponse } from "shared-contracts/generated/ts/signal-decision.schema";

export class AiSignalClient {
  constructor(private readonly baseUrl: string) {}

  async decide(req: SignalDecisionRequest): Promise<SignalDecisionResponse> {
    const res = await fetch(`${this.baseUrl}/signal-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req)
    });
    if (!res.ok) throw new Error(`signal-decision request failed: ${res.status}`);
    return (await res.json()) as SignalDecisionResponse;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- AiSignalClient`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `SignalController`**

`sim-server/test/signals/SignalController.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { SignalController } from "../../src/signals/SignalController";

const phases = [
  { id: "NS_through", allowedDirections: ["N", "S"] as const, durationMs: 8000 },
  { id: "EW_through", allowedDirections: ["E", "W"] as const, durationMs: 8000 }
];

function fakeDetector(states: Record<string, { queueLength: number; waitS: number }>) {
  return { getApproachState: (id: string) => states[id] ?? { queueLength: 0, waitS: 0 } } as any;
}

describe("SignalController", () => {
  it("stays on the current phase when the AI client returns the same phase", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, client as any, fakeDetector({}), "int_1");

    const result = await controller.step(1500);
    expect(result.phaseId).toBe("NS_through");
    expect(result.changed).toBe(false);
  });

  it("switches phase and reports changed=true when the AI client proposes a new phase", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "EW_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, client as any, fakeDetector({}), "int_1");

    const result = await controller.step(1500);
    expect(result.phaseId).toBe("EW_through");
    expect(result.changed).toBe(true);
    expect(controller.currentPhaseId).toBe("EW_through");
  });

  it("aggregates queue state by direction into phaseCandidates sent to the AI client", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const detector = fakeDetector({ app_N: { queueLength: 2, waitS: 3 }, app_S: { queueLength: 1, waitS: 1 } });
    const controller = new SignalController(phases, client as any, detector, "int_1");

    await controller.step(1500);

    const sentRequest = client.decide.mock.calls[0][0];
    const nsCandidate = sentRequest.phaseCandidates.find((c: any) => c.phaseId === "NS_through");
    expect(nsCandidate.queueLength).toBe(3); // app_N + app_S, both allowed by NS_through
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- SignalController`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `SignalController`**

Note: this implementation hardcodes the approach→direction mapping from `grid_1x1_v1.json` (`app_N`→N, `app_S`→S, `app_E`→E, `app_W`→W) rather than threading `MapDefinition.approaches` through — accepting the map's `ApproachDef[]` is a one-line constructor addition, deferred to whichever later phase first needs a second map (none of Phases 3–10 introduce a second map, so this is not deferred work masquerading as scope-cutting; it's YAGNI against a currently-hypothetical requirement).

`sim-server/src/signals/SignalController.ts`:
```ts
import type { SignalPhaseDef, Direction } from "../maps/MapDefinition";
import type { AiSignalClient } from "./AiSignalClient";
import type { QueueDetector } from "./QueueDetector";

const DECISION_INTERVAL_MS = 1500;
const APPROACH_DIRECTIONS: Record<string, Direction> = {
  app_N: "N",
  app_S: "S",
  app_E: "E",
  app_W: "W"
};

export class SignalController {
  private phaseId: string;
  private elapsedMs = 0;
  private sinceLastDecisionMs = 0;

  constructor(
    private readonly phases: SignalPhaseDef[],
    private readonly client: AiSignalClient,
    private readonly detector: QueueDetector,
    private readonly intersectionId: string
  ) {
    this.phaseId = phases[0].id;
  }

  get currentPhaseId(): string {
    return this.phaseId;
  }

  get timeInPhaseMs(): number {
    return this.elapsedMs;
  }

  async step(dtMs: number): Promise<{ phaseId: string; changed: boolean }> {
    this.elapsedMs += dtMs;
    this.sinceLastDecisionMs += dtMs;

    if (this.sinceLastDecisionMs < DECISION_INTERVAL_MS) {
      return { phaseId: this.phaseId, changed: false };
    }
    this.sinceLastDecisionMs = 0;

    const phaseCandidates = this.phases.map((phase) => {
      let queueLength = 0;
      let waitS = 0;
      for (const [approachId, direction] of Object.entries(APPROACH_DIRECTIONS)) {
        if (!phase.allowedDirections.includes(direction)) continue;
        const state = this.detector.getApproachState(approachId);
        queueLength += state.queueLength;
        waitS = Math.max(waitS, state.waitS);
      }
      return { phaseId: phase.id, queueLength, waitS };
    });

    const decision = await this.client.decide({
      intersectionId: this.intersectionId,
      currentPhaseId: this.phaseId,
      timeInPhaseMs: this.elapsedMs,
      phaseCandidates
    });

    const changed = decision.phaseId !== this.phaseId;
    if (changed) {
      this.phaseId = decision.phaseId;
      this.elapsedMs = 0;
    }
    return { phaseId: this.phaseId, changed };
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- SignalController`
Expected: PASS (3 tests).

- [ ] **Step 9: Wire `SignalController` into `SingleCarSession`, replacing `FixedTimeSignal`**

Modify `sim-server/src/room/SingleCarSession.ts` — replace the `FixedTimeSignal` import/field/construction with `SignalController`, `AiSignalClient`, and `QueueDetector`; `step()` becomes `async` (it now awaits an HTTP call every ~1.5s):

```ts
import { QueueDetector } from "../signals/QueueDetector";
import { AiSignalClient } from "../signals/AiSignalClient";
import { SignalController } from "../signals/SignalController";
// remove: import { FixedTimeSignal } from "../signals/FixedTimeSignal";

// in constructor, replace `this.signal = new FixedTimeSignal(...)` with:
this.detector = new QueueDetector(this.world, map.approaches);
this.signalController = new SignalController(
  map.intersections[0].phases,
  new AiSignalClient(process.env.AI_SERVICE_URL ?? "http://localhost:8000"),
  this.detector,
  map.intersections[0].id
);

// step() becomes:
async step(): Promise<ServerStateSnapshot> {
  this.world.step(TICK_MS);
  this.detector.step(TICK_MS, [this.car]);
  const { phaseId } = await this.signalController.step(TICK_MS);
  this.tick += 1;

  return {
    type: "state",
    ts: Date.now(),
    payload: {
      tick: this.tick,
      vehicles: [ /* unchanged from Phase 1 */ ],
      signals: [
        {
          intersectionId: "int_1",
          phase: phaseId,
          msRemainingMin: Math.max(0, 4000 - this.signalController.timeInPhaseMs)
        }
      ]
    }
  };
}
```

`msRemainingMin`'s meaning shifts here: Phase 1 reported "time left in the current fixed-duration phase"; from this phase on it reports "time remaining until minimum green is satisfied and a switch could legally occur" (the `4000` matches `SafetyRules.min_green_ms`'s default in `ai-service`). Same field, no schema change — call this out explicitly in the Phase 10 KPI panel copy so it isn't misread as "time until forced switch."

Modify `sim-server/src/server.ts`: the `setInterval` callback that calls `session.step()` must now `await` it (wrap the callback `async` and `await session.step()` before broadcasting) since `step()` is now asynchronous.

- [ ] **Step 10: Delete the now-unused import and manually re-run Phase 1's integration test**

Run: `pnpm --filter sim-server test -- server.integration`
Expected: PASS — this test doesn't assert on signal phase content, only vehicle movement, so it should be unaffected. If it hangs, `AI_SERVICE_URL` isn't reachable in the test process; Task 7 below adds the docker-composed version that actually exercises this path against a live `ai-service`.

- [ ] **Step 11: Commit**

```bash
git add sim-server/src/signals sim-server/src/room/SingleCarSession.ts sim-server/src/server.ts sim-server/test/signals
git commit -m "feat(sim-server): SignalController polls ai-service for actuated phase decisions"
```

---

### Task 6: `SignalPhaseMachine` — green/yellow/all-red clearance sequencing

**Why this exists:** Task 5's `SignalController` flips `currentPhaseId` the instant a new decision arrives — no yellow warning, no all-red clearance. That's unrealistic and, more importantly, physically unsafe to model as "fine": real signals run green→yellow→all-red→green specifically so a vehicle already committed to the intersection can clear before the conflicting direction gets a green. This task adds that sequencing as its own deterministic state machine, owned by `sim-server` (not `ai-service`) — the RL/rule-based decision layer still only ever proposes *which phase should be green next*; this machine is what actually enforces the safe transition, and it cannot be interrupted mid-sequence by anything (not a new decision, not even the Phase 7 EV override) — that refusal is itself the safety property spec §6 describes as "won't cut off a phase mid-transition."

**Files:**
- Create: `sim-server/src/signals/SignalPhaseMachine.ts`
- Modify: `sim-server/src/signals/SignalController.ts` (route all phase changes through the machine instead of flipping `phaseId` directly)
- Modify: `shared-contracts/schemas/state-snapshot.schema.json` (additive `light` field on `SignalState`)
- Modify: `sim-server/src/room/SingleCarSession.ts` (Task 5's wiring, updated again for the `light` field)
- Test: `sim-server/test/signals/SignalPhaseMachine.test.ts`
- Test: `sim-server/test/signals/SignalController.test.ts` (Task 5's file — several assertions there assumed an instant flip and must be rewritten here to be transition-aware; this is not new coverage layered on top, it's a correction to a test that would otherwise assert something the system no longer does)

**Interfaces:**
- Produces (Interface ledger, Phase 2): `type SignalLightState = "green" | "yellow" | "red"`; `class SignalPhaseMachine` — `constructor(initialPhaseId: string, yellowMs = 3000, allRedMs = 1500)`, `.requestPhase(phaseId: string): void`, `.step(dtMs: number): void`, `.currentPhaseId: string`, `.greenElapsedMsValue: number`, `.lightStateFor(phaseId: string): SignalLightState`.
- Produces: `SignalController.getApproachSignalStates(): Map<string, SignalLightState>` — per-approach light state, consumed directly by Phase 3's `TrafficController` and Phase 5's `PedestrianController`.
- Modifies: `SignalController.step()` return type widens to `{ phaseId: string; changed: boolean; controller: string }` (the `controller` field is added here, ahead of Phase 6's RL controller value, since it costs nothing to include now and Phase 6 would otherwise have to revisit this same return statement).

- [ ] **Step 1: Write the failing test for `SignalPhaseMachine`**

`sim-server/test/signals/SignalPhaseMachine.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { SignalPhaseMachine } from "../../src/signals/SignalPhaseMachine";

describe("SignalPhaseMachine", () => {
  it("starts on the initial phase, green; the other phase reads red", () => {
    const machine = new SignalPhaseMachine("NS_through");
    expect(machine.currentPhaseId).toBe("NS_through");
    expect(machine.lightStateFor("NS_through")).toBe("green");
    expect(machine.lightStateFor("EW_through")).toBe("red");
  });

  it("ignores a request for the phase that's already active", () => {
    const machine = new SignalPhaseMachine("NS_through");
    machine.requestPhase("NS_through");
    machine.step(100);
    expect(machine.lightStateFor("NS_through")).toBe("green");
  });

  it("goes yellow immediately on a request for a different phase, then all-red, then commits to the new phase", () => {
    const machine = new SignalPhaseMachine("NS_through", 3000, 1500);

    machine.requestPhase("EW_through");
    expect(machine.lightStateFor("NS_through")).toBe("yellow");
    expect(machine.lightStateFor("EW_through")).toBe("red");

    machine.step(3000); // yellow fully elapses -> all-red begins
    expect(machine.lightStateFor("NS_through")).toBe("red");
    expect(machine.lightStateFor("EW_through")).toBe("red");
    expect(machine.currentPhaseId).toBe("NS_through"); // not committed yet

    machine.step(1500); // all-red fully elapses -> commits
    expect(machine.currentPhaseId).toBe("EW_through");
    expect(machine.lightStateFor("EW_through")).toBe("green");
    expect(machine.lightStateFor("NS_through")).toBe("red");
  });

  it("ignores further requests while mid-transition — the original transition completes regardless", () => {
    const machine = new SignalPhaseMachine("NS_through", 3000, 1500);
    machine.requestPhase("EW_through");
    machine.step(1000);
    machine.requestPhase("NS_through"); // ignored: already transitioning away from NS_through
    machine.step(2000); // yellow total: 3000ms elapsed
    machine.step(1500); // all-red elapses
    expect(machine.currentPhaseId).toBe("EW_through");
  });

  it("tracks green-elapsed time separately from the transition clock, resetting only once a transition commits", () => {
    const machine = new SignalPhaseMachine("NS_through", 3000, 1500);
    machine.step(2000);
    expect(machine.greenElapsedMsValue).toBe(2000);

    machine.requestPhase("EW_through");
    machine.step(3000); // yellow
    machine.step(1500); // all-red -> commits
    expect(machine.greenElapsedMsValue).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- SignalPhaseMachine`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `SignalPhaseMachine`**

`sim-server/src/signals/SignalPhaseMachine.ts`:
```ts
export type SignalLightState = "green" | "yellow" | "red";

type SubState = "green" | "yellow" | "all_red";

export class SignalPhaseMachine {
  private activePhaseId: string;
  private subState: SubState = "green";
  private elapsedInSubStateMs = 0;
  private greenElapsedMs = 0;
  private pendingPhaseId: string | null = null;

  constructor(initialPhaseId: string, private readonly yellowMs = 3000, private readonly allRedMs = 1500) {
    this.activePhaseId = initialPhaseId;
  }

  requestPhase(phaseId: string): void {
    if (this.subState !== "green") return; // mid-transition: cannot be interrupted or redirected
    if (phaseId === this.activePhaseId) return; // already there
    this.pendingPhaseId = phaseId;
    this.subState = "yellow";
    this.elapsedInSubStateMs = 0;
  }

  step(dtMs: number): void {
    this.elapsedInSubStateMs += dtMs;

    if (this.subState === "green") {
      this.greenElapsedMs += dtMs;
      return;
    }
    if (this.subState === "yellow" && this.elapsedInSubStateMs >= this.yellowMs) {
      this.subState = "all_red";
      this.elapsedInSubStateMs = 0;
      return;
    }
    if (this.subState === "all_red" && this.elapsedInSubStateMs >= this.allRedMs) {
      this.activePhaseId = this.pendingPhaseId ?? this.activePhaseId;
      this.pendingPhaseId = null;
      this.subState = "green";
      this.elapsedInSubStateMs = 0;
      this.greenElapsedMs = 0;
    }
  }

  get currentPhaseId(): string {
    return this.activePhaseId;
  }

  get greenElapsedMsValue(): number {
    return this.greenElapsedMs;
  }

  lightStateFor(phaseId: string): SignalLightState {
    if (phaseId !== this.activePhaseId) return "red";
    if (this.subState === "green") return "green";
    if (this.subState === "yellow") return "yellow";
    return "red"; // all_red: even the "active" phase shows red during universal clearance
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- SignalPhaseMachine`
Expected: PASS (5 tests).

- [ ] **Step 5: Refactor `SignalController` to route through the phase machine**

Modify `sim-server/src/signals/SignalController.ts` in full:
```ts
import type { SignalPhaseDef, Direction } from "../maps/MapDefinition";
import type { AiSignalClient } from "./AiSignalClient";
import type { QueueDetector } from "./QueueDetector";
import { SignalPhaseMachine, type SignalLightState } from "./SignalPhaseMachine";

const DECISION_INTERVAL_MS = 1500;
const APPROACH_DIRECTIONS: Record<string, Direction> = {
  app_N: "N",
  app_S: "S",
  app_E: "E",
  app_W: "W"
};

export class SignalController {
  private readonly phaseMachine: SignalPhaseMachine;
  private sinceLastDecisionMs = 0;
  private lastController = "rule_based";

  constructor(
    private readonly phases: SignalPhaseDef[],
    private readonly client: AiSignalClient,
    private readonly detector: QueueDetector,
    private readonly intersectionId: string
  ) {
    this.phaseMachine = new SignalPhaseMachine(phases[0].id);
  }

  get currentPhaseId(): string {
    return this.phaseMachine.currentPhaseId;
  }

  get timeInPhaseMs(): number {
    return this.phaseMachine.greenElapsedMsValue;
  }

  getApproachSignalStates(): Map<string, SignalLightState> {
    const states = new Map<string, SignalLightState>();
    for (const [approachId, direction] of Object.entries(APPROACH_DIRECTIONS)) {
      const phase = this.phases.find((p) => p.allowedDirections.includes(direction))!;
      states.set(approachId, this.phaseMachine.lightStateFor(phase.id));
    }
    return states;
  }

  async step(dtMs: number): Promise<{ phaseId: string; changed: boolean; controller: string }> {
    const previousPhaseId = this.phaseMachine.currentPhaseId;
    this.phaseMachine.step(dtMs);
    this.sinceLastDecisionMs += dtMs;

    if (this.sinceLastDecisionMs >= DECISION_INTERVAL_MS) {
      this.sinceLastDecisionMs = 0;

      const phaseCandidates = this.phases.map((phase) => {
        let queueLength = 0;
        let waitS = 0;
        for (const [approachId, direction] of Object.entries(APPROACH_DIRECTIONS)) {
          if (!phase.allowedDirections.includes(direction)) continue;
          const state = this.detector.getApproachState(approachId);
          queueLength += state.queueLength;
          waitS = Math.max(waitS, state.waitS);
        }
        return { phaseId: phase.id, queueLength, waitS };
      });

      const decision = await this.client.decide({
        intersectionId: this.intersectionId,
        currentPhaseId: this.phaseMachine.currentPhaseId,
        timeInPhaseMs: this.phaseMachine.greenElapsedMsValue,
        phaseCandidates
      });

      this.phaseMachine.requestPhase(decision.phaseId);
      this.lastController = decision.controller;
    }

    const changed = this.phaseMachine.currentPhaseId !== previousPhaseId;
    return { phaseId: this.phaseMachine.currentPhaseId, changed, controller: this.lastController };
  }
}
```

Note what changed structurally from Task 5's version: `phaseMachine.step(dtMs)` now runs on **every** call (not gated by decision cadence), because yellow/all-red timing is independent of the ~1.5s decision cadence. `requestPhase()` is still only called on a decision tick, but it may be a no-op (if mid-transition or already the active phase) — that's intentional, not a bug.

- [ ] **Step 6: Replace Task 5's `SignalController` test with transition-aware assertions**

Modify `sim-server/test/signals/SignalController.test.ts` — replace the file's contents:
```ts
import { describe, it, expect, vi } from "vitest";
import { SignalController } from "../../src/signals/SignalController";

const phases = [
  { id: "NS_through", allowedDirections: ["N", "S"] as const, durationMs: 8000 },
  { id: "EW_through", allowedDirections: ["E", "W"] as const, durationMs: 8000 }
];

function fakeDetector(states: Record<string, { queueLength: number; waitS: number }>) {
  return { getApproachState: (id: string) => states[id] ?? { queueLength: 0, waitS: 0 } } as any;
}

describe("SignalController", () => {
  it("stays on the current phase when the AI client returns the same phase", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, client as any, fakeDetector({}), "int_1");

    const result = await controller.step(1500);
    expect(result.phaseId).toBe("NS_through");
    expect(result.changed).toBe(false);
  });

  it("does not flip immediately when the AI client proposes a new phase — yellow and all-red must elapse first", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "EW_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, client as any, fakeDetector({}), "int_1");

    const result = await controller.step(1500); // decision made this tick; yellow begins
    expect(result.phaseId).toBe("NS_through");
    expect(result.changed).toBe(false);
    expect(controller.currentPhaseId).toBe("NS_through");
  });

  it("commits to the new phase only once yellow (3000ms) and all-red (1500ms) have both elapsed", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "EW_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, client as any, fakeDetector({}), "int_1");

    await controller.step(1500); // decision + yellow starts
    await controller.step(1500); // yellow: 0 -> 1500ms
    await controller.step(1500); // yellow: 1500 -> 3000ms, transitions to all-red
    expect(controller.currentPhaseId).toBe("NS_through"); // still not committed

    const result = await controller.step(1500); // all-red: 0 -> 1500ms, commits
    expect(result.phaseId).toBe("EW_through");
    expect(result.changed).toBe(true);
  });

  it("aggregates queue state by direction into phaseCandidates sent to the AI client", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const detector = fakeDetector({ app_N: { queueLength: 2, waitS: 3 }, app_S: { queueLength: 1, waitS: 1 } });
    const controller = new SignalController(phases, client as any, detector, "int_1");

    await controller.step(1500);

    const sentRequest = client.decide.mock.calls[0][0];
    const nsCandidate = sentRequest.phaseCandidates.find((c: any) => c.phaseId === "NS_through");
    expect(nsCandidate.queueLength).toBe(3);
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- SignalController`
Expected: PASS (4 tests).

- [ ] **Step 8: Add the additive `light` field to the state-snapshot schema**

Modify `shared-contracts/schemas/state-snapshot.schema.json` — add to the `signals` array item's `properties` (not `required`, so no existing test literal needs updating):
```json
"light": { "enum": ["green", "yellow", "red"] }
```

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 9: Wire `getApproachSignalStates()` into `SingleCarSession`'s signal display**

Modify `sim-server/src/room/SingleCarSession.ts` — Task 5 wired `signals: [{ intersectionId, phase, msRemainingMin }]`; extend that object with `light: this.signalController.getApproachSignalStates().get("app_N")` (using `app_N` as this single-car scaffold's arbitrary reference approach — it's throwaway code superseded by Phase 3's `SimSession`, which reports light state correctly per-approach; not worth over-engineering here).

- [ ] **Step 10: Manual verification**

Run: `docker compose -f infra/docker-compose.yml up --build`
Expected: driving toward the intersection, you should now observe the light hold green, switch to yellow briefly, go to red for a short all-red gap, and only then does the opposing direction get its green — instead of an instant flip.

- [ ] **Step 11: Commit**

```bash
git add sim-server/src/signals/SignalPhaseMachine.ts sim-server/src/signals/SignalController.ts sim-server/test/signals/SignalPhaseMachine.test.ts sim-server/test/signals/SignalController.test.ts shared-contracts/schemas/state-snapshot.schema.json shared-contracts/generated ai-service/app/contracts sim-server/src/room/SingleCarSession.ts
git commit -m "feat(sim-server): SignalPhaseMachine adds real green/yellow/all-red clearance sequencing"
```

---

### Task 7: Local integration check (sim-server ↔ ai-service, not yet a dedicated CI job)

**Files:**
- Create: `sim-server/test/signalIntegration.local.test.ts`
- Modify: `infra/docker-compose.yml` (add `ai-service`)
- Create: `ai-service/Dockerfile`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: nothing new — this task is verification only.

Per `00-overview.md` §5, the dedicated `integration` CI job (docker-compose up both services, run suite, tear down) is added in Phase 3, once multiplayer gives it more to test. This task still needs to prove the cross-service HTTP path actually works end-to-end now, not defer that proof to Phase 3 — so it's a local-only test, run manually, not yet gated in CI.

- [ ] **Step 1: Add `ai-service` to Docker Compose**

`ai-service/Dockerfile`:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN pip install uv
COPY . .
RUN uv sync --frozen
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Modify `infra/docker-compose.yml` — add:
```yaml
  ai-service:
    build:
      context: ..
      dockerfile: ai-service/Dockerfile
    ports: ["8000:8000"]

  # sim-server gains:
  #   depends_on: [ai-service]
  #   environment: [ "AI_SERVICE_URL=http://ai-service:8000" ]
```

- [ ] **Step 2: Write the local integration test**

`sim-server/test/signalIntegration.local.test.ts`:
```ts
// Run manually against a live ai-service: `uv run uvicorn app.main:app --port 8000` in ai-service/,
// then `pnpm --filter sim-server test -- signalIntegration.local`.
// Not run in CI (see 00-overview.md §5 — dedicated integration job arrives Phase 3).
import { describe, it, expect } from "vitest";
import { AiSignalClient } from "../src/signals/AiSignalClient";

describe.skipIf(!process.env.RUN_LOCAL_INTEGRATION)("sim-server <-> ai-service (local, manual)", () => {
  it("gets a real rule-based decision back from a live ai-service", async () => {
    const client = new AiSignalClient("http://localhost:8000");
    const result = await client.decide({
      intersectionId: "int_1",
      currentPhaseId: "NS_through",
      timeInPhaseMs: 5000,
      phaseCandidates: [
        { phaseId: "NS_through", queueLength: 0, waitS: 0 },
        { phaseId: "EW_through", queueLength: 6, waitS: 15 }
      ]
    });
    expect(result.phaseId).toBe("EW_through");
    expect(result.controller).toBe("rule_based");
  });
});
```

- [ ] **Step 3: Run it manually**

Run: `cd ai-service && uv run uvicorn app.main:app --port 8000 &` then `RUN_LOCAL_INTEGRATION=1 pnpm --filter sim-server test -- signalIntegration.local`
Expected: PASS. Stop the background `uvicorn` process afterward.

- [ ] **Step 4: Commit**

```bash
git add infra/docker-compose.yml ai-service/Dockerfile sim-server/test/signalIntegration.local.test.ts
git commit -m "chore: add ai-service to Docker Compose; add manual sim<->ai integration check"
```

---

### Task 8: `SessionStore` + recorder — session JSON logging goes live

**Files:**
- Create: `sim-server/src/session/SessionEvent.ts`
- Create: `sim-server/src/session/SessionStore.ts`
- Create: `sim-server/src/session/LocalDiskSessionStore.ts`
- Modify: `sim-server/src/room/SingleCarSession.ts` (create a session on startup, record `phase_change` events)
- Test: `sim-server/test/session/LocalDiskSessionStore.test.ts`

**Interfaces:**
- Produces (Interface ledger, Phase 2): `SessionStore` interface, `LocalDiskSessionStore` implementation, `SessionEvent`/`SessionFile`/`KpiSnapshot`/`FinalScore` types.

- [ ] **Step 1: Write the session types**

`sim-server/src/session/SessionEvent.ts`:
```ts
export interface PhaseChangeEvent {
  t: number;
  type: "phase_change";
  intersection: string;
  phase: string;
  controller: "rule_based" | "rl";
}

// Phase 3 adds: UserJoinEvent | UserLeaveEvent | CollisionEvent
// Phase 7 adds: EvSpawnEvent | EvPreemptEvent
export type SessionEvent = PhaseChangeEvent;

export interface KpiSnapshot {
  t: number;
  avgVehicleWaitS: number;
  throughput: number;
  // Phase 5 adds: avgPedWaitS, jaywalkEvents
}

export interface FinalScore {
  scenario: string;
  result: "pass" | "fail";
  avgWaitDeltaPct: number;
}

export interface SessionParticipant {
  clientId: string;
  carId: string;
}

export interface SessionFile {
  sessionId: string;
  startedAt: string;
  mapId: string;
  scenario: string | null;
  participants: SessionParticipant[];
  events: SessionEvent[];
  kpiSnapshots: KpiSnapshot[];
  finalScore: FinalScore | null;
}
```

- [ ] **Step 2: Write the `SessionStore` interface**

`sim-server/src/session/SessionStore.ts`:
```ts
import type { SessionEvent, KpiSnapshot, FinalScore, SessionFile } from "./SessionEvent";

export interface SessionStore {
  create(sessionId: string, meta: { mapId: string; scenario: string | null }): void;
  writeEvent(sessionId: string, event: SessionEvent): void;
  writeKpiSnapshot(sessionId: string, snapshot: KpiSnapshot): void;
  finalize(sessionId: string, score: FinalScore): void;
  read(sessionId: string): SessionFile;
}
```

- [ ] **Step 3: Write the failing test for `LocalDiskSessionStore`**

`sim-server/test/session/LocalDiskSessionStore.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("LocalDiskSessionStore", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "session-store-test-"));
    store = new LocalDiskSessionStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a session file with the §8 schema shape (snake_case on disk)", () => {
    store.create("sess_1", { mapId: "grid_1x1_v1", scenario: null });
    const file = store.read("sess_1");
    expect(file.sessionId).toBe("sess_1");
    expect(file.mapId).toBe("grid_1x1_v1");
    expect(file.events).toEqual([]);
  });

  it("appends events and kpi snapshots, persisted across reads", () => {
    store.create("sess_1", { mapId: "grid_1x1_v1", scenario: null });
    store.writeEvent("sess_1", { t: 1.2, type: "phase_change", intersection: "int_1", phase: "EW_through", controller: "rule_based" });
    store.writeKpiSnapshot("sess_1", { t: 60, avgVehicleWaitS: 4.2, throughput: 12 });

    const file = store.read("sess_1");
    expect(file.events).toHaveLength(1);
    expect(file.kpiSnapshots).toHaveLength(1);
  });

  it("finalize sets final_score and later reads reflect it", () => {
    store.create("sess_1", { mapId: "grid_1x1_v1", scenario: "rush_hour" });
    store.finalize("sess_1", { scenario: "rush_hour", result: "pass", avgWaitDeltaPct: 8.3 });

    expect(store.read("sess_1").finalScore).toEqual({ scenario: "rush_hour", result: "pass", avgWaitDeltaPct: 8.3 });
  });

  it("throws when reading a session that was never created", () => {
    expect(() => store.read("does_not_exist")).toThrow();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter sim-server test -- LocalDiskSessionStore`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement `LocalDiskSessionStore`**

`sim-server/src/session/LocalDiskSessionStore.ts`:
```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { SessionStore } from "./SessionStore";
import type { SessionEvent, KpiSnapshot, FinalScore, SessionFile } from "./SessionEvent";

export class LocalDiskSessionStore implements SessionStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.json`);
  }

  create(sessionId: string, meta: { mapId: string; scenario: string | null }): void {
    const file: SessionFile = {
      sessionId,
      startedAt: new Date().toISOString(),
      mapId: meta.mapId,
      scenario: meta.scenario,
      participants: [],
      events: [],
      kpiSnapshots: [],
      finalScore: null
    };
    this.write(file);
  }

  writeEvent(sessionId: string, event: SessionEvent): void {
    const file = this.read(sessionId);
    file.events.push(event);
    this.write(file);
  }

  writeKpiSnapshot(sessionId: string, snapshot: KpiSnapshot): void {
    const file = this.read(sessionId);
    file.kpiSnapshots.push(snapshot);
    this.write(file);
  }

  finalize(sessionId: string, score: FinalScore): void {
    const file = this.read(sessionId);
    file.finalScore = score;
    this.write(file);
  }

  read(sessionId: string): SessionFile {
    const filePath = this.filePath(sessionId);
    if (!existsSync(filePath)) throw new Error(`No session found for ${sessionId}`);
    return JSON.parse(readFileSync(filePath, "utf-8")) as SessionFile;
  }

  private write(file: SessionFile): void {
    writeFileSync(this.filePath(file.sessionId), JSON.stringify(file, null, 2));
  }
}
```

Note: this uses full read-modify-write per call rather than an append-only log — acceptable at "a handful of concurrent users" scale (spec's own concurrency ceiling) where writes are infrequent (phase changes every several seconds, KPI snapshots per spec's ~60s cadence). Re-evaluate only if Phase 8's load test shows write contention, which the spec's scale doesn't predict.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter sim-server test -- LocalDiskSessionStore`
Expected: PASS (4 tests).

- [ ] **Step 7: Wire the recorder into `SingleCarSession`**

Modify `sim-server/src/room/SingleCarSession.ts` constructor: instantiate `new LocalDiskSessionStore(process.env.SESSION_STORE_DIR ?? "./sessions")`, generate a `sessionId` (e.g. `crypto.randomUUID()`), call `store.create(sessionId, { mapId: map.id, scenario: null })`. In `step()`, after `signalController.step()` returns `{ phaseId, changed }`, if `changed` is true call `store.writeEvent(sessionId, { t: this.tick * (TICK_MS / 1000), type: "phase_change", intersection: "int_1", phase: phaseId, controller: "rule_based" })`.

- [ ] **Step 8: Manual verification**

Run: `docker compose -f infra/docker-compose.yml up --build`, drive for ~60 seconds letting the signal actuate at least twice, then inspect `sessions/*.json` on the sim-server container's mounted volume (or exec into the container) — confirm `events` contains `phase_change` entries with alternating phases and increasing `t`.

- [ ] **Step 9: Commit**

```bash
git add sim-server/src/session sim-server/test/session sim-server/src/room/SingleCarSession.ts
git commit -m "feat(sim-server): SessionStore + recorder; phase changes logged to session JSON"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes | `rule_based.decide_phase`, `apply_safety_constraints` (both directions of veto + forced switch), `QueueDetector`, `AiSignalClient`, `SignalController`, `LocalDiskSessionStore` |
| Integration | Partial, local-only | `/signal-decision` route test (`TestClient`, in-process) + manual cross-service check (Task 7) — dedicated CI-gated docker-compose job arrives Phase 3 |
| Physics/determinism | Not yet | Still no vehicle-vehicle collisions to test determinism against — Phase 3 |
| Load | Not yet | Phase 8 |
| RL regression | N/A | No RL until Phase 6 |
| E2E | Manual only | Extended smoke test: drive, observe actuated switching, inspect session JSON |

## Definition of Done

- [ ] `unit-py` CI job green alongside the three Phase-1 jobs.
- [ ] `/signal-decision` returns a `rule_based`-controlled decision that respects min/max green under the test scenarios in Task 3.
- [ ] Driving up to an approach and waiting causes the opposing phase's queue to eventually win and the signal to switch (observable in the Task 8 Step 8 manual check).
- [ ] A session JSON file is written to `sessions/` (or `SESSION_STORE_DIR`) containing at least one `phase_change` event after a short drive.
- [ ] Every file in the Interface ledger's "From Phase 2" section (`00-overview.md` §6) exists with the exact signature listed.

## Risks / open implementation notes

- `SignalController`'s `APPROACH_DIRECTIONS` hardcoding (Task 5, Step 7) is scoped to `grid_1x1_v1`'s 4 cardinal approaches — if Phase 9's second map (if authored) has a different approach layout, this becomes a small follow-up, not a redesign, since `SignalController`'s constructor already takes `phases` as data.
- `QueueDetector`'s wait-time model (max wait among currently-queued vehicles) is a simplification adequate for a single-lane, single-vehicle Phase 2 — Phase 3's multiplayer scaling should re-examine whether "max" or "average" wait better drives fair signal behavior once more than one car can queue simultaneously; this is a tuning question, not an interface change.
