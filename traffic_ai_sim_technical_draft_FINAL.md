# AI Traffic Management Sandbox - FINAL Technical Spec

Every open question has now been resolved. This is the complete system as decided - nothing deferred except what's explicitly marked as out-of-scope in §16. No timeline is attached, by request; phases in §14 are ordered by dependency, not by calendar.

---

## 0. Full Decision Log

| Area                | Decision                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Primary goal        | Portfolio/demo (main), playable/fun (secondary), research/pitch-adjacent (tertiary)                  |
| Concurrency         | Handful of concurrent users, single shared room - everyone who connects joins the same sim           |
| Deployment target   | Local first, then **Fly.io** free tier                                                               |
| Persistence         | All data. Driving sessions as JSON. No video.                                                        |
| Testing             | Full pyramid: unit, integration, physics-determinism, load, RL regression, E2E                       |
| Collision           | Real physics response (no clipping) → **Matter.js**, which forces the sim authority into **Node.js** |
| Storage             | Flat JSON files, behind a swappable storage interface                                                |
| CI/CD               | GitHub Actions - full suite + RL regression gate before deploy                                       |
| RL training         | Local: RTX 5090 mobile / Ultra 9 / 64GB (primary), M4 16GB (secondary)                               |
| Maps                | 1–2 hand-authored fixed JSON maps, no in-app editor                                                  |
| Reward function     | Multi-objective - optimized for what's actually best for the model/objective (see §7)                |
| Observability       | No Grafana - simple in-app KPI panel                                                                 |
| Pedestrians         | **Full agents** - walk speed, crowding, jaywalking risk                                              |
| Emergency vehicles  | **Realistic** - own routing, dynamic preemption along actual path                                    |
| Input               | Keyboard **and** touch (mobile-friendly)                                                             |
| Sim server language | **TypeScript**                                                                                       |
| Repo structure      | Monorepo (justified in §2)                                                                           |
| Visual style        | Polished pixel-art / vector                                                                          |
| Art pipeline        | AI-generated sprites, cleaned up                                                                     |
| Timeline            | Not fixed - left out by request                                                                      |
| Repo visibility     | Private, shared selectively                                                                          |

---

## 1. What this system actually is

A browser-based, multiplayer-capable 2D traffic sandbox where a hybrid classical/RL AI controls signals across a small road network populated by AI-driven vehicles **and** AI-driven pedestrians, while any connected user can drop into a car - with full physics, real collisions, and touch or keyboard control - and become a disruptive, unpredictable input the AI has to handle live. Sessions run through scenario-based challenges (rush hour, emergency vehicle, deliberate chaos) and every run is logged as structured JSON for scoring and replay.

---

## 2. Architecture

### 2.1 Why Node + Python, and why monorepo

Matter.js (your collision choice) is JS-only, so authoritative physics has to live in Node. RL/ONNX inference stays in Python - no reason to fight that, PyTorch/SB3/ONNX tooling is strongest there and it's your home turf. That makes this a genuine two-language system.

For repo structure, monorepo wins here specifically _because_ it's polyglot and solo/small-team: a single feature (e.g. "add pedestrian wait time to the RL observation") touches the Node sim server, the Python AI service, and the shared message contract in the same PR. Splitting those into separate repos means coordinating versioned contracts across repo boundaries for no real benefit at this scale - that overhead only pays off with independent teams/release cadences, which doesn't apply here.

```
/repo
  /sim-server        (TypeScript, Node, Matter.js, Socket.IO/ws)
  /ai-service         (Python, FastAPI, ONNX Runtime, SB3 training scripts)
  /frontend           (Phaser 3, TypeScript)
  /shared-contracts   (JSON Schema / protobuf defs for WS + RPC messages;
                        generates TS types + Python pydantic models)
  /models             (versioned ONNX checkpoints + manifest.json)
  /maps               (1-2 hand-authored JSON road networks)
  /infra              (Dockerfiles, docker-compose.yml, Fly.io configs, GH Actions)
```

`/shared-contracts` is the piece that stops the Node↔Python boundary from silently drifting - define message/RPC shapes once, generate both languages' types from it, and CI fails if either side's generated types go stale relative to the schema.

