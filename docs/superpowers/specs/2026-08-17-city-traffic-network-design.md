# City Traffic Network — Design Spec

**Status:** Draft, awaiting user review before an implementation plan is written.
**Author context:** Written after a session that fixed the core vehicle/pedestrian physics
(force→kinematic motion, unit bugs, turn geometry) on the existing single-intersection map. That
work is done and stable. This spec is the next, much larger step: replacing the single
plus-sign intersection with a real, organic, multi-intersection city, with per-intersection
traffic signals, multi-hop routing, EV green-wave preemption, coordinated multi-agent AI signal
control, and a proper legend/camera in the frontend.

## 1. Context

The current running app has exactly one intersection (`maps/grid_1x1_v1.json`): 4 straight
approaches meeting at a single point, one signal indicator for the whole map, and a default
arrival rate that mathematically oversaturates that one intersection (a single lane can discharge
roughly 1 vehicle every 3.5-4s even at full green; the default arrival rate demands roughly 6x
that). The user's report — "all lanes full, cars frozen at center, no real traffic system" — is
the direct, expected consequence of that math, not a separate bug. Building a real multi-
intersection network is *part of* the fix (the same total demand spread across many more
lanes/intersections), not just a visual upgrade.

**What already generalizes** (confirmed by reading the code, not assumed):
- `MapDefinition`'s `intersections`/`approaches` are already arrays; `ApproachDef` already has an
  `intersectionId` foreign key.
- `PedestrianGraph` and `EvRouter`'s `RoadGraph` are already genuine N-node graphs with A*
  shortest-path, explicitly written with multi-intersection maps in mind.
- The WebSocket `state-snapshot` schema's `signals` field is already an array of
  `{intersectionId, phase, msRemainingMin, light}` — multi-signal broadcast was anticipated at the
  wire-protocol level even though only one element is ever emitted today.
- `frontend/src/scenes/MainScene.ts`'s `buildBackground` already loops over
  `map.intersections`/`map.approaches` generically.
- `VehiclePath` is built from composable `segments` (`straightSegment`/`bezierSegment` chained via
  `composePath`) — the turn-curve at an intersection is already a proven case of "a car follows a
  curved path smoothly," which is the same machinery a curved road needs, just applied along an
  entire road instead of only the last few meters into an intersection.

**What hardcodes exactly one intersection today** (the actual work):
- `SimSession` picks `map.intersections[0]` for a single `SignalController` instance, and
  hardcodes the literal string `"int_1"` in 6 places (EV preempt/logging, KPI).
- `SignalController`'s `APPROACH_DIRECTIONS` module constant hardcodes exactly
  `app_N/S/E/W` — one instance only knows about those four IDs.
- `TrafficController.pickExitApproachId`/`TurnPaths.buildVehiclePath` build a single-hop path
  through one shared center point; there is no multi-hop path composition yet, even though
  `RoadGraph` already computes multi-hop *routes* (sequences of graph edges) — it's validated but
  never turned into an actual drivable `VehiclePath`.
- `Direction` is a fixed `"N"|"S"|"E"|"W"` enum, baked into `TurnPaths.OPPOSITE` (compass-based
  "is this a straight-through crossing" lookup) and the AI service's request schema
  (`approachStates[].direction: enum`).
- `frontend/src/scenes/MainScene.ts` reads `snapshot.payload.signals[0]` only.
- The RL training pipeline (`ai-service/training/env.py`) models exactly one 4-approach,
  2-phase intersection with a fixed 19-float observation vector and `Discrete(2)` action space.

## 2. Goals

1. A real, organic, non-grid city network (~9 intersections) with a genuine mix of straight
   avenues and curving streets — reads as an actual city, not a repeated grid cell.
2. Every intersection has its own traffic signal, independently and correctly timed.
3. Vehicles, pedestrians, and the emergency vehicle route multi-hop across the whole network, not
   just through one shared point.
4. The default arrival rates keep the network's steady-state vehicle/pedestrian population
   healthy (bounded, not perpetually growing) at both the default and "rush hour" scenario rates —
   validated empirically, the same way every physics constant this session was tuned.
