# City Network Stage 3: City Map Content + Capacity Tuning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author the real ~9-intersection organic city map (`maps/city_v1.json`) via a generation
script, validate it against the Stage 1/2 engine with the same empirical probe-script discipline
used all session, and retune arrival rates so the network's steady-state population stays bounded.
`grid_1x1_v1.json` remains untouched and is NOT switched as the runtime default yet — that switch
is Stage 4's job (spec §13), once the frontend can actually render multiple signals/curved roads.

**Architecture:** A hand-designed topology (9 intersections, 10 connecting roads, 9 terminal
spurs — chosen and distance-validated below, not left to the generator to invent) is fed into a
Node script that computes every approach's exact coordinates, the pedestrian sidewalk/crosswalk
graph, and emits `maps/city_v1.json`. Two genuinely new engine-adjacent fixes surface during
validation and are folded into this stage: `SimSession`'s pedestrian far-node list is still
hardcoded to the literal `far_N/S/E/W` (Stage 2 only patched it to not crash on an empty list,
never generalized the naming), and the pedestrian graph needs real cross-intersection sidewalk
connectivity (not present in any prior map) for pedestrian spawns to resolve without throwing.

**Tech Stack:** Node.js (`maps/scripts/generateCityMap.mjs`), TypeScript (one small `SimSession.ts`
generalization).

**Spec:** `docs/superpowers/specs/2026-08-17-city-traffic-network-design.md` — this plan implements
§9 (content) and §10 (capacity retuning).

## Global Constraints

- `grid_1x1_v1.json` and `fixture_curved_3int.json` are untouched.
- `server.ts`'s and the frontend's default map path stay pointed at `grid_1x1_v1.json` — Stage 4
  flips the runtime default once multi-signal/curved-tile rendering exists.
- Road width stays 40 (matches all previously-tuned physics constants — spec §9's explicit
  constraint).
- Never run `git commit` or `git add`.

## Topology (already distance-validated — do not redesign, just implement)

9 intersections, coordinates chosen and checked via a throwaway probe script (all inter-
intersection block lengths land in 326-397 units, well inside the spec's 200-400 target; no two
intersections closer than 180 units):

| id | x | y | kind |
|---|---|---|---|
| I1 | 0 | 0 | 4-way |
| I2 | 320 | -60 | 4-way |
| I3 | 260 | 300 | 3-way (+1 terminal) |
| I4 | -280 | 210 | 3-way (+2 terminals) |
| I5 | 620 | 170 | 3-way (+1 terminal) |
| I6 | 600 | -260 | 3-way (pure — no terminal, already degree 3 from the network) |
| I7 | -300 | -240 | 3-way (+2 terminals) |
| I8 | 930 | -40 | 3-way (+1 terminal) |
| I9 | 260 | -360 | 3-way (+2 terminals) |

10 inter-intersection roads (each becomes a pair of opposite-direction approaches, per Stage 2's
connector convention):

| from | to | style |
|---|---|---|
| I1 | I2 | straight |
| I1 | I3 | straight |
| I1 | I4 | straight |
| I1 | I7 | straight |
| I2 | I3 | straight |
| I2 | I5 | **curved** |
| I2 | I6 | straight |
| I5 | I8 | straight (diagonal angle — no waypoints needed, the organic coordinates already make this cut across at ~-34°, not axis-aligned) |
| I6 | I8 | straight |
| I6 | I9 | **curved** |