### 2.2 Full system diagram

```
┌──────────────────────────── Browser ─────────────────────────────┐
│ Phaser 3 (TS) - renderer, keyboard+touch input, in-app KPI panel │
└───────────────────────────────┬────────────────────────────────┘
                                │ WebSocket
┌───────────────────────────────▼────────────────────────────────┐
│              Sim/Physics Server - Node.js + TypeScript          │
│ ┌────────────┐┌───────────┐┌────────────┐┌───────────┐┌────────┐│
│ │ Room /     ││ Matter.js  ││ Vehicle AI ││ Pedestrian││ EV     ││
│ │ connection ││ physics    ││ (IDM)      ││ agents    ││ routing││
│ │ manager    ││ world      ││            ││ (steering,││ + ETA  ││
│ │            ││            ││            ││ jaywalk)  ││ calc   ││
│ └────────────┘└───────────┘└────────────┘└───────────┘└────────┘│
│ ┌───────────────────────────────────────────────────────────┐  │
│ │ Session recorder → JSON (events, KPIs, scores)              │  │
│ └───────────────────────────────────────────────────────────┘  │
│ Calls AI service every ~1-2 sim-seconds per intersection,       │
│ passing queue/wait state + pedestrian state + any EV ETA context│
└───────────────────────────────┬────────────────────────────────┘
                                │ HTTP/gRPC (low frequency)
┌───────────────────────────────▼────────────────────────────────┐
│               Traffic AI Service - Python + FastAPI             │
│  ┌──────────────┐   ┌─────────────────┐   ┌───────────────────┐│
│  │ RL policy     │ → │ Safety wrapper   │ → │ EV override layer  ││
│  │ (ONNX)        │   │ (hard rules)     │   │ (highest priority) ││
│  └──────────────┘   └─────────────────┘   └───────────────────┘│
│  Final decision returned to sim server; metrics exposed for the │
│  in-app KPI panel                                                │
└───────────────────────────────────────────────────────────────┘

Offline (local, 5090/M4): Gym env → SB3 PPO → eval vs. benchmark
scenarios → ONNX export → models/manifest.json → CI regression gate
```