5. Emergency vehicle preemption is a "green wave": every intersection along the EV's route gets
   preempted in sequence, timed to its ETA, not just the intersection immediately ahead.
6. Signal control (both the rule-based fallback and the RL policy) is coordinated across
   neighboring intersections, not purely local per-intersection.
7. The frontend renders one signal indicator per intersection, curved roads, a real legend, and
   auto-fits its camera to the map's actual bounds (works for this city and any future map size).
8. All ~100 existing automated tests keep passing against the untouched single-intersection map
   (`grid_1x1_v1.json`), which remains the test fixture. The city map is the new default for
   actually playing the app locally.

## 3. Non-goals (explicitly out of scope for this spec)

- Multi-lane roads (each direction stays one lane, as today — capacity comes from having many
  intersections, not from widening any single one).
- A joint/centralized action space across all intersections at once (combinatorially explodes;
  see §7 for the tractable alternative actually being built).
- Any change to the physics/steering constants tuned earlier this session (`MAX_ACCEL_REAL`,
  `walkSpeed`, `TURN_CONTROL_FRACTION`, etc.) — the city reuses the same road width (40 units) and
  a similar block-length scale so none of that retuning needs to be redone.
- Player/car-claiming UX changes — `RoomManager`'s existing claim mechanism works unmodified
  regardless of map size.

## 4. Architecture overview

Five layers change, in this dependency order (each depends on the previous one landing first):

1. **Data model** — generalize `Direction`, add curved-road waypoints, make intersections N-way.
2. **Physics** — curved wall-chains, angle-based turn-curve control points.
3. **Routing** — multi-hop path composition for vehicles/pedestrians/EV; per-intersection stop
   lines along one route.
4. **Signals** — one `SignalController` per intersection; EV green-wave; coordinated AI (rule-based
   neighbor-awareness + a retrained multi-agent RL policy).
5. **Content + frontend** — the actual city map file, capacity retuning, multi-signal rendering,
   curved-road tiles, legend, camera auto-fit.

Layers 1-3 are validated against small hand-built test fixtures (2-4 intersections) before the
full ~9-intersection city is authored in layer 5 — the same "prove the mechanism on something
small before betting the whole map on it" discipline used earlier this session for turn geometry.

## 5. Data model changes

### 5.1 `Direction` → heading angle

Replace `Direction = "N"|"S"|"E"|"W"` with a numeric heading in radians (same convention
`VehicleBody.angle` already uses: 0 = facing +x). `ApproachDef.direction: Direction` becomes
`ApproachDef.headingIntoIntersection: number`. Every place that currently does compass-based
lookup switches to angle comparison:

- `TurnPaths.OPPOSITE` (compass table) → a function `isRoughlyOpposite(headingA, headingB)`
  returning true when the two headings differ by within a tolerance (e.g. ±30°) of exactly 180°.
  Used only to bias route selection (straight-ahead exits get picked more often than sharp turns),
  not for correctness.
- `SignalController.APPROACH_DIRECTIONS` (hardcoded 4-entry record) is deleted. Each
  `SignalController` instance is now constructed with its own intersection's approach list, taken
  directly from `map.approaches.filter(a => a.intersectionId === thisIntersection.id)` — no fixed
  compass keys anywhere.
- `SignalPhaseDef.allowedDirections: Direction[]` → `SignalPhaseDef.allowedApproachIds: string[]`.
  Phases now list approach IDs directly (removing a layer of indirection that only existed to
  support the old compass lookup). Each intersection's phases are authored by hand in the map
  JSON based on that intersection's actual geometry (which approaches physically conflict) — not
  derived automatically. This is deliberate: automatic conflict-detection for arbitrary-angle
  N-way intersections is a much harder geometry problem, and hand-authoring ~9 intersections'
  phase lists is a bounded, one-time cost.
