# AI Traffic Management Sandbox — Phase Plan Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement any phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) (repo root) — this overview and every phase file argue from that spec. Read both together; phase files do not repeat architectural rationale already settled there.

This directory holds one implementation-plan file per build-order step from spec §14, plus this overview. There is no calendar attached to any phase — order is dependency order only.

| # | File | Spec §14 step | Delivers |
|---|------|----------------|----------|
| 0 | `00-overview.md` | — | This document |
| 1 | `01-core-loop.md` | 1 | Monorepo scaffold, sim server, one map, one keyboard car, fixed-time signal |
| 2 | `02-signal-ai-v1.md` | 2 | Rule-based actuated signal AI + safety wrapper; session JSON logging begins |
| 3 | `03-multiplayer-collisions.md` | 3 | Shared room, car claim/handoff, full Matter.js collision response, disconnect recovery |
| 4 | `04-touch-input.md` | 4 | Virtual touch controls alongside keyboard |
| 5 | `05-pedestrian-agents.md` | 5 | Waypoint graph, steering, jaywalking model, RL observation interface stub |
| 6 | `06-rl-training.md` | 6 | Gym env, PPO training, ONNX export, eval gate, classical/RL toggle |
| 7 | `07-emergency-vehicle.md` | 7 | EV routing, ETA calc, override layer, release logic |
| 8 | `08-testing-cicd-hardening.md` | 8 | Close every gap in the §11 test pyramid; wire the full §12 GH Actions pipeline |
| 9 | `09-art-pass.md` | 9 | AI-generated sprites, cleanup, atlas packing, swap placeholders |
| 10 | `10-scoring-deploy.md` | 10 | All 4 challenge scenarios, in-app KPI panel, Fly.io deploy with persistent volume |

**Note on phase 0/1 merge:** the spec's §14 build order has no separate "repo bootstrap" step — it's implied by TR-14 (monorepo layout) and §12 (CI shape). Rather than invent a phase with no shippable deliverable, bootstrap work (package layout, shared-contracts tooling, base CI) is Task 1 inside `01-core-loop.md`. Nothing in phase 1 can start without it anyway, so it doesn't need its own gate.

---

## 1. Dependency graph

```
01 core-loop
 └─▶ 02 signal-ai-v1 ──▶ 06 rl-training ─┐
      │                                  │
      ▼                                  ▼
     03 multiplayer-collisions ──▶ 07 emergency-vehicle
      │                                  │
      ▼                                  │
     04 touch-input                      │
      │                                  │
      ▼                                  │
     05 pedestrian-agents ────────────────┤
                                          ▼
                              08 testing-cicd-hardening
                                          │
                                          ▼
                              09 art-pass ──▶ 10 scoring-deploy
```

Rules that follow from this graph:
- **02 depends on 01**: the safety wrapper and RL later need a running physics/signal loop to wrap.
- **03 depends on 02**: multiplayer car-handoff needs session JSON logging already live (spec: "session JSON logging live from here on" starts at step 2) so joins/leaves are recorded from the first multiplayer session onward.
- **04 depends on 03**: touch input is additive to the input pipeline multiplayer already exercises; no new interfaces, so it's the shortest phase.
- **05 depends on 03** (not 04): pedestrians share the Matter.js world and need the full collision response from phase 3, but have no dependency on touch input.
- **06 depends on 02 and 05**: the Gym env's observation space includes pedestrian queue/wait state (spec §7), so the pedestrian system must exist before the env is finalized — even though RL is scoped as its own phase, its observation contract is written once, not twice.
- **07 depends on 03** for the road graph/A* substrate and on **06** for the override layer's position in the three-tier hierarchy (RL policy → safety wrapper → EV override) — EV override can't be slotted in front of a decision pipeline that doesn't exist yet.
- **08 depends on everything through 07**: it closes gaps across the full system, so it must run last among functional phases.
- **09 (art)** only touches rendering, not simulation logic, so it can start once 03 (multiplayer) and 04 (touch) exist — placeholder rectangles are swapped for sprites without touching sim/AI code. It's sequenced after 08 per the spec's stated reasoning (validate everything against placeholders first) rather than for a hard technical dependency.
- **10 depends on 09**: deploy is the last phase; scoring scenarios exercise the finished pedestrian + EV + RL system, and demo polish (art) should be in place before it ships.