**Three-tier control hierarchy, in priority order:** RL policy proposes → safety wrapper vetoes/clamps anything unsafe → EV override supersedes both when an emergency vehicle needs the corridor. This keeps the ML piece honest (it can't do anything provably unsafe) while still giving emergency routing absolute priority, which is how this works in reality too.

---

## 3. Multiplayer / session model (unchanged from v2, restated)

- Single shared room; connect → claim an unclaimed vehicle or spawn one (up to a concurrency cap).
- Disconnect → control reverts to IDM within a bounded timeout, never freezes in place.
- Anonymous session token per connection tags that client's data in the session JSON.

---

## 4. Physics & collision

- Vehicles and pedestrians are both Matter.js bodies (rectangles and small circles respectively), driven through a constrained force/torque controller rather than raw rigid-body dynamics - same approach as any top-down driving/crowd sim.
- Static bodies: road edges, sidewalks. Sensor (non-solid) zones: stop-lines, crosswalks, per-lane queue-detection zones.
- Real impulse-based collision response gives you both "no clipping" and a natural collision-event signal, which now matters for two things: vehicle-vehicle collisions (existing) **and** vehicle-pedestrian collisions from jaywalking (new - see §5), both logged and both relevant to scoring.

---

## 5. Pedestrian agent system (new)

Full agents, as decided - this is a second agent-based simulation layer running alongside vehicles in the same Node sim server.

- **Movement graph:** sidewalks + crosswalks as a waypoint graph (separate from the vehicle road graph, but crosswalk nodes link the two). Pathfinding via A\* over this graph to each pedestrian's destination.
- **Local behavior (crowding):** lightweight steering - separation (avoid crowding into other pedestrians) + seek (move toward next waypoint) + arrival slowdown. Deliberately **not** a full social-force model - that's expensive at scale and the fidelity gain doesn't matter for this project; boids-style steering reads as "crowding" convincingly at the density this sim runs at.
- **Jaywalking model:** each pedestrian has a patience/risk-tolerance value. While waiting at a crossing, accumulated wait time raises jaywalk probability per tick; above a rolled threshold, the pedestrian paths outside the crosswalk sensor zone - creating a real collision risk with vehicles via the shared Matter.js world, not a scripted animation.
- **Feeds the AI, not just decoration:** per-crossing pedestrian queue length and wait time are added to the RL observation space, and jaywalking events are logged and factored into scoring - the pedestrian system is functionally coupled to what the signal AI is optimizing for, not cosmetic.

---

## 6. Emergency vehicle priority system (new)

Realistic, as decided - this is the one piece that's fully rule-based/deterministic, not ML, and it lives partly in each service:

- **Node sim server (owns the road graph):** on EV spawn, compute shortest/fastest route via A\* to its destination node. Continuously recompute ETA to each upcoming intersection along that route as it moves.
- **Handoff to Python AI service:** each periodic signal-decision call includes an "EV incoming, ETA to this intersection" flag when applicable.
- **EV override layer (Python, highest priority tier):** when an EV ETA falls inside a scheduling window, force the relevant phase to green ahead of arrival, holding it through passage - this supersedes both the RL policy's proposal and the standard safety wrapper's normal constraints (though it still respects true physical safety limits, e.g. it won't cut off a phase mid-transition in a way that causes a collision).
- **Release:** a stop-line sensor detects the EV has passed through; that intersection reverts to normal (RL + safety wrapper) control immediately.
- **Explicitly deferred (see §16):** real-time congestion-aware rerouting (recalculating the EV's path based on live traffic, not just static shortest-path) is a legitimate stretch feature but not required for "realistic" preemption - static-route-with-dynamic-ETA already delivers the core behavior (signals turning green ahead of the ambulance along its path).

---

## 7. Traffic signal AI - reward function

"Best for the model and objective" resolves to a **multi-objective reward**, because a single-objective (pure wait-time) reward is exactly the setup that produces the known failure mode of starving one approach to optimize the others - which is why the safety wrapper exists at all, but a better reward reduces how often it needs to intervene:

```
reward = -(w1 * avg_vehicle_wait)
         -(w2 * approach_wait_variance)      # fairness - penalize starving any approach
         -(w3 * avg_pedestrian_wait)         # pedestrians matter now, not just vehicles
         -(w4 * jaywalk_event_count)         # indirectly discourages excessive ped wait
         +(w5 * throughput)
```

Exact weights (`w1..w5`) are tuned empirically once the Gym env exists - not something to lock in on paper. What's locked in now is the _shape_: vehicle wait, fairness, pedestrian wait, jaywalk-risk, and throughput are all first-class terms, because pedestrians and fairness are real requirements now, not afterthoughts bolted onto a vehicle-only reward.

**Observation space** (per intersection, per decision step): per-approach vehicle queue length + wait time, current phase + time-in-phase, per-crossing pedestrian queue length + wait time. EV context is _not_ part of the RL observation - it's handled entirely by the override layer, since preemption is deterministic, not something the policy needs to learn.

**Training + eval-gate:** unchanged from v2 - SB3 PPO, trained locally on the 5090 machine, every checkpoint evaluated against fixed seeded benchmark scenarios before promotion, recorded in `models/manifest.json`, enforced by CI (§11).

---

## 8. Persistence & data model

One JSON file per session (`sessions/{session_id}.json`), written through a storage interface (local disk locally; Fly.io persistent volume in deployment - see §10). Schema, updated for pedestrians/EV:

```json
{
  "session_id": "uuid",
  "started_at": "iso8601",
  "map_id": "grid_4x4_v1",
  "scenario": "rush_hour",
  "participants": [{ "client_id": "uuid", "car_id": "car_12" }],
  "events": [
    {
      "t": 12.4,
      "type": "phase_change",
      "intersection": "int_2",
      "phase": "NS_through",
      "controller": "rl"
    },
    {
      "t": 30.0,
      "type": "ev_spawn",
      "ev_id": "amb_1",
      "route": ["int_1", "int_2", "int_5"]
    },
    { "t": 34.5, "type": "ev_preempt", "intersection": "int_2", "eta_s": 8.2 },
    {
      "t": 45.1,
      "type": "collision",
      "entities": ["car_3", "car_12"],
      "kind": "vehicle_vehicle"
    },
    {
      "t": 52.0,
      "type": "collision",
      "entities": ["car_7", "ped_44"],
      "kind": "vehicle_pedestrian",
      "cause": "jaywalk"
    },
    { "t": 90.0, "type": "user_join", "client_id": "...", "car_id": "car_12" }
  ],
  "kpi_snapshots": [
    {
      "t": 60,
      "avg_vehicle_wait_s": 14.2,
      "avg_ped_wait_s": 9.1,
      "throughput": 38,
      "jaywalk_events": 2
    }
  ],
  "final_score": {
    "scenario": "rush_hour",
    "result": "pass",
    "avg_wait_delta_pct": 8.3
  }
}
```

**Fly.io persistence:** unlike most free-tier PaaS options, Fly.io supports attaching a small persistent volume to an app - this is why it was locked in. Session JSON writes go to that volume in deployment; the storage interface means the code path is identical to local disk, just a different mount point.

---

## 9. Frontend & input

- **Phaser 3 + TypeScript**, sharing generated types with `/shared-contracts`.
- **Input:** keyboard (arrow/WASD → throttle/brake/steer) and touch (on-screen virtual joystick or button pair for throttle/brake + drag/tilt for steering) - both map to the same server-side input message shape, so the sim server doesn't know or care which input method sent it.
- **In-app KPI panel** (replacing Grafana): a lightweight HUD component - avg wait time, throughput, pedestrian wait, jaywalk count, current AI mode (classical/RL) - pulled from the same metrics the AI service tracks, pushed over the existing WebSocket rather than standing up a separate observability stack. Lower ops overhead, same demo value for this project's scale.
- **Art pipeline:** AI-generated sprite sheets (cars, pedestrians, road tiles, EV) via an image-gen tool, cleaned up in a pixel-art editor (e.g. Aseprite) and packed into a texture atlas for Phaser. This is a one-time asset-production pass, not a runtime dependency - no image-gen API calls happen at runtime.

---

## 10. Deployment

- **Local dev:** `docker-compose up` - sim server, AI service, frontend dev server.
- **Deployed:** Fly.io, two small services (sim server, AI service) under one Fly org, sim server with an attached persistent volume for session JSON. Frontend can be static-hosted (Fly static app, or even bundled and served by the sim server itself to keep it to two deployed services instead of three).
- **Repo:** private, monorepo, access shared selectively (e.g. read access for a recruiter/interviewer link, not fully public).
- **Secrets:** Fly.io deploy tokens and any API keys live in GitHub Actions secrets, never committed - standard practice, but worth stating explicitly since this is now a private repo you might grant selective access to.

---

## 11. Testing strategy (full pyramid, expanded for pedestrians + EV)

| Layer                     | What                                                                                                                                                                    | Tooling                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Unit                      | IDM math, pedestrian steering/jaywalk-probability model, EV A\* routing, reward function, safety-wrapper + EV-override rule logic                                       | `vitest` (TS), `pytest` (Python)                  |
| Integration               | Sim server ↔ AI service contract (incl. EV-context field), WS message schema validation (incl. touch input messages), room join/leave/car-handoff                       | `vitest` + docker-composed AI service in CI       |
| Physics/determinism       | Given identical seed/inputs, same collision outcomes run-to-run - now covering both vehicle-vehicle and vehicle-pedestrian collisions                                   | Custom harness diffing event logs                 |
| Load                      | Headless bot swarm - now sized to include pedestrian agent counts, since crowding is the more expensive addition to the Matter.js tick                                  | `k6` or custom Node load script                   |
| RL regression (eval gate) | New checkpoint vs. deployed, on fixed benchmark scenarios, now scored on the full multi-objective reward components, not just wait time                                 | Python eval script reading `models/manifest.json` |
| E2E / smoke               | Join room, claim car (test both keyboard and a simulated touch event), drive, trigger an EV scenario, verify preemption fires and releases, verify session JSON written | `Playwright`                                      |

---

## 12. CI/CD (unchanged pipeline shape, restated with monorepo + private-repo notes)

```
1. lint            → eslint (TS), ruff (Python), across all monorepo packages
2. unit tests       → vitest, pytest, only for packages touched (path-based filtering)
3. integration tests → docker-compose up (sim server + AI service) → run suite → tear down
4. load test (short) → k6 smoke-level, threshold check
5. RL regression gate → runs only if models/manifest.json changed
6. build            → Docker images for sim-server and ai-service
7. deploy           → on merge to main, deploy to Fly.io (manual approval gate recommended
                        even on free tier, to avoid wiping the session volume mid-demo)
```

Secrets (Fly.io token, any image-gen API key used only in the offline asset-production step, never at runtime) stored in GitHub Actions repo secrets.

---

## 13. Scoring / challenge scenarios (expanded)

- **Rush hour:** elevated vehicle + pedestrian arrival rate; pass if AI holds avg wait under threshold.
- **Emergency vehicle:** ambulance spawns with a real destination; pass if preemption fires correctly along its actual route and its transit time stays under threshold.
- **Chaos:** user is scored on how much they _increase_ avg wait and jaywalk-adjacent risk by driving disruptively - this is the concrete, scoreable version of "test the traffic yourself."
- **Pedestrian pressure (new, given full pedestrian agents):** high pedestrian volume scenario; pass if the AI keeps pedestrian wait time (and therefore jaywalk rate) under threshold without starving vehicle throughput - this is the scenario that actually exercises the multi-objective reward.

---

## 14. Build order (dependency-ordered, no calendar attached)

1. **Core loop:** Node+TS+Matter.js sim server, one hand-authored map, one user car (keyboard only first), fixed-time signal, no AI service yet. Prove the WS loop and physics.
2. **Signal AI v1 (rule-based) + safety wrapper:** actuated logic in the Python service; session JSON logging live from here on.
3. **Multiplayer + real collisions:** shared room, car claim/handoff, full Matter.js collision response, disconnect recovery.
4. **Touch input:** add virtual controls alongside keyboard.
5. **Pedestrian agent system:** waypoint graph, steering, jaywalking model, feed into RL observation space design (even before RL exists, so the interface is right).
6. **RL:** Gym env (now including pedestrian state), PPO training on the 5090 box, ONNX export, eval gate, classical/RL toggle in UI.
7. **Emergency vehicle system:** routing, ETA calc, override layer, release logic.
8. **Testing + CI/CD hardening:** fill in the full pyramid from §11, wire the GH Actions pipeline from §12.
9. **Art pass:** AI-generated sprites, cleanup, atlas packing - swap in for placeholder shapes used through steps 1-8.
10. **Scoring + deploy:** all four challenge scenarios, in-app KPI panel, Fly.io deploy with persistent volume.

Placeholder shapes through most of the build (step 9 last) is deliberate - validating physics/AI/multiplayer logic against simple rectangles first means the eventual art pass is pure polish, not blocking core functionality.

---

## 15. Functional Requirements

| ID    | Requirement                                                                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | Render a 2D grid-based road network with at least one signal-controlled intersection, loaded from a hand-authored JSON map.                                                                                                               |
| FR-2  | Simulate AI-driven vehicles via IDM car-following with configurable per-scenario arrival rate.                                                                                                                                            |
| FR-3  | Simulate AI-driven pedestrians with waypoint pathfinding, crowding-aware steering, and a jaywalking-risk model tied to crossing wait time.                                                                                                |
| FR-4  | Any connected user may claim an unclaimed vehicle and drive it manually via keyboard or touch; control reverts to AI on disconnect within a bounded timeout.                                                                              |
| FR-5  | Support up to a configurable cap of concurrent human-controlled vehicles in a single shared room.                                                                                                                                         |
| FR-6  | Vehicle-vehicle and vehicle-pedestrian collisions produce physically consistent impulse-based responses with no clipping.                                                                                                                 |
| FR-7  | Traffic signals are controlled by an RL policy reacting to real-time vehicle and pedestrian queue/wait state.                                                                                                                             |
| FR-8  | A rule-based safety layer overrides any RL decision violating hard constraints (min/max green, forced pedestrian phase).                                                                                                                  |
| FR-9  | An emergency-vehicle priority layer computes a real route and ETA for spawned EVs and dynamically preempts signals along that path, superseding both RL and standard safety-wrapper decisions, releasing control back once the EV passes. |
| FR-10 | Support at least two selectable signal AI modes (classical/actuated vs. RL) for live comparison.                                                                                                                                          |
| FR-11 | Run at least four defined challenge scenarios (rush hour, emergency vehicle, chaos/disruption, pedestrian pressure) with explicit pass/fail scoring.                                                                                      |
| FR-12 | Record every session as a JSON file capturing all events (including collisions, EV preemption, jaywalking), KPI snapshots, and final score - no video.                                                                                    |
| FR-13 | Expose live traffic and pedestrian KPIs via an in-app panel (no external observability stack required).                                                                                                                                   |

## 16. Technical Requirements

| ID    | Requirement                                                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TR-1  | Simulation/physics authority runs server-side in Node.js + TypeScript using Matter.js; clients render interpolated state only.                                                                                                                            |
| TR-2  | Frontend built with Phaser 3 + TypeScript, WebSocket state broadcast ~15-20Hz, input messages ~30Hz, supporting both keyboard and touch input encoded identically server-side.                                                                            |
| TR-3  | Vehicle AI (IDM) and pedestrian AI (waypoint pathfinding + steering + jaywalk model) both run inside the Node sim server, sharing the same Matter.js physics world.                                                                                       |
| TR-4  | Traffic-signal AI runs as a separate Python/FastAPI service, called at a decision cadence of ~1-2 sim-seconds per intersection, receiving vehicle, pedestrian, and (when applicable) EV-ETA context.                                                      |
| TR-5  | Signal decisions pass through a three-tier hierarchy: RL policy (ONNX Runtime) → rule-based safety wrapper → EV priority override, in that priority order.                                                                                                |
| TR-6  | RL training uses a Gymnasium-compatible environment (including pedestrian state in the observation space) trained offline with Stable-Baselines3 PPO on local hardware.                                                                                   |
| TR-7  | Reward function is multi-objective: vehicle wait, cross-approach fairness (variance), pedestrian wait, jaywalk-event count, throughput - weights tuned empirically, structure fixed as specified in §7.                                                   |
| TR-8  | Every trained checkpoint is evaluated against a fixed, seeded benchmark scenario set before promotion; results recorded in a versioned `models/manifest.json`.                                                                                            |
| TR-9  | Emergency-vehicle routing uses A\* over the road graph in the Node sim server; ETA to each upcoming intersection is recomputed continuously and passed to the AI service's override layer.                                                                |
| TR-10 | Session data persists as one JSON file per session through a storage interface abstraction - local disk in dev, Fly.io persistent volume in deployment.                                                                                                   |
| TR-11 | Test suite covers unit, integration, physics/pedestrian-collision determinism, load (sized to include pedestrian agent counts), RL regression (eval-gate), and E2E (Playwright, covering both input methods and the EV scenario).                         |
| TR-12 | CI runs the full suite on every push via GitHub Actions; RL regression gate blocks promotion of any checkpoint regressing past a defined threshold on any reward component.                                                                               |
| TR-13 | Services are containerized independently and orchestrated via Docker Compose locally; deployed to Fly.io (sim server + AI service, sim server with an attached persistent volume).                                                                        |
| TR-14 | Repo is a private monorepo (`sim-server/`, `ai-service/`, `frontend/`, `shared-contracts/`, `models/`, `maps/`, `infra/`); shared message/RPC contracts defined once and used to generate both TypeScript and Python types, with CI checks against drift. |
| TR-15 | Visual assets are AI-generated sprite sheets, cleaned up and packed into a Phaser texture atlas as a one-time offline production step - no image-gen calls at runtime.                                                                                    |

---