- **Design constraint**: every intersection, regardless of how many roads meet there (3-way,
  4-way, 5-way), is authored with **exactly 2 phases**. This keeps the RL action space uniform
  (`Discrete(2)` everywhere, needed for one shared policy network — see §7.3) and matches how most
  real-world signalized intersections actually operate (a small number of non-conflicting movement
  groups, not one phase per leg).
- `shared-contracts/schemas/signal-decision.schema.json`: `approachStates[].direction` enum
  `["N","S","E","W"]` is dropped entirely. Confirmed by reading both consumers: `rule_based.py`'s
  `decide_phase` only reads `phaseCandidates`/`currentPhaseId` (never `approachStates` at all), and
  `build_observation_vector` indexes `approachStates` by `approachId` string against a fixed
  `OBS_APPROACH_ORDER` list, never by `direction`. The field is dead in both decision paths today,
  so removing it is a safe deletion, not a behavior change.

### 5.2 Curved roads (waypoints)

`ApproachDef` gains an optional `waypoints?: {x, y}[]` field. When present (length ≥ 3), the
approach's centerline is a smooth curve built by converting the waypoint sequence into chained
`bezierSegment`s (Catmull-Rom-style: each interior waypoint becomes a control point derived from
its neighbors, giving a continuous, non-kinked curve) via the *existing* `composePath` machinery —
when absent, behavior is byte-identical to today (a straight line from `laneStartX/Y` to
`laneEndX/Y`, which remain the first/last waypoint for backward compatibility). `grid_1x1_v1.json`
needs zero changes: it simply never sets `waypoints`, and generalized code produces the exact same
straight-line paths it does today. This is the regression-safety guarantee for the ~100 existing
tests.

### 5.3 Intersections as N-way nodes

`IntersectionDef` needs no shape change (already just `{id, x, y, phases}`) — "N-way" falls out
naturally once `SignalController` stops assuming exactly 4 approaches (§5.1) and
`pickExitApproachId`/turn-curve geometry stop assuming compass directions (§6.2).

## 6. Physics changes

### 6.1 Curved wall-chains

`PhysicsWorld`'s per-approach wall building currently creates exactly 2 rectangles (left/right
edge) spanning the full straight length. Generalized: sample the approach's centerline (straight
or curved) at a fixed step (reusing the same sampling density as `bezierSegment`'s existing
24-point curve sampling), and for each consecutive pair of sample points, place one short
straight-rectangle wall segment on each side, rotated to match that segment's local tangent
direction, offset perpendicular by `width/2`. This is a direct generalization of the "24-point
polyline" technique already proven correct for turn curves — applied along an entire road instead
of only the last few meters into an intersection.

**Named risk**: consecutive short wall segments meeting at slightly different angles can either
leave a gap (a vehicle could clip through) or overlap awkwardly (spurious collision at the joint).
This needs the same iterative, empirical probe-script validation this session already relied on
for the single-intersection wall/turn-geometry bugs (§10 test plan) — expect at least one round of
"found a gap/overlap, adjust the segment length or add a small overlap margin" during
implementation, not a first-try success.

### 6.2 N-way, angle-based turn-curve geometry

`TurnPaths.cornerPoint(dirA, dirB, halfWidth)` currently does compass-based arithmetic
(`xSign`/`ySign` from a fixed `N/S/E/W` table). Generalized: compute the control point as the
actual geometric intersection of the entry approach's tangent ray and the exit approach's
(reversed) tangent ray — the same construction already derived analytically earlier this session
(the ideal single-control-point location for a quadratic Bezier smoothly connecting two directed
lines is where their tangent lines cross). Apply the same `TURN_CONTROL_FRACTION`-style empirical
scaling already validated for the 90°, compass-aligned case, but verify it still produces sane
curves for non-90° angles (a T-junction's ~90°-ish turns and a shallow-angle diagonal-avenue
merge are geometrically different cases) — swept via probe script per representative intersection
in the final map, not assumed to generalize for free.

## 7. Routing changes

### 7.1 Multi-hop vehicle paths