---

## 2. Toolchain decisions (binding on every phase)

The spec leaves a few implementation choices open ("Socket.IO/ws", "JSON Schema/protobuf"). These are now locked so every phase file can write concrete code instead of re-deciding per phase:

| Decision point | Choice | Why |
|---|---|---|
| Monorepo package manager | **pnpm workspaces** | Native workspace protocol (`workspace:*`), fast, disk-efficient — matters when `sim-server`, `frontend`, and generated `shared-contracts` TS all depend on each other locally. |
| Node package manager scope | `sim-server/`, `frontend/`, `shared-contracts/` are pnpm workspace members. `ai-service/` is Python and lives outside the pnpm workspace, in the same repo. |
| Python tooling | **uv** for env + dependency management, **pytest** for tests, **ruff** for lint | Fast, single binary, works identically on the Fly.io build image and both local machines (5090 box, M4). |
| Node build/dev | **tsx** for dev execution, **tsc** for type-checking/build, **vitest** for tests, **eslint + prettier** for lint | Matches spec §11's `vitest`/`pytest` line item exactly; tsx avoids a bundler for a server process. |
| WS transport | Raw **`ws`** library, not Socket.IO | Single shared room (spec §3) needs no multi-room routing, presence, or fallback transport — `ws` gives full control over the message envelope at lower runtime overhead, which matters on a free-tier Fly.io instance. |
| WS message envelope | `{ type: string; payload: T; ts: number }` — see §3 below | One envelope shape for every message class (input, state snapshot, event), discriminated by `type`. |
| Shared contract format | **JSON Schema** (not protobuf) as source of truth | Human-readable, diffable in PRs, and pairs naturally with the JSON session-file philosophy (spec §8) — no binary wire format needed at this message rate (15-30Hz, small payloads). |
| TS codegen from schema | `json-schema-to-typescript` | Mature, zero-runtime-dependency `.d.ts` generation. |
| Python codegen from schema | `datamodel-code-generator` (pydantic v2 output) | Standard tool for JSON Schema → pydantic; matches FastAPI's native pydantic v2 request/response models. |
| Physics engine | `matter-js` + `@types/matter-js` | Per spec, locked. |
| Signal AI service framework | FastAPI + uvicorn, ONNX Runtime (`onnxruntime`) for inference | Per spec, locked. |
| RL training stack | Gymnasium + Stable-Baselines3 (PPO) + `onnx`/`skl2onnx`-style export via SB3's built-in ONNX export path | Per spec, locked. |
| Storage interface | A single `SessionStore` TS interface (`writeEvent`, `writeKpiSnapshot`, `finalize`, `read`) backed by one filesystem implementation, base directory from `SESSION_STORE_DIR` env var | Local disk and the Fly.io persistent volume are both "a directory on a filesystem" — the interface exists for testability (inject a temp-dir or in-memory store in unit tests), not because the two deployment targets need different code paths. |
| E2E | Playwright | Per spec, locked. |
| Load testing | `k6` | Per spec, locked. |