9 terminal spurs (far spawn/despawn points, ~250-300 units out from their intersection, angled
away from the existing roads at that intersection so they don't overlap): 1 each at I3, I5, I8; 2
each at I4, I7, I9. This satisfies spec §9's "6-10 terminal nodes" (9) and gives every 3-way
intersection either 1 spur (making it a true 3-way with 2 network roads) or 2 spurs (a 3-way with 1
network road) — I6 is the only exception, naturally 3-way from network roads alone with no spur
needed.

Total approaches: 10 roads × 2 directions + 9 terminal spurs = 29.

---

### Task 1: Fix the pedestrian far-node hardcode (blocking bug, found via direct testing)

**Files:**
- Modify: `sim-server/src/room/SimSession.ts`

**Why this is in Stage 3, not a pre-existing Stage 2 gap:** Stage 2 only patched this hardcode to
filter against what the map declares (so it degrades to zero pedestrians instead of crashing on an
empty pedestrian graph — `fixture_curved_3int.json`'s case). `city_v1.json` will have a real,
non-empty pedestrian graph whose far-node IDs won't literally be `far_N/S/E/W` — so this task
finishes the generalization Stage 2 only partially applied.

- [ ] **Step 1: Replace the exact-4-name filter with a naming-convention check**

In `SimSession.ts`, replace:
```ts
const pedestrianFarNodeIds = ["far_N", "far_S", "far_E", "far_W"].filter((id) => map.pedestrianNodes.some((n) => n.id === id));
```
with:
```ts
// "far_" prefix is the map-authoring convention for pedestrian terminal spawn/despawn points
// (grid_1x1_v1.json's far_N/S/E/W already follow it) — any map that follows the same convention
// gets real pedestrian spawning; a map with no pedestrian graph yet (fixture_curved_3int.json)
// still safely yields an empty list instead of crashing.
const pedestrianFarNodeIds = map.pedestrianNodes.filter((n) => n.id.startsWith("far_")).map((n) => n.id);
```

- [ ] **Step 2: Run the full sim-server test suite**

Run: `cd sim-server && npx vitest run`
Expected: PASS, unchanged count — `grid_1x1_v1.json`'s 4 nodes all still match (`far_N` etc. all
start with `"far_"`), `fixture_curved_3int.json`'s empty pedestrian graph still yields `[]`.

---

### Task 2: Write `maps/scripts/generateCityMap.mjs`

**Files:**
- Create: `maps/scripts/generateCityMap.mjs`
- Create (generated, committed as a normal file — not gitignored, matching how `fixture_curved_3int.json` is checked in directly rather than regenerated on every run): `maps/city_v1.json`

**Algorithm:**

1. **Intersections**: hardcode the 9-row table above as a JS object.

2. **Inter-intersection approaches**: for each of the 10 roads, compute both directions'
   `ApproachDef`s: `laneStartX/Y` = the "from" intersection's coordinates, `laneEndX/Y` = the "to"
   intersection's coordinates, `width: 40`, `id` following the `<toIntersectionLower>_from_<fromIntersectionLower>`
   convention already established in `fixture_curved_3int.json` (e.g. `i2_from_i1`). For curved
   roads (I2-I5, I6-I9), add a 3-point `waypoints` array: `[start, midpointOffsetPerpendicular, end]`
   where the midpoint is offset perpendicular to the straight chord by roughly 15% of the chord
   length (enough to read as a genuine curve without the overshoot Stage 1 already found and fixed
   — reuse `chainedWaypointSegment`'s existing Catmull-Rom construction as-is, this script only
   needs to supply waypoints, not curve math) — for the REVERSE direction's approach, waypoints are
   the exact same 3 points in reverse order (mirrors `fixture_curved_3int.json`'s
   `b_from_c`/`c_from_b` pattern, which Stage 1's symmetric Catmull-Rom fix specifically guarantees
   produces the identical physical curve either direction).

3. **Terminal spurs**: for each terminal, compute a point ~270 units from its intersection at an
   angle that doesn't collide with that intersection's existing roads (evenly space terminal
   angles into whatever angular gaps are left after the network roads, using the same
   angle-sorting approach as Step 4). `laneStartX/Y` = the far point, `laneEndX/Y` = the
   intersection's own coordinates, `width: 40`, no waypoints (straight spurs — organic curvature
   already comes from the 2 curved connectors).