Today: `TrafficController`/`EvRouter` call `buildVehiclePath(mapDef, entryApproachId,
exitApproachId)` once, producing one path through one intersection.

New: on spawn, a vehicle picks a random destination terminal node; `RoadGraph`'s existing A*
computes the sequence of intersections/edges to traverse (already implemented, just unused for
actual path construction today). The vehicle's full `VehiclePath` is built by concatenating, in
order: [spawn edge] + [turn curve at intersection 1] + [connector edge to intersection 2] + [turn
curve at intersection 2] + ... + [final edge to destination terminal] — this is a direct use of
`composePath(segments: Segment[], ...)`, which already accepts an arbitrary-length array; the only
new code is building a *longer* array by walking the graph route instead of hand-assembling
exactly 3 segments.

**Per-intersection stop lines**: `VehiclePath` currently exposes one `stopLineDistance`. For a
multi-hop path it exposes `stopLines: {distance: number, approachId: string}[]`, one entry per
intersection along the route, where `approachId` is specifically the approach the vehicle is
*on* as it reaches that stop line (not the intersection's ID) — this is deliberate: no new
lookup structure is needed at all, because `TrafficController.step()` already receives one
merged `Map<approachId, SignalLightState>` per tick covering every approach in the whole city
(§8.1's `SimSession`-built merge). "Find the next stop line ahead of my current
`distanceTraveled`, then read `approachSignalStates.get(thatStopLine.approachId)`" is a direct
lookup into the exact same map `TrafficController.step()` already takes as a parameter today — no
signature change, no new registry. This is the most delicate *logic* change even though it needs
no new data structure: a vehicle already past intersection 1's stop line must advance to checking
intersection 2's approach, not keep re-checking intersection 1's.

### 7.2 Pedestrian routing

No structural change needed — `PedestrianGraph.shortestPath` is already fully generic A* over
nodes/edges with no intersection-count assumption. The city map's pedestrian node/edge data simply
describes more crossings (one per intersection) instead of 4.

### 7.3 EV green-wave routing

Today: `EvRouter.spawn`/`step` calls `buildVehiclePath` for a single hop, and `SimSession` checks
`phaseId === requiredPhaseId` for exactly one hardcoded intersection (`"int_1"`) to log a single
preempt event.

New: `EvRouter` builds a full multi-hop path the same way regular vehicles now do (§7.1), and
exposes the ordered list of intersection IDs its route passes through, each with an ETA computed
from the EV's current position and speed (generalizing the existing single-intersection
`etaToIntersection`). `SimSession` walks this list every tick: for each upcoming intersection whose
ETA drops below a threshold (e.g. 8s — tunable, validated empirically against the EV's real speed
and each intersection's yellow+all-red clearance time so preemption reliably lands *before*
arrival), it directly forces that intersection's `SignalController` to the phase containing the
EV's required approach — a deterministic override, not something the AI/RL decision is expected to
"learn" to cooperate with. This is a deliberate design choice: real-world emergency preemption
is always a hard override that bypasses adaptive control, never a hope that the adaptive algorithm
reacts correctly on its own. `SignalController` gains a `forcePhase(phaseId)` method that works
like `requestPhase` but is called directly by `SimSession`'s EV-preempt loop rather than only from
the AI decision path. Once the EV passes an intersection, that intersection's forced-phase state
clears and normal adaptive control resumes immediately.

Every `"int_1"` literal in `SimSession.ts` (6 occurrences, all listed in §1) is replaced with the
specific intersection ID relevant to that call site (the EV's current/next intersection, looked up
dynamically) rather than a hardcoded constant.

## 8. Signal Controller generalization

### 8.1 One instance per intersection

`SimSession` constructs a `Map<string, SignalController>`, one entry per `map.intersections[i]`,
each parameterized by that intersection's own `phases` (from map data) and own approach-ID list
(derived, not hardcoded — §5.1). `SimSession.step()` loops over all instances, steps each, and
merges their individual `getApproachSignalStates()` outputs into one combined
`Map<approachId, SignalLightState>` — `TrafficController.step()`/`PedestrianController.step()`
already accept this exact generic map shape today and need **no signature change at all**, since
they were never intersection-scoped to begin with (confirmed by reading their current code).

### 8.2 Coordinated rule-based fallback

`ai-service/app/rule_based.py`'s `decide_phase` currently only looks at its own intersection's
`phaseCandidates`. Extended: `SignalDecisionRequest` gains a `neighborIntersections:
[{intersectionId, currentPhaseId, timeInPhaseMs, totalPressure}]` field (computed by `SimSession`
by looking up each intersection's immediate road-graph neighbors before calling
`AiSignalClient.decide()`). The rule-based logic is extended with a simple, explainable
coordination rule: if a neighboring intersection immediately upstream just turned green for a
direction that feeds directly into this intersection's approach, slightly boost this
intersection's readiness to switch to receive that flow (a basic, hand-written "green wave"
heuristic, independent of and simpler than the RL policy in §8.3 — this is the fallback path used
whenever `requestedController !== "rl"` or the RL service is unavailable, so it must work well on
its own, not just as scaffolding for the RL path).