> **Bug found during implementation (Phase 5):** `sim-server/tsconfig.json`'s `moduleResolution: "NodeNext"` requires every relative import (`./x`, `../x`) to carry an explicit `.js` extension — but no phase's tasks ever wrote imports that way, and no CI job runs `tsc`/`pnpm build` before Phase 8 (see §5's table — this is by design, not an oversight), so `vitest`/`tsx`'s looser resolution let every phase's tests pass while `pnpm --filter sim-server build` (and therefore `sim-server/Dockerfile`'s `RUN pnpm --filter sim-server build`, and therefore the whole Docker/Fly.io deploy path) was silently broken since Phase 1. Caught only by manually running `tsc --noEmit` mid-Phase-5, not by any automated gate. Fixed by adding `.js` to every relative import across `sim-server/src/**/*.ts` (mechanical; `frontend` is unaffected — its `moduleResolution: "Bundler"` doesn't require this). **Any future phase file's task that adds a new TS file to `sim-server/src` must write its relative imports with `.js` extensions from the start** (e.g. `import { X } from "./y.js"`), not append the fix later.

---

## 3. Repo layout (created in full by end of Phase 1, populated incrementally after)

```
/repo
  /plans/phases/            (this planning work — not shipped/deployed)
  /sim-server/              (TypeScript, Node, Matter.js, ws)
    src/
      server.ts             (entrypoint: HTTP+WS listen)
      room/                 (RoomManager, connection handling)
      physics/              (PhysicsWorld wrapper, body factories)
      vehicles/             (IDM controller, input application)
      pedestrians/          (added phase 5)
      ev/                   (added phase 7)
      signals/              (signal phase state machine, calls ai-service)
      session/              (SessionStore + recorder, added phase 2)
      maps/                 (map loader/validator)
    test/
    package.json
  /ai-service/              (Python, FastAPI, ONNX Runtime, SB3 training scripts)
    app/
      main.py               (FastAPI app)
      safety_wrapper.py     (added phase 2)
      rl_policy.py          (added phase 6)
      ev_override.py        (added phase 7)
      reward.py             (added phase 6)
    training/               (Gym env + PPO training scripts, added phase 6)
    tests/
    pyproject.toml
  /frontend/                (Phaser 3, TypeScript)
    src/
    package.json
  /shared-contracts/        (JSON Schema source + generated TS/Python types)
    schemas/
    generated/ts/
    generated/py/
    package.json            (codegen scripts)
  /models/                  (versioned ONNX checkpoints + manifest.json, added phase 6)
  /maps/                    (1-2 hand-authored JSON road networks)
  /infra/                   (Dockerfiles, docker-compose.yml, Fly.io configs)
  /.github/workflows/       (CI, grows phase by phase — see §5)
  pnpm-workspace.yaml
  package.json
```

---

## 4. Shared-contracts flow (cross-cutting; every phase that adds a message type follows this exact order)

1. **Edit schema** — add/modify a `.schema.json` file under `shared-contracts/schemas/`.
2. **Regenerate** — run `pnpm --filter shared-contracts generate`, which runs both codegen tools and writes `generated/ts/*.d.ts` and `generated/py/*.py`.
3. **Consume in TS** — `sim-server`/`frontend` import generated types from `shared-contracts` (a pnpm workspace dependency, `workspace:*`).
4. **Consume in Python** — `ai-service` imports generated pydantic models from a copy step (uv doesn't resolve pnpm workspace packages, so `shared-contracts/generated/py` is copied into `ai-service/app/contracts/` by the same `generate` script — see phase 1 Task 1 for the exact script).
5. **CI drift check** — a CI step (added phase 1, never removed) re-runs `generate` and fails the build if `git diff --exit-code` reports changes, i.e. someone edited a schema without regenerating, or edited generated output by hand.

Every phase's task list that touches a WS/RPC message shape starts with "1. edit schema" as its first task — never with hand-written TS/Python types.

> **Bug found during implementation (Phase 5):** `signal-decision.schema.json` originally nested `SignalDecisionRequest`/`SignalDecisionResponse` as `properties` of a single wrapper object (`$id: "SignalDecision"`) instead of as `$ref`-reachable `definitions`. `datamodel-code-generator` (Python side) happens to flatten this shape into top-level classes anyway, so `ai-service` worked and its tests passed — but `json-schema-to-typescript` (TS side) only hoists `$ref`-reachable definitions into named top-level interfaces, so `SignalDecisionRequest`/`SignalDecisionResponse` never got exported on the TS side at all, and `sim-server/src/signals/AiSignalClient.ts`'s import of them was silently broken (again invisible to `vitest`, only surfaced by `tsc --noEmit`). Fixed by moving both into `definitions` alongside `PhaseCandidate`, and passing `{ unreachableDefinitions: true }` to `compileFromFile` in `generate.mjs` so definitions get hoisted regardless of whether the root schema itself references them. **Any future schema that groups multiple named request/response shapes under one `$id` must put every shape that needs its own exported TS type in `definitions`, never in top-level `properties`.**

---

## 5. CI evolution (single workflow file, grown incrementally — never a rewrite)

`.github/workflows/ci.yml` gains jobs as each phase needs them. No phase removes or rewrites a prior job; phase 8 is where gaps are closed, not where the file is restructured.

| Phase | CI job added | Gate |
|---|---|---|
| 1 | `lint` (eslint + ruff), `contracts-drift` (§4 step 5), `unit-ts` (path-filtered to changed packages) | Blocks merge |
| 2 | `unit-py` (pytest, path-filtered) | Blocks merge |
| 3 | `integration` (docker-compose up sim-server + ai-service, run integration suite, tear down) | Blocks merge |
| 6 | `rl-regression` — **conditional**, runs only if `models/manifest.json` or `ai-service/training/**` changed | Blocks promotion of the checkpoint, not unrelated merges |
| 8 | `load` (k6 smoke thresholds), `e2e` (Playwright), `build` (Docker images for sim-server + ai-service) | Blocks merge |
| 10 | `deploy` (Fly.io, on merge to `main`, manual approval gate) | Blocks deploy, not merge |

This table is the authoritative source for "which CI job does this phase add" — individual phase files reference it rather than re-deriving the pipeline shape.

---

## 6. Interface ledger

Running record of every cross-phase interface, updated as each phase file is written, so later phases reference exact names instead of re-deriving them. (Populated phase-by-phase below; this section is the single source of truth if a later phase file and this ledger ever disagree, the ledger wins and the phase file has a bug.)

### From Phase 1
- `shared-contracts/schemas/client-input.schema.json` → TS `ClientInputMessage`, Py `ClientInputMessage`
  - `{ type: "input"; payload: { carId: string; throttle: number; brake: number; steer: number }; ts: number }`
- `shared-contracts/schemas/state-snapshot.schema.json` → TS `ServerStateSnapshot`, Py `ServerStateSnapshot`
  - `{ type: "state"; payload: { tick: number; vehicles: VehicleState[]; signals: SignalState[] }; ts: number }`
  - `VehicleState = { id: string; x: number; y: number; heading: number; speed: number; controller: "idm" | "user" }`
  - `SignalState = { intersectionId: string; phase: string; msRemainingMin: number }`
- `sim-server/src/physics/PhysicsWorld.ts` → class `PhysicsWorld` — `constructor(mapDef: MapDefinition)`, `.step(dtMs: number): void`, `.engine: Matter.Engine`
- `sim-server/src/maps/MapDefinition.ts` → type `MapDefinition` (loaded/validated from `/maps/*.json`)
- `sim-server/src/vehicles/IdmController.ts` → function `idmAcceleration(self: IdmState, leader: IdmState | null, params: IdmParams): number`

### From Phase 2
- `ai-service/app/main.py` → `POST /signal-decision` — request `SignalDecisionRequest`, response `SignalDecisionResponse` (schemas in `shared-contracts/schemas/signal-decision.schema.json`)
- `ai-service/app/safety_wrapper.py` → `def apply_safety_constraints(proposed: PhaseDecision, state: IntersectionState, rules: SafetyRules) -> PhaseDecision`
- `sim-server/src/session/SessionStore.ts` → interface `SessionStore` — `create(sessionId, meta: { mapId: string; scenario: string | null })`, `writeEvent(sessionId, event: SessionEvent)`, `writeKpiSnapshot(sessionId, snap: KpiSnapshot)`, `finalize(sessionId, score: FinalScore)`, `read(sessionId): SessionFile`
- `ai-service/app/main.py` `POST /signal-decision` request/response types come from `shared-contracts/schemas/signal-decision.schema.json` (generated `SignalDecisionRequest`/`SignalDecisionResponse`), **not** hand-written pydantic models — see shared-contracts flow (§4).
- **Note on `SessionEvent`:** this type is sim-server-internal persistence, not a Node↔Python wire message — it is hand-written TypeScript in `sim-server/src/session/SessionEvent.ts`, not generated from `shared-contracts`. The §4 "always start with a schema edit" rule applies only to messages actually exchanged between Node and Python (WS messages, `/signal-decision` RPC) — session JSON is written by and read only by TS code (sim-server records it, Phase 10's `scoreScenario` reads it).
- **`sim-server/src/signals/SignalPhaseMachine.ts`** (added in this phase's Task 6, prompted mid-plan by a design gap the user caught — signals need a real green→yellow→all-red→green clearance sequence, not an instant flip) → `type SignalLightState = "green" | "yellow" | "red"`; class `SignalPhaseMachine` — `constructor(initialPhaseId: string, yellowMs = 3000, allRedMs = 1500)`, `.requestPhase(phaseId): void` (a no-op while mid-transition — this is what makes "won't cut off a phase mid-transition" a structural guarantee rather than a heuristic), `.step(dtMs): void`, `.currentPhaseId: string`, `.greenElapsedMsValue: number`, `.lightStateFor(phaseId): SignalLightState`.
- `SignalController` (Task 5) is refactored in Task 6 to route every phase change through the machine: `.step()`'s return type widens to `{ phaseId, changed, controller }`, and it gains `.getApproachSignalStates(): Map<string, SignalLightState>` — the per-approach state map every AI-controlled vehicle and pedestrian consumes from Phase 3 onward. `timeInPhaseMs` now specifically means green-elapsed time (excluding clearance overhead).
- `ServerStateSnapshot.payload.signals[].light: SignalLightState` (additive) — the frontend's actual color comes from here, not from guessing based on phase id.

### From Phase 3
- `sim-server/src/room/RoomManager.ts` → class `RoomManager` — `constructor(getClaimableVehicle: () => VehicleBody | null, maxHumanCars: number, disconnectGraceMs: number)`, `.join(clientId): { carId: string } | { error: "capacity_reached" }`, `.leave(clientId): void`, `.step(dtMs): void`, `.ownerOf(carId): string | null`. **(Correction: supersedes this section's original sketch, which guessed a `CarClaimResult` type and a `.claimCar()` method that don't exist — the real design is claim-pool-driven via an injected getter, not an explicit claim call.)**
- `shared-contracts/schemas/room-events.schema.json` → one discriminated-union WS message, `RoomEventMessage`, payload `{ kind: "user_join" | "user_leave"; clientId; carId } | { kind: "collision"; entities: [string,string]; collisionKind }`. **(Correction: supersedes this section's original sketch of three separate types, `UserJoinEvent`/`UserLeaveEvent`/`CarClaimEvent` — the real design unions them into one message type.)**
- Collision event shape (extends `SessionEvent`, sim-server-internal, not a shared-contracts type): `CollisionEvent = { t: number; type: "collision"; entities: [string, string]; kind: "vehicle_vehicle" | "vehicle_pedestrian"; cause?: "jaywalk" }`
- **`sim-server/src/vehicles/TurnPaths.ts`** (added mid-plan alongside the turning revision below) → `interface VehiclePath { totalLength; stopLineDistance; pointAt(d); headingAt(d) }`, `function buildVehiclePath(mapDef, entryApproachId, exitApproachId): VehiclePath` — straight or curved (quadratic Bezier through a procedurally-derived intersection corner), derived purely from `MapDefinition` geometry. Reused as-is by Phase 7's `EvRouter`.
- `sim-server/src/vehicles/TrafficController.ts` → class `TrafficController` — `constructor(world, mapDef: MapDefinition, idmParams, rng, arrivalRatePerMinPerApproach, onSpawn)`, `.step(dtMs, approachSignalStates: Map<string, SignalLightState>): void`, `.vehicles: VehicleBody[]`, `.claimableVehicle(): VehicleBody | null`, `.vehicleMovements(): Array<{ id, entryApproachId, exitApproachId }>` (gains `.setArrivalRate()` in Phase 10). **(Revised from an earlier straight-only design after the user asked "wouldn't [no turning] compromise left and right turns and moving?" — correct catch: every AI vehicle now gets a real entry→exit movement via `TurnPaths`, with a dilemma-zone rule on yellow, instead of despawning at the intersection center. The second argument is the whole `MapDefinition`, not just `approaches` — `TurnPaths` needs full map access. The third argument was `greenApproachIds: Set<string>` in the original sketch; it's a richer per-approach state map now, sourced from `SignalController.getApproachSignalStates()`.)**
- `sim-server/src/vehicles/TrafficSpawner.ts` → class `TrafficSpawner` — `constructor(approachIds, rng, arrivalRatePerMinPerApproach)`, `.step(dtMs): string[]`
- `sim-server/src/util/mulberry32.ts` → `function mulberry32(seed: number): () => number`
- `sim-server/src/physics/CollisionLogger.ts` → class `CollisionLogger` — `constructor(world, onCollision: (entities, kind) => void)` (`kind` param added Phase 5 — see below)
- `sim-server/src/room/SimSession.ts` → class `SimSession`, replaces Phase 1-2's throwaway `SingleCarSession` — constructor and full method surface documented in Phase 3 Task 6, extended in every later phase

### From Phase 4
- `shared-contracts/schemas/client-input.schema.json` extended: `payload.inputMethod: "keyboard" | "touch"` (additive, now required — every construction site updated in the same phase)
- `frontend/src/net/SimClient.ts` gains `.onJoined(cb)` — the frontend's `myCarId` handshake, not originally planned but required once Phase 3 made cars plural

### From Phase 5
- `sim-server/src/pedestrians/PedestrianGraph.ts` → class `PedestrianGraph` — `constructor(nodes, edges)`, `.node(id)`, `.shortestPath(fromId, toId): string[]`, `.edgeBetween(a, b)`
- `maps/grid_1x1_v1.json` gains `pedestrianNodes`/`pedestrianEdges`; `MapDefinition` extended to match
- `sim-server/src/pedestrians/steering.ts` → `function computeSteeringForce(self, target, neighbors, params): { fx, fy }`
- `sim-server/src/pedestrians/JaywalkModel.ts` → `function jaywalkProbability(waitS: number, patienceS: number): number`. **(Correction: parameter name is `waitS`, not `waitMs` as originally sketched — seconds throughout, matching every other wait-time field in this codebase.)**
- `sim-server/src/pedestrians/PedestrianController.ts` → class `PedestrianController` — `constructor(world, graph, farNodeIds, rng, arrivalRatePerMinPerNode)`, `.step(dtMs, approachSignalStates: Map<string, SignalLightState>): void`, `.agents: PedestrianSnapshot[]` (`PedestrianSnapshot = { id, x, y }` — the richer internal `Agent` shape with path/patience/jaywalking state is private), `.getCrossingState(crossingId): { queueLength, waitS }`, `.isJaywalking(pedId): boolean` (gains `.setArrivalRate()` in Phase 10). **(Correction: originally sketched as a public `PedestrianAgent` shape with `waypointPath`/`patience` fields — those exist but are internal, not exported. Also revised, same as `TrafficController`: takes the per-approach light-state map, not a plain `Set` of green approaches — a crossing is safe only on a confirmed `"red"`, never merely "not green," since yellow still means vehicles are clearing.)**
- `sim-server/src/physics/CollisionLogger.ts` callback signature becomes `(entities: [string, string], kind: "vehicle_vehicle" | "vehicle_pedestrian") => void` — a breaking change to Phase 3's original one-argument callback, updated at that call site (`SimSession`) in the same phase.
- `SignalDecisionRequest` gains `pedestrianCrossings: [{ crossingId, queueLength, waitS }]` (additive)
- `KpiSnapshot` gains `avgPedWaitS`, `jaywalkEvents`

### From Phase 6
- `SignalDecisionRequest` gains `approachStates: [{ approachId, direction, queueLength, waitS }]` (per-approach, finer-grained than `phaseCandidates`) and `requestedController?: "rule_based" | "rl"` (additive)
- `SignalDecisionResponse.controller` enum widens to `["rule_based", "rl"]`
- `ai-service/app/reward.py` → `def compute_reward(state: RewardInputs, weights: RewardWeights) -> float`
- `ai-service/app/observation.py` → `def build_observation_vector(approach_queues, phase_idx, num_phases, time_in_phase_s, ped_queues) -> np.ndarray` — the single function shared by training and real inference, not originally planned as its own module but necessary to keep the two in sync
- `ai-service/training/env.py` → `class TrafficSignalEnv(gymnasium.Env)` — a **training-only proxy simulation** (queueing-theory, not the real Matter.js physics), documented as a deliberate sim-to-real gap
- `ai-service/training/export_onnx.py` → `def export_onnx(model, obs_dim, out_path) -> None`
- `ai-service/app/rl_policy.py` → `class RlPolicy` — `constructor(model_path)`, `.decide(obs: np.ndarray) -> int` (a phase **index**, not a `PhaseDecision`). **(Correction: originally sketched returning a `PhaseDecision` — the real split is `RlPolicy` returns a raw index, and `routes.py` wraps it into a `PhaseDecision` alongside the rule-based path.)**
- `ai-service/training/eval_gate.py` → `def evaluate_checkpoint(onnx_path, benchmark_seeds, episode_steps) -> EvalScores`, `def check_regression(candidate, baseline, thresholds) -> bool`
- `models/manifest.json` schema: `{ checkpoints: [{ id, path, evalScores: {...}, promoted: boolean }] }` (`trainedAt` intentionally added by the real `eval_gate.py` CLI entrypoint — omitted from this planning workflow's own script only because `datetime.now()`-equivalents aren't available in this authoring context, not because the real field is dropped)
- `shared-contracts/schemas/controller-mode.schema.json` → `ControllerModeMessage` (frontend toggle → sim-server → `ai-service`)

### From Phase 7
- `sim-server/src/ev/RoadGraph.ts` → class `RoadGraph` + `function buildRoadGraph(mapDef): RoadGraph` — derived automatically from `MapDefinition`, no new hand-authored map data
- `sim-server/src/ev/EvRouter.ts` → class `EvRouter` — `constructor(world, mapDef)`, `.spawn(originApproachId: string, destinationApproachId: string): { evId } | { error }`, `.step(dtMs): void`, `.etaToIntersection(evId, intersectionId): number | null`, `.requiredPhaseId(evId): string | null`, `.hasPassedIntersection(evId): boolean`, `.activeVehicle(): VehicleBody | null`. **(Correction, twice over: originally sketched as `.spawn(destinationNodeId): EvHandle` — there is no `EvHandle` type, just a plain result object. An intermediate draft then had `.spawn(originApproachId)` alone, auto-deriving the *opposite* approach as the only reachable destination, back when this sim's vehicles couldn't turn. Once Phase 3 gained real turning via `TurnPaths`, `EvRouter` was revised to reuse it directly — `spawn` now takes an explicit `destinationApproachId`, and the EV can reach any of the other three approaches, straight or turning, exactly like regular AI traffic.)**
- `ai-service/app/ev_override.py` simplifies to `def apply_ev_override(decision: PhaseDecision, ev_context: EvContext | None) -> PhaseDecision` — no `state`/`min_transition_ms` parameters. Transition safety is now enforced structurally by `SignalPhaseMachine.requestPhase()` (Phase 2, Task 6), which refuses any request — from the override or anywhere else — while a yellow/all-red sequence is already running.
- `ai-service/app/ev_override.py` → `def apply_ev_override(decision: PhaseDecision, ev_context: EvContext | None, state: IntersectionState, min_transition_ms: float = 1500) -> PhaseDecision`. **(Correction: originally sketched with just `(decision, ev_context)` — the real signature also takes intersection `state` and a `min_transition_ms`, required to satisfy "won't cut off a phase mid-transition.")**
- `SignalDecisionRequest` gains `evContext: { evId, etaS, requiredPhaseId } | null` (additive)
- `SessionEvent` gains `EvSpawnEvent`, `EvPreemptEvent` (and, from Phase 10, `EvCompleteEvent`)
- `VehicleBody.controller` widens to `"idm" | "user" | "ev"`

### From Phase 10
- `sim-server/src/scoring/scenarios.ts` → `type Scenario = "rush_hour" | "emergency_vehicle" | "chaos" | "pedestrian_pressure"`, `SCENARIO_CONFIGS: Record<Scenario, ScenarioConfig>`
- `sim-server/src/scoring/scoreScenario.ts` → `function scoreScenario(scenario: Scenario, session: SessionFile): FinalScore`
- `shared-contracts/schemas/scenario-control.schema.json` → `StartScenarioMessage`, `ScenarioCompleteMessage`
- `shared-contracts/schemas/kpi-update.schema.json` → `KpiUpdateMessage`
- `SessionEvent` gains `EvCompleteEvent = { t, type: "ev_complete", evId, transitTimeS }`
- `SignalController.step()` return type widens to `{ phaseId, changed, controller }` (additive)

**General note on signature drift across this ledger:** several interfaces (`SignalController`'s constructor especially, growing an optional parameter in Phases 5, 6, and 7) evolved incrementally in ways no single phase file fully re-states. Where a phase file says "add an optional parameter," treat that as authoritative over any earlier phase's constructor snippet — optional parameters are additive by construction, so no earlier call site ever needs updating for this reason.

---

## 7. What each phase file assumes you've already read

Every phase file assumes: the spec, this overview (all 6 sections above), and every prior phase file's **Interface ledger** entries. A phase file does not re-explain the shared-contracts flow or CI table — it references §4/§5 above by number.