4. **Signal phases (hand-authored, not scripted — spec §5.1/§9 both call this out as a judgment
   call)**: for each intersection, sort its own approaches by `headingIntoIntersection` angle and
   split into exactly 2 non-conflicting phases. For a 4-way (I1, I2): the natural split groups the
   two roughly-opposite pairs (compute via `isRoughlyOpposite` on the sorted headings — same
   function `TrafficController.ts` already imports from `TurnPaths.ts`, safe to reuse in this
   Node script since it's plain arithmetic with no browser/Node-only dependencies). For a 3-way:
   phase 1 is the single approach whose heading is most isolated (largest angular gap to its
   neighbors on both sides); phase 2 is the other two. Write this grouping logic into the script
   itself (not hand-typed per intersection) so it's derived consistently and re-runnable — but
   **inspect the actual output for each of the 9 intersections after generation** and hand-correct
   any grouping that looks operationally wrong (e.g. groups two approaches that don't actually
   share a safe simultaneous-green movement) before finalizing — this is the "not fully scriptable,
   requires judgment" part the spec calls out; automating the *mechanical* split and reviewing it
   is faster and less error-prone than hand-typing 9 raw JSON arrays, but the review step is not
   optional.

5. **Pedestrian graph** (per intersection, generalizing `grid_1x1_v1.json`'s corner/bend pattern to
   N-way and to real cross-intersection connectivity, which no existing map has needed before):
   - Sort the intersection's own approaches by heading. There are as many angular "gaps" between
     consecutive (wrapping) approaches as there are approaches — place one **corner node** per gap,
     at the bisector angle, radius 30 from the intersection center, id
     `corner_<intersectionId>_<gapIndex>`.
   - For each approach, add one **crosswalk edge** connecting its two flanking corners (the gap
     before it and the gap after it in sorted order), tagged with that approach's own `approachId`
     and a new `crossingId` (`cross_<approachId>`) — this is what
     `PedestrianController`/`SignalController` actually consume; get this part exactly right.
   - Add **ring sidewalk edges** connecting each corner to the next (cyclically) — lets a
     pedestrian reposition around the intersection between crossings without an extra detour
     through the graph's cross-intersection edges.
   - For each **terminal** approach, add a new pedestrian far node `far_<approachId>` near (but not
     exactly at) that approach's own far point, and one sidewalk edge from the nearer flanking
     corner out to it. (`far_` prefix — required by Task 1's fix.)
   - For each **connector** approach, add one sidewalk edge directly from this intersection's
     nearer flanking corner to the corresponding corner at the OTHER end of that same road (the
     sibling approach's own flanking corner in the other intersection's ring) — this is what makes
     the whole city's pedestrian graph one connected component instead of 9 isolated islands (a
     real, blocking correctness requirement: `PedestrianController.pickDestination` picks any other
     far node at random, and `PedestrianGraph.shortestPath` throws on an unreachable pair — verify
     this by construction, don't assume, and check it explicitly in Task 3). Build both directions'
     approaches' corners together in one pass per road (not by post-hoc geometric matching) so this
     pairing is exact, not approximate.
   - This is a deliberate scope decision: pedestrian sidewalks run parallel to roads and around
     intersections, but there's no fully independent city-wide sidewalk mesh beyond what's needed
     for connectivity and crossing behavior — sufficient for every current spec requirement
     ("crosswalk at every intersection", jaywalking, queue/wait KPIs), not a general pedestrian-
     simulation upgrade.

- [ ] **Step 1: Write the script** implementing points 1-5 above, writing the result to
  `maps/city_v1.json` via `writeFileSync(..., JSON.stringify(map, null, 2))`.

- [ ] **Step 2: Run it**

Run: `node maps/scripts/generateCityMap.mjs`
Expected: `maps/city_v1.json` is created/overwritten. Run it a second time and diff — it should be
byte-identical (no timestamps or nondeterministic ordering), matching this session's established
idempotent-generator-script discipline.

---

### Task 3: Validate the generated map loads and routes correctly

**Files:**
- Test: `sim-server/test/maps/cityV1.test.ts`

- [ ] **Step 1: Write and run a structural validation test**

Create `sim-server/test/maps/cityV1.test.ts` covering:
- `loadMap("../../maps/city_v1.json")` doesn't throw.
- Every intersection has exactly 2 phases (spec §5.1's hard constraint) whose `allowedApproachIds`
  partition that intersection's own approaches with no overlap and no omission.
- `buildRoadGraph` + `shortestPath` successfully routes between every pair of the 9 terminal
  approaches' `end_<id>` nodes (a full 9×8 all-pairs check, or at minimum several pairs spanning
  the network's diameter, e.g. a far corner of I4 to a far corner of I9) — this is the concrete
  proof that Task 2's Step 5 pedestrian-adjacent... no, this specifically proves the **vehicle**
  road graph is fully connected; add a second loop using `PedestrianGraph.shortestPath` over
  `map.pedestrianNodes`/`pedestrianEdges` between every pair of `far_`-prefixed node IDs, proving
  the pedestrian graph (Task 2 Step 5's real point) is connected too — this is the test that would
  have caught a disconnected pedestrian graph before ever running a live probe.

Run: `cd sim-server && npx vitest run test/maps/cityV1.test.ts`
Expected: PASS. If any route throws "No route from X to Y", the topology table or the generator's
edge-construction has a real gap — trace it via the failing pair's IDs against the topology table
above, don't just retry.

- [ ] **Step 2: Empirical turn-radius and wall-clearance probe (throwaway script, delete after)**

Write `sim-server/_city_geometry_probe.mts`: for every intersection, for every ordered pair of its
own approaches (entry, exit), call `buildMultiHopVehiclePath` for that single hop and check (a) the
resulting turn doesn't produce a degenerate/negative-length segment, (b) sampling the path at
regular intervals never produces a point wildly outside a generous bounding box around the two
approaches' own coordinates (catches a runaway curve like Stage 1's Task 6 bug). Run it, fix any
flagged intersection by adjusting that specific terminal-spur angle or curve waypoint in the
generator script (Step 1) and regenerating — not by special-casing the fixed JSON — then delete the
probe script once every intersection passes clean.

- [ ] **Step 3: Run the full suite**

Run: `cd sim-server && npx vitest run`
Expected: PASS, all prior counts preserved plus this task's new test.

---

### Task 4: Capacity probe and retuning

**Files:**
- None committed — throwaway probe script per this session's established methodology.

- [ ] **Step 1: Long-duration population/wait probe**

Write `sim-server/_city_capacity_probe.mts`: construct a `SimSession` against `city_v1.json` (mock
`fetch` to always return a plausible rule-based-shaped response, matching
`test/room/SimSession.test.ts`'s pattern), run it for a long simulated duration (e.g. 30-40
simulated minutes worth of ticks) at the **default** arrival rate first, then again at
`SCENARIO_CONFIGS.rush_hour`'s rate, logging vehicle count and average approach wait every
simulated minute. A healthy run shows both metrics leveling off (bounded oscillation around a
steady state), not monotonically climbing for the whole run.

- [ ] **Step 2: Retune if needed**

If either rate shows unbounded growth: per spec §10, the fix is retuning
`sim-server/src/scoring/scenarios.ts`'s rate constants (or `server.ts`'s default
`ARRIVAL_RATE_PER_MIN` fallback) — re-run Step 1 after each adjustment until both rates stabilize.
Do not touch `MAX_VEHICLES_PER_APPROACH`/`MAX_TRACKED_PEDESTRIANS` (the hard population caps) to
paper over this — those exist to bound worst-case cost, not to be the actual capacity-management
mechanism; a rate that only stays bounded because the hard cap is silently dropping arrivals is not
actually validated as healthy.

- [ ] **Step 3: Decision-interval/phase-timing sanity check**

While Step 1's probe is running, additionally log how often each intersection's `SignalController`
actually changes phase per simulated minute. Per spec §10, watch for pathological rapid
flip-flopping now that `neighborIntersections` coordination (Stage 2) is live on a real
multi-intersection map for the first time — if any intersection changes phase far more often than
its neighbors (e.g. every single decision interval), the neighbor-boost interacting with a tight
local queue could be thrashing; if seen, note it as a follow-up (a minimum-green floor, per spec)
rather than guessing a fix blind — this is explicitly conditional in the spec ("added if the probe
scripts show this happening, not preemptively").

- [ ] **Step 4: Delete the probe scripts, record findings as code comments if any constants changed**

If Step 2 changed any rate constant, leave a comment at that constant citing this probe's finding
(numbers actually observed), matching every other empirically-tuned constant this session. Delete
`_city_capacity_probe.mts` and `_city_geometry_probe.mts`.

---

## Definition of Done

- [ ] `maps/city_v1.json` exists, generated by `maps/scripts/generateCityMap.mjs`, re-running the
  script produces a byte-identical file.
- [ ] 9 intersections, each with exactly 2 phases; 10 inter-intersection roads (2 curved); 9
  terminal spurs; a fully connected vehicle road graph and a fully connected pedestrian graph.
- [ ] `grid_1x1_v1.json` remains the default map in `server.ts` and the frontend — not switched
  yet.
- [ ] Default and `rush_hour` arrival rates produce a bounded (not unboundedly growing)
  steady-state vehicle/pedestrian population on `city_v1.json`, validated empirically.
- [ ] `SimSession`'s pedestrian far-node detection works by naming convention, not a hardcoded
  4-item list.
- [ ] `npx tsc --noEmit` and the full `npx vitest run` suite are clean.