### 8.3 Coordinated multi-agent RL (new training pipeline)

This is the largest single piece of new work in this spec. Current state (confirmed by reading the
code): `TrafficSignalEnv` is a pure-Python/NumPy Poisson-arrival queueing approximation (no
Matter.js/Node involved — this is why RL training is fast) modeling exactly one 4-approach,
2-phase intersection; 19-float observation, `Discrete(2)` action, trained via `stable_baselines3`
PPO, exported to ONNX with a fixed `(batch, 19) → (batch, 2)` graph, evaluated by
`eval_gate.py` against 5 fixed seeds with per-metric regression thresholds vs. the currently
promoted checkpoint.

**New environment — `CityTrafficEnv`**: a custom multi-agent extension of the same queueing
approximation, generalized to N interconnected intersections whose topology is loaded directly
from the real city map JSON (so training topology always exactly matches the runtime map — no
separate hand-maintained topology description that could drift). Vehicles departing intersection
A's green phase become part of intersection B's arrival stream when A and B are connected by a
road — this inter-intersection coupling (not present in the single-intersection env, which only
has exogenous Poisson arrivals) is the actual mechanism that makes coordination learnable.

A prerequisite generalization inside this same piece of work: `OBS_APPROACH_ORDER`
(`app/observation.py:3`) is currently a hardcoded literal list of exactly 4 approach-ID strings
(`app_N/S/E/W`), and `build_observation_vector` indexes into `approachStates`/`pedestrianCrossings`
by those literal names. An organic city's intersections each have their own uniquely-named
approaches (not reused compass IDs), so this becomes a per-call parameter — each intersection's
own approach-ID list, in a fixed canonical order *for that intersection* (e.g. sorted by ID),
passed in by whichever `SignalController` instance is requesting a decision — rather than one
global constant. This is a required part of §8.3, not an incidental detail: without it, the
observation builder cannot run against any intersection whose approaches aren't literally named
`app_N/S/E/W`.

**Observation** (per intersection, still fixed-width for a shared policy network): the existing
19-dim local vector, unchanged, plus a fixed-size neighbor-summary block covering up to
`MAX_NEIGHBORS = 4` neighboring intersections (padded with zeros for intersections with fewer),
each contributing `[currentPhaseOneHot(2), timeInPhaseS(1), totalQueuePressure(1)]` = 4 floats ×
4 neighbors = 16. **New total observation width: 35** (19 + 16). This is a breaking change to the
ONNX graph's input shape — the existing single-intersection promoted checkpoint cannot be reused
or incrementally fine-tuned into this shape; training starts fresh, and `models/manifest.json`
resets (documented explicitly as a deliberate reset, not an oversight, in the implementation plan).

**Action**: `Discrete(2)` per intersection, unchanged in size — this is exactly why §5.1's
"every intersection gets exactly 2 phases" constraint matters: it lets one shared policy network
architecture apply uniformly to every intersection regardless of its road count.

**Training approach**: parameter-sharing multi-agent PPO, implemented as a custom
`stable_baselines3`-compatible `VecEnv` subclass (SB3 explicitly supports custom `VecEnv`s — this
is not fighting the framework) where each of the N intersections is one "sub-environment slot,"
but all N slots share one coupled underlying city simulation (not N independent copies of separate
cities, which is what SB3's standard `make_vec_env` would give you and is the wrong tool here).
Each environment step advances the whole city's queueing simulation once and returns N
observations/actions/rewards — one per intersection — which PPO's standard rollout buffer treats
as N independent transitions of the same shared policy. This is a standard, well-established
multi-agent RL simplification (shared-parameter independent learning), not a novel research
contribution — chosen specifically because it stays implementable with the existing
`stable_baselines3` dependency rather than requiring a new multi-agent RL framework
(PettingZoo/RLlib) as a new dependency.

**Reward**: unchanged per-intersection formula (§ found in `app/reward.py`), computed locally for
each intersection from its own queue/wait/throughput/jaywalk metrics — coordination emerges from
the shared neighbor-state observation influencing the shared policy's learned behavior, not from a
hand-engineered joint reward (which would need careful shaping to avoid one intersection's agent
learning to sacrifice its own metrics for a neighbor's, a known multi-agent RL pitfall being
deliberately avoided here by keeping rewards local).

**Eval gate**: `eval_gate.py` runs the candidate against `CityTrafficEnv` (same 5 fixed seeds,
same regression-threshold logic), but now averages metrics across all N intersections. The
regression baseline resets when this ships (first city-topology checkpoint has no prior promoted
checkpoint to regress against — `eval_gate.py` already has to handle a from-scratch `promoted:
false` empty-manifest case, confirmed from reading it, so no new code path is needed there).

**Inference-time wiring**: `AiSignalClient`/`SignalController` (TypeScript side) computes and
includes each intersection's `neighborIntersections` block (§8.2) in every `/signal-decision`
request, whether the request is headed to the rule-based or RL path — `app/routes.py`'s existing
`build_observation_vector` call is extended to also consume this new field when
`requestedController === "rl"`.

## 9. Content: the actual city map

New file `maps/city_v1.json` (name chosen for clarity; not user-specified). Authored via a small
Node generation script (`maps/scripts/generateCityMap.mjs`, kept in the repo as a maintenance
tool, matching this session's established practice of computing derived geometry via scripts
rather than hand-typing coordinates and risking arithmetic mistakes) that:

- Places roughly 9 intersections in an organic, non-repeating layout — a mix of 4-way crossings
  forming a rough core, 1-2 3-way T-junctions at the edges, varied block lengths (not uniform
  grid spacing), and at least 2 genuinely curved connector roads plus one diagonal avenue cutting
  across at a non-90° angle, alongside straight avenues — a real mix, not "everything curves."
- Keeps the same road width (40 units) and a similar block-length scale (200-400 units between
  neighboring intersections) as the current map, so all previously-tuned physics/IDM/steering
  constants remain valid without re-calibration — only topology changes.
- Generates 6-10 terminal ("far") spawn/despawn nodes at the network's outer edges (up from 4
  today), so vehicles have real route variety.
- Generates the full pedestrian sidewalk/crosswalk node/edge graph to match, with a crosswalk at
  every intersection.
- Hand-authors each intersection's exactly-2-phase `SignalPhaseDef` list based on its specific
  geometry (§5.1) — this part is not fully scriptable (requires judgment about which approaches
  physically conflict at each specific intersection) and is done by hand, once, over ~9
  intersections.

## 10. Capacity & congestion retuning

With ~9 intersections, the same total city-wide arrival rate is distributed across many more
independent lanes/signals — this is expected to resolve most of the reported gridlock on its own,
but it is **validated, not assumed**: I will run the same kind of long-duration probe script used
throughout this session (default rate AND each `SCENARIO_CONFIGS` rate, especially `rush_hour`)
against the finished city map, confirming vehicle/pedestrian population and average wait stabilize
at a healthy level rather than growing unboundedly, before considering this done. If the default
rates (currently tuned for one intersection) are still oversaturated for the new topology, they
get retuned as part of this same work — this is empirical, not a guess.

Additionally, the rule-based/RL decision interval (currently 1.5s) and the phase machine's
yellow/all-red durations (3s/1.5s) are checked for pathological rapid flip-flopping once real
coordination logic is added (a neighbor-aware rule that's too eager to switch could thrash) — a
sensible minimum-green floor is added if the probe scripts show this happening, not preemptively.

## 11. Frontend changes

1. **Multi-signal rendering**: `MainScene` iterates the full `signals[]` array (already
   wire-protocol-ready — §1), rendering one signal-light sprite per intersection at that
   intersection's `map.intersections[i].x/y` (already loaded via the existing map-JSON fetch in
   `preload()`).
2. **Curved-road tile rendering**: `buildBackground`'s road-tiling generalizes from "walk a
   straight line, place square tiles" to "sample the (possibly curved) centerline at the same
   step used for background straight roads today, place a tile at each sample point, rotated to
   that point's local tangent direction" — a direct generalization of the existing loop, reusing
   the same `road_straight` tile art (a curve rendered as a sequence of individually-rotated
   straight tiles reads perfectly well at this scale; no new curved-specific art asset is needed).
3. **Legend UI**: a new fixed (`setScrollFactor(0)`) panel, styled consistently with the existing
   KPI panel, listing keyboard controls (↑/↓/←/→, E for EV, click-to-toggle AI mode, scroll wheel
   to zoom, R to reset zoom) and a color key (AI vehicle / EV / your car / pedestrian / signal
   light colors).
4. **Two zoom modes: auto-fit (default) + manual mouse-scroll**: compute the map's real bounding
   box from `map.intersections`, `map.approaches` (including curved waypoints), and pedestrian
   nodes (min/max x/y across all of them) once in `MainScene.create()`, then set
   `cameras.main.zoom`/`centerOn` from that bounding box and the canvas size — replacing today's
   hardcoded ±350-unit assumption with map-size-aware math that works correctly for this city, the
   old single-intersection map, and any future map. This auto-fit result becomes the **initial**
   zoom level, not the only one: a `wheel` event listener (`this.input.on("wheel", ...)`)
   incrementally adjusts `cameras.main.zoom` on scroll (in on scroll-up, out on scroll-down),
   clamped to a sensible range (a minimum that still shows at least a couple of intersections at
   once, and a maximum that still shows the whole map with margin — both computed from the same
   bounding box, not fixed magic numbers, so the range scales correctly for the old map too). The
   camera stays centered on the current view's midpoint as zoom changes (standard "zoom toward
   center," not toward the cursor, to keep this simple — zoom-to-cursor is a natural follow-up if
   it reads as needed once built, not required now). Pressing a dedicated reset key (`R`) restores
   the initial auto-fit zoom/center exactly — necessary so manually zooming in never strands the
   player without an easy way back to the full-map view.

## 12. Testing strategy

- `grid_1x1_v1.json` and all ~100 existing tests referencing it are untouched and must keep
  passing unmodified — the regression-safety contract for this entire spec.
- New unit tests: angle-based turn-curve geometry (non-90° cases), multi-hop path composition
  (correct per-intersection stop-line lookup as a vehicle advances past intersection 1 into
  intersection 2's territory), per-intersection `SignalController` instantiation (independent
  phase machines, verified not to interfere with each other), curved-road wall-chain collision
  (no gaps/no spurious overlaps, checked the same way the original single-intersection wall bug
  was found — by tracing a vehicle's real position through a full traversal), camera-auto-fit math
  (given a bounding box, produces a zoom/center that actually contains it, both for the old and
  new map).
- New Python tests: `CityTrafficEnv`'s inter-intersection coupling (a vehicle departing
  intersection A's green genuinely appears in B's arrival stream), the extended 35-dim observation
  builder (neighbor-block padding for intersections with fewer than 4 neighbors), the new
  `eval_gate.py` multi-intersection aggregation.
- Empirical probe scripts (this session's established methodology) for: capacity/congestion at
  the new scale (§10), turn-radius sanity on every non-90° intersection in the final map, and
  wall-clearance sanity along every curved road — each probe script's purpose documented and the
  script deleted once its finding is captured as a code comment or a permanent test, matching how
  every earlier physics investigation this session was cleaned up.
- End-to-end: the existing Playwright `driveAndEv.spec.ts` is extended to assert the EV's session
  log shows `ev_preempt` events at *multiple* distinct intersection IDs during one run (proving
  the green wave actually preempts more than one intersection, not just the first).
- Manual live review: I do not have a browser to look at the rendered result myself — your own
  visual confirmation that it reads as a real city remains the final acceptance check, the same
  way it has been for every visual change this session.

## 13. Rollout order (maps directly to implementation-plan phases)

1. **Engine** (§5, §6): `Direction`→heading generalization, curved-road waypoint model, curved
   wall-chain physics, angle-based turn-curve geometry. Validated against small hand-built test
   fixtures (2-4 intersections, at least one non-90° angle, at least one curved connector) — not
   yet the full city.
2. **Routing + signals** (§7, §8.1-8.2): multi-hop path composition for vehicles/pedestrians/EV,
   per-intersection `SignalController` instantiation, EV green-wave override mechanism, coordinated
   rule-based fallback. Validated against the same small fixture from stage 1.
3. **City map + capacity tuning** (§9, §10): author the full ~9-intersection organic map with
   curved/diagonal roads, retune arrival rates, validate congestion stays healthy.
4. **Frontend** (§11): multi-signal rendering, curved-road tiles, legend, camera auto-fit.
   Validated via Playwright e2e plus your visual review.
5. **Coordinated multi-agent RL** (§8.3): the new `CityTrafficEnv`, retrained policy, extended
   observation/ONNX pipeline, updated eval gate. Deliberately sequenced *last*: it depends on the
   city map's final topology (stage 3) for its training topology, and it is the highest-risk,
   most novel piece — sequencing it last means stages 1-4 (all of which are directly visible to
   you) aren't blocked waiting on it.

Each stage is its own implementation-plan phase with its own tests passing before the next stage
starts, the same discipline used for Phases 1-10 of the original build.

## 14. Risks, called out honestly rather than papered over

- **Curved wall-chains are the highest physics risk.** Getting the polyline segmentation right
  (no gaps, no spurious joint overlaps) will need iterative empirical probing, same as the
  single-intersection wall bug found earlier — expect at least one "found a gap, fixed it" round
  during implementation, not a first-try success.
- **The multi-agent RL piece (§8.3) is genuinely large** — comparable in scope to the original
  Phase 6 RL work, not a small extension of it. It is sequenced last specifically so it doesn't
  block the rest of this spec, which is independently valuable (a coordinated-but-not-yet-learned
  rule-based fallback, §8.2, ships in stage 2 and works on its own).
- **Hand-authoring each intersection's exactly-2-phase list** (§5.1, §9) doesn't scale
  automatically to a much larger map later — this is an accepted, bounded, one-time cost for ~9
  intersections, not a general solution; a future larger map would need either more manual
  authoring or a real conflict-detection algorithm (out of scope here).
- **Visual legibility at the auto-fit zoom level**: a ~9-intersection city spans roughly 3-4x the
  current map's extent, so the auto-fit camera will zoom out further and individual cars/
  pedestrians will render smaller on screen than today. This was an explicit, accepted trade-off
  when auto-fit-to-whole-map was chosen over a follow-camera; if it reads as too small once built,
  a follow-camera-plus-minimap mode (mentioned but not chosen earlier) is a contained follow-up,
  not a redesign.
- **This is a multi-stage, multi-session undertaking.** Five rollout stages, each substantial, are
  not going to land in one sitting. Progress will be reported stage by stage rather than
  disappearing for one giant change.
