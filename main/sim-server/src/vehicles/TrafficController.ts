import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld.js";
import { type MapDefinition, isTerminalApproach } from "../maps/MapDefinition.js";
import { VehicleBody } from "./VehicleBody.js";
import { idmAcceleration, type IdmParams, type IdmState } from "./IdmController.js";
import { TrafficSpawner } from "./TrafficSpawner.js";
import { buildMultiHopVehiclePath, headingIntoIntersection, headingOutOfIntersection, isRoughlyOpposite, type VehiclePath } from "./TurnPaths.js";
import { buildRoadGraph, type RoadGraph } from "../ev/RoadGraph.js";
import { realSpeed } from "../physics/realSpeed.js";
import { findObstacleAhead, type ObstaclePoint } from "./obstacleDetection.js";

// This many vehicles queued on ONE approach, at IDM's own equilibrium following gap
// (s0 + vehicleLength ≈ 38 units), simply doesn't fit the physical road geometry this sim
// actually has: roads are 40 wide, and opposite-direction traffic only gets ~12 units of lane
// separation (2x LANE_OFFSET — see TurnPaths.ts's own comment on why it can't be the full 18
// needed without risking wall clips). At 8 per approach across a busy multi-intersection network,
// vehicles spend most of their time in genuine, repeated physical contact with each other rather
// than smoothly following — found directly: with 8 as the cap, the stall-escape valve above was
// firing roughly once per vehicle every ~17 seconds and climbing, network-wide, not as an
// occasional recovery from a rare graze but as a near-constant crutch replacing normal traffic
// flow. Lower reduces how many vehicles compete for the same constrained road space at once.
// Dropped further, 5 -> 3, after empirically comparing sustained-load throughput on the real
// city map against the real ai-service (not a mock): at 5, average vehicle transit time over a
// 850s run was ~450-490s with completions still climbing but heavily congested; at 3, the same
// run completed more vehicles overall (36 vs ~30) at a lower average transit (~400s) and spent
// more time above near-zero average speed. Fewer vehicles in flight per approach means less of
// the single-lane road's limited physical space is spent on queued/braking traffic and more on
// actually moving — this is a real capacity property of this sim's road width and turn radii, not
// a bug fixable by better following/signal logic alone.
const MAX_VEHICLES_PER_APPROACH = 3;
const LOOKAHEAD_DISTANCE = 20;
// Shared between the stall-escape valve and the intersection-occupancy mutex (both below) — a
// vehicle counts as "genuinely, persistently stalled" once it's been below STALL_SPEED_THRESHOLD
// while in real physical contact with another vehicle for longer than STALL_ESCAPE_MS. The mutex
// needs this same threshold to recognize when an "occupant" it's treating as blocking traffic is
// itself frozen and should stop counting as a legitimate occupant (see occupiedByOther's own
// comment) — module-level so both sites reference one definition instead of two independent
// copies that could silently drift apart.
const STALL_SPEED_THRESHOLD = 0.5;
const STALL_ESCAPE_MS = 1500;
// A second, much slower safety net alongside STALL_ESCAPE_MS above. That one only catches a
// vehicle in genuine Matter.js physical contact — it has no way to help a vehicle that's simply
// never moving for a completely different reason with no contact involved at all. Found directly:
// running the real city map at real (not mocked) signal timing, a vehicle could sit at true zero
// speed for 600+ seconds — many multiples of any single phase's real max duration
// (MIN_GREEN_MS=4000/MAX_GREEN_MS=20000 + yellowMs=3000 + allRedMs=1500 ≈ 24.5s worst case for one
// phase) — with `vehiclesInPhysicalContact` never containing it (no contact pair existed) and its
// own signal genuinely green, the whole time. Root cause: the intersection-occupancy mutex
// (occupiedByOther, below) can manufacture an effective "red" for a vehicle whose own signal actually
// reads green, because it's waiting on ANOTHER vehicle currently sitting in the box — and if THAT
// occupant is also stuck (for the same reason, recursively, elsewhere in the network), no vehicle in
// the whole chain ever satisfies the physical-contact stall definition, so the existing valve never
// fires for any of them: a genuine soft deadlock with zero real collisions anywhere in it.
// NO_PROGRESS_ESCAPE_MS is deliberately well above the ~24.5s worst-case legitimate wait at a real
// red light (so it never interrupts an ordinary queue that's correctly waiting out its own light),
// but far below "forever" — once nothing has advanced this vehicle's real path position by more than
// PROGRESS_EPSILON for this long, something is genuinely wrong regardless of why, and it's rescued
// the same way a physical stall is. leaderIsHardStop below is what still keeps this from ever
// running an actual red/yellow light: it's now computed from the vehicle's OWN real signal state
// only, never inflated by occupiedByOther, so a vehicle genuinely stopped at its own red still never
// gets nudged no matter how long it's been stuck — only an artificially (mutex-)manufactured block
// is eligible.
const NO_PROGRESS_ESCAPE_MS = 35000;
const PROGRESS_EPSILON = 0.5;
// Narrower than a naive "crosswalk width" guess: at 45, a genuinely busy crosswalk (this sim's real
// scenario configs run pedestrian arrival rates of 20-70/min) can have some pedestrian somewhere in
// the scan window almost continuously, so the vehicle's IDM "leader" target keeps getting
// reassigned to whichever pedestrian is currently nearest before it ever gets a chance to actually
// close the gap and accelerate away — a permanent, self-perpetuating full stop, found directly:
// a vehicle mid-turn through a crosswalk sat at true zero speed for the rest of an entire run, with
// its "pedestrianAhead" distance never exceeding ~7 units even as the individual pedestrian ids
// touching it kept changing (a relay of foot traffic, not one stuck pedestrian). Shrinking the scan
// to roughly the vehicle's own stopping-relevant distance means only a pedestrian genuinely about
// to be in the vehicle's immediate path counts as blocking, not anyone still further down a busy
// crosswalk.
const PEDESTRIAN_OBSTACLE_SCAN_DISTANCE = 25;
// Roughly a vehicle's own half-width (9) plus a pedestrian's radius (6) plus a small buffer —
// only a pedestrian genuinely within the lane counts as blocking, not one merely standing
// nearby (see obstacleDetection.ts's own comment for the real regression this replaced: an
// angle-cone check widened far too much at any real distance).
const PEDESTRIAN_OBSTACLE_LATERAL_TOLERANCE = 15;
// How close behind (and how narrow an angle) an approaching EV must be before a regular vehicle
// starts yielding — real-world "pull over for the ambulance" behavior. Roads here are single-lane
// (spec's own explicit non-goal: no multi-lane physics), so a literal lane-change overtake isn't
// physically possible — the achievable equivalent is the car ahead accelerating harder to open a
// gap rather than cruising at its normal pace, matching how a driver on a single-lane road actually
// responds to a siren behind them (speed up to the next safe pull-off/intersection, don't dawdle).
const EV_YIELD_DISTANCE = 400;
const EV_YIELD_ANGLE_COS_THRESHOLD = 0.85;
// Same-approach leader detection (the `ahead` check below) only catches a vehicle sharing this
// car's own path — it's blind to cross-traffic converging inside the intersection box itself (e.g.
// a car turning N->E physically crossing paths with a car entering via app_E). Found directly: a
// vehicle stuck at a near-total standstill turned out to have an ongoing real Matter.js collision
// with another vehicle on a different approach, confirmed via engine.pairs.list, with neither
// vehicle's leader logic aware of the other since approachIdAt never matched. This lane-corridor
// scan (same technique as the pedestrian check) catches that regardless of approach.
const VEHICLE_OBSTACLE_SCAN_DISTANCE = 40;
const VEHICLE_OBSTACLE_LATERAL_TOLERANCE = 14;
// A new vehicle spawns at distanceTraveled=0 on its approach; if the closest existing vehicle on
// that approach hasn't yet cleared this much distance, its body still overlaps the spawn point.
// Matter's overlap-resolution then injects a large separating impulse into the older vehicle,
// producing an unrealistic "runaway" speed spike. Require physical clearance before spawning,
// matching how a real queue can't have two cars occupy the same point at once.
const SPAWN_CLEARANCE_DISTANCE = 40; // vehicle length (36) + a small safety margin

type SignalState = "green" | "yellow" | "red";

interface Tracked {
  body: VehicleBody;
  entryApproachId: string;
  exitApproachId: string;
  path: VehiclePath;
  distanceTraveled: number;
  stalledMs: number;
  // How long (ms) since distanceTraveled last advanced by more than PROGRESS_EPSILON — tracks
  // "genuinely not moving" independent of *why*, unlike stalledMs which only counts genuine
  // physical contact. See NO_PROGRESS_ESCAPE_MS's own comment for the deadlock this exists to break.
  noProgressMs: number;
  lastProgressDistance: number;
}

// Replaces the old compass-based OPPOSITE-table pickExitApproachId: picks a random TERMINAL
// destination (a connector approach's laneStart is mid-network, never a valid destination), biased
// toward continuing roughly straight through the entry intersection when a straight-ish terminal
// exists — the same qualitative "usually straight, sometimes turn" behavior as before, expressed
// generically via headings instead of a fixed N/S/E/W table.
function pickDestinationApproachId(entryApproachId: string, mapDef: MapDefinition, terminals: string[], rng: () => number): string {
  const entry = mapDef.approaches.find((a) => a.id === entryApproachId)!;
  const entryHeading = headingIntoIntersection(entry);
  const others = terminals.filter((id) => id !== entryApproachId);
  const straightCandidates = others.filter((id) => {
    const a = mapDef.approaches.find((x) => x.id === id)!;
    return isRoughlyOpposite(entryHeading, headingOutOfIntersection(a));
  });
  const pick = (pool: string[]) => pool[Math.floor(rng() * pool.length)];
  if (straightCandidates.length > 0 && rng() < 0.5) return pick(straightCandidates);
  return pick(others);
}

// True when `ev` is close behind `vehicle` and roughly aligned with its heading — i.e. bearing
// down on it from behind in the same lane, not just nearby on a crossing or opposite approach.
function evIsClosingFromBehind(vehicle: VehicleBody, ev: VehicleBody): boolean {
  const dx = vehicle.body.position.x - ev.body.position.x;
  const dy = vehicle.body.position.y - ev.body.position.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6 || distance > EV_YIELD_DISTANCE) return false;
  const evForwardX = Math.cos(ev.body.angle);
  const evForwardY = Math.sin(ev.body.angle);
  const forwardComponent = (dx * evForwardX + dy * evForwardY) / distance;
  return forwardComponent >= EV_YIELD_ANGLE_COS_THRESHOLD;
}

export class TrafficController {
  private readonly tracked = new Map<string, Tracked>();
  private spawner: TrafficSpawner;
  private spawnCounter = 0;
  private readonly graph: RoadGraph;
  private readonly terminals: string[];

  constructor(
    private readonly world: PhysicsWorld,
    private readonly mapDef: MapDefinition,
    private readonly idmParams: IdmParams,
    private readonly rng: () => number,
    arrivalRatePerMinPerApproach: number,
    private readonly onSpawn: (vehicle: VehicleBody) => void
  ) {
    this.graph = buildRoadGraph(mapDef);
    this.terminals = mapDef.approaches.filter((a) => isTerminalApproach(mapDef, a)).map((a) => a.id);
    this.spawner = new TrafficSpawner(this.terminals, rng, arrivalRatePerMinPerApproach);
  }

  setArrivalRate(ratePerMinPerApproach: number): void {
    this.spawner = new TrafficSpawner(this.terminals, this.rng, ratePerMinPerApproach);
  }

  step(
    dtMs: number,
    approachSignalStates: Map<string, SignalState>,
    activeEv: VehicleBody | null = null,
    pedestrians: ObstaclePoint[] = []
  ): void {
    for (const entryApproachId of this.spawner.step(dtMs)) {
      const onApproach = [...this.tracked.values()].filter((t) => t.entryApproachId === entryApproachId);
      if (onApproach.length >= MAX_VEHICLES_PER_APPROACH) continue;

      const closestDistance = onApproach.length > 0 ? Math.min(...onApproach.map((t) => t.distanceTraveled)) : Infinity;
      if (closestDistance < SPAWN_CLEARANCE_DISTANCE) continue;

      const destinationApproachId = pickDestinationApproachId(entryApproachId, this.mapDef, this.terminals, this.rng);
      const route = this.graph.shortestPath(`end_${entryApproachId}`, `end_${destinationApproachId}`);
      const approachIds = route.edges.map((e) => e.approachId);
      const path = buildMultiHopVehiclePath(this.mapDef, approachIds);
      const exitApproachId = approachIds[approachIds.length - 1];
      const entry = this.mapDef.approaches.find((a) => a.id === entryApproachId)!;
      const heading = Math.atan2(entry.laneEndY - entry.laneStartY, entry.laneEndX - entry.laneStartX);

      // Spawn at the path's own real starting point (path.pointAt(0)), not the approach's raw
      // laneStart — the path is now offset LANE_OFFSET to one side of the raw centerline (see
      // TurnPaths.ts's offsetSegment), so spawning at the unoffset coordinate placed a fresh
      // vehicle 10 units off its own path, forcing an immediate sideways correction right at spawn.
      const spawnPoint = path.pointAt(0);
      const id = `car_${entryApproachId}_${this.spawnCounter++}`;
      const vehicle = new VehicleBody(this.world, id, { x: spawnPoint.x, y: spawnPoint.y, heading });
      vehicle.controller = "idm";
      this.tracked.set(id, {
        body: vehicle,
        entryApproachId,
        exitApproachId,
        path,
        distanceTraveled: 0,
        stalledMs: 0,
        noProgressMs: 0,
        lastProgressDistance: 0
      });
      this.onSpawn(vehicle);
    }

    // Ground truth for the stall-escape check below: which vehicles are in an ACTUAL Matter.js
    // physical contact (a real collision pair) right now, not just "IDM computed a small gap." A
    // normal, correctly-settled queue (a stopped car behind another stopped car) rests at IDM's
    // own equilibrium gap (s0, ~2 units) with NO body overlap at all, since real vehicle length is
    // already subtracted out of that gap — it's a legitimate, resolvable wait for a green light
    // ahead. Only genuine touching/overlapping bodies show up here, which is what actually
    // distinguishes an unresolvable physical wedge from an everyday traffic queue.
    const vehiclesInPhysicalContact = new Set<string>();
    for (const pair of this.world.engine.pairs.list) {
      if (!pair.isActive) continue;
      const aIsVehicle = pair.bodyA.label.startsWith("vehicle_");
      const bIsVehicle = pair.bodyB.label.startsWith("vehicle_");
      if (aIsVehicle && bIsVehicle) {
        vehiclesInPhysicalContact.add(pair.bodyA.label.slice("vehicle_".length));
        vehiclesInPhysicalContact.add(pair.bodyB.label.slice("vehicle_".length));
      }
    }

    for (const [id, entry] of [...this.tracked.entries()]) {
      if (entry.body.controller !== "idm") continue;

      // Closed-loop progress: always derived from the vehicle's real physics position, never
      // accumulated from speed*dt (see TurnPaths.closestProgress for why that drifted). The
      // previous tick's value is passed as a hint so the search stays local (see closestProgress).
      entry.distanceTraveled = entry.path.closestProgress(
        { x: entry.body.body.position.x, y: entry.body.body.position.y },
        entry.distanceTraveled
      );

      const speed = realSpeed(entry.body.body);

      // "Same physical lane right now" generalizes the old two-case entry/exit-approach
      // comparison to an arbitrary-length multi-hop route: whichever approach a vehicle's current
      // distance falls on (see TurnPaths.approachIdAt) is the physical lane it currently occupies,
      // and only another vehicle sharing that same current lane is a real obstacle.
      //
      // approachIdAt alone isn't enough, though: a terminal approach is used both as an *entry*
      // (hop 0, driven forward) by one vehicle and as an *exit* (the last hop, driven in reverse —
      // see TurnPaths.buildMultiHopVehiclePath) by a different vehicle finishing its own route.
      // Both report the same approachIdAt string while physically driving in opposite directions,
      // and their `distanceTraveled` values live on two entirely unrelated paths' coordinate
      // systems — comparing them directly can misidentify the exiting vehicle as a "leader" ahead
      // of the entering one, capping its speed against a phantom constraint that isn't a real
      // obstacle at all. Found by tracing a car that crawled at a near-constant low speed far from
      // any real leader or stop line, with a car exiting via that exact same terminal nearby.
      // Requiring roughly-aligned real headings (not just a shared approach id) rules this out.
      const myCurrentApproach = entry.path.approachIdAt(entry.distanceTraveled);
      const myHeading = entry.body.body.angle;
      // Candidate leader's gap is computed from real Matter.js positions (a physical forward
      // projection along my own heading), never from comparing the two vehicles' own
      // `distanceTraveled` values directly. Those are cumulative path-length totals private to
      // each vehicle's own (possibly multi-hop) route — two different routes that happen to share
      // this approach as a hop can reach it after entirely different amounts of prior distance, so
      // one vehicle's raw distanceTraveled is not comparable to another's even when both report
      // the same current approach. Found directly: a vehicle several hops into a long route shares
      // an approach with one only one hop in; comparing their raw distanceTraveled either invented
      // a "leader" hundreds of units closer than physically real (spurious hard braking) or hid a
      // genuinely close leader behind an enormous phantom gap (no braking at all). Projecting onto
      // my own heading keeps this exact, regardless of either vehicle's route history.
      const forwardX = Math.cos(myHeading);
      const forwardY = Math.sin(myHeading);
      let ahead: { t: Tracked; forwardDistance: number } | null = null;
      for (const t of this.tracked.values()) {
        if (t === entry) continue;
        if (t.path.approachIdAt(t.distanceTraveled) !== myCurrentApproach) continue;
        if (Math.cos(t.body.body.angle - myHeading) <= 0.5) continue; // within ~60 degrees of my own heading
        const dx = t.body.body.position.x - entry.body.body.position.x;
        const dy = t.body.body.position.y - entry.body.body.position.y;
        const forwardDistance = dx * forwardX + dy * forwardY;
        if (forwardDistance <= 0) continue;
        if (!ahead || forwardDistance < ahead.forwardDistance) ahead = { t, forwardDistance };
      }

      let leader: IdmState | null = ahead
        ? { position: entry.distanceTraveled + ahead.forwardDistance, speed: realSpeed(ahead.t.body.body) }
        : null;
      // Tracks whether the CURRENT leader is a red/yellow signal stop line specifically, as
      // opposed to a real vehicle/pedestrian obstacle — used below to gate the stall-escape boost,
      // which must never apply to a legitimate red-light wait (that would mean running the red).
      let leaderIsHardStop = false;

      // Only applies to a vehicle still APPROACHING its next stop line — one that has already
      // crossed into the intersection box is treated as having committed to clearing it, exactly
      // like a real driver who entered on green completes their turn rather than stopping mid-box
      // for another car also passing through. Without this distinction, two vehicles from crossing
      // approaches that both happen to be transiting the box at once (routine right at a signal
      // phase change) each treat the other as a leader to brake for — since neither one is moving,
      // both stay stopped forever, a symmetric standoff that backs up the entire network. Found
      // directly: every approach's queue on the plain grid map ground to a total, permanent halt,
      // traced to exactly this mutual freeze at the intersection center.
      const lastStopLine = [...entry.path.stopLines].reverse().find((s) => s.distance <= entry.distanceTraveled);
      const INTERSECTION_CLEARANCE_DISTANCE = 60;
      const isTransitingIntersection = lastStopLine != null && entry.distanceTraveled - lastStopLine.distance < INTERSECTION_CLEARANCE_DISTANCE;

      // Pedestrians never had any vehicle-avoidance counterpart at all — a pedestrian standing
      // (e.g. waiting at a crosswalk, or mid-jaywalk) anywhere in a vehicle's path could physically
      // wedge it with no way to ever resolve, since neither system was aware of the other. Treated
      // as a hard stop (speed 0), not a following-distance calculation — real drivers stop fully
      // for a pedestrian in the road rather than car-following them.
      //
      // Exempt while isTransitingIntersection, same real-world rule as "don't block the box": a
      // driver already committed to a turn doesn't slam to a dead stop mid-intersection for a
      // pedestrian — stopping there blocks the crosswalk for everyone, which is exactly what real
      // traffic law prohibits. Found directly: a vehicle mid-turn braked to a permanent full stop
      // for a pedestrian crossing nearby, and because pedestrians at a busy crossing arrive faster
      // than any one of them clears the vehicle's scan corridor, a fresh pedestrian was always
      // within range — the vehicle never got a gap and sat wedged for the rest of the run, backing
      // up the entire network behind it via the intersection-occupancy check above.
      const pedestrianAhead = isTransitingIntersection
        ? null
        : findObstacleAhead(
            entry.body.body.position,
            myHeading,
            pedestrians,
            PEDESTRIAN_OBSTACLE_SCAN_DISTANCE,
            PEDESTRIAN_OBSTACLE_LATERAL_TOLERANCE
          );
      if (pedestrianAhead) {
        const pedestrianPosition = entry.distanceTraveled + pedestrianAhead.distance;
        if (!leader || leader.position > pedestrianPosition) {
          leader = { position: pedestrianPosition, speed: 0 };
          leaderIsHardStop = false;
        }
      }

      {
        const forwardX = Math.cos(myHeading);
        const forwardY = Math.sin(myHeading);
        const perpX = -forwardY;
        const perpY = forwardX;
        for (const other of this.tracked.values()) {
          if (other === entry) continue;
          const dx = other.body.body.position.x - entry.body.body.position.x;
          const dy = other.body.body.position.y - entry.body.body.position.y;
          const forwardDistance = dx * forwardX + dy * forwardY;
          if (forwardDistance <= 0 || forwardDistance > VEHICLE_OBSTACLE_SCAN_DISTANCE) continue;
          const lateralDistance = Math.abs(dx * perpX + dy * perpY);
          if (lateralDistance > VEHICLE_OBSTACLE_LATERAL_TOLERANCE) continue;
          // Three relationships between this vehicle and `other`:
          //  - same direction (cos near +1): ordinary car-following, e.g. a car that just
          //    completed its own turn into this lane with another vehicle already sitting ahead in
          //    it. Always brake for this — ignoring it let a turning car command full throttle
          //    straight into an already-stopped car sharing its new lane forever, since Matter's
          //    physical collision response never lets one solid body drive through another
          //    regardless of what the leader logic outputs.
          //  - crossing (perpendicular, |cos| small): the original case isTransitingIntersection
          //    exists for — two turning vehicles both momentarily inside the box at a signal phase
          //    change, each treating the other as a leader with neither moving, froze forever.
          //    Exempt only the vehicle that's already committed (isTransitingIntersection).
          //  - opposite direction (cos near -1): single-lane roads (this sim's explicit non-goal:
          //    no multi-lane physics) mean a vehicle entering an approach and a different vehicle
          //    exiting via that same approach share the literal same centerline, head-on. A
          //    committed (isTransitingIntersection) vehicle correctly gets priority and doesn't
          //    treat an oncoming, not-yet-committed vehicle as an obstacle — but the REVERSE also
          //    has to hold: the not-yet-committed vehicle must not treat the committed oncoming one
          //    as a car-following leader either, or it converges to a fixed proximity gap far
          //    closer than its own stop line, driving the two into actual Matter contact (found
          //    directly: two vehicles nose-to-nose in real physical contact, neither's IDM logic
          //    ever using enough braking distance to stay clear, because each treated the other as
          //    a normal moving leader instead of "wait behind my own stop line for this to clear").
          //    Its own intersection-occupancy stop-line check already handles waiting safely; only
          //    brake for oncoming traffic here if BOTH vehicles are simultaneously committed — a
          //    genuine, both-already-entered head-on conflict.
          const headingCos = Math.cos(other.body.body.angle - myHeading);
          const isCrossingTraffic = Math.abs(headingCos) < 0.5;
          const isOpposingTraffic = headingCos <= -0.5;
          const otherLastStopLine = [...other.path.stopLines].reverse().find((s) => s.distance <= other.distanceTraveled);
          const otherIsTransiting = otherLastStopLine != null && other.distanceTraveled - otherLastStopLine.distance < INTERSECTION_CLEARANCE_DISTANCE;
          if (isCrossingTraffic && isTransitingIntersection) continue;
          if (isOpposingTraffic && !(isTransitingIntersection && otherIsTransiting)) continue;
          const candidatePosition = entry.distanceTraveled + forwardDistance;
          if (!leader || leader.position > candidatePosition) {
            leader = { position: candidatePosition, speed: realSpeed(other.body.body) };
            leaderIsHardStop = false;
          }
        }
      }

      const nextStop = entry.path.stopLines.find((s) => s.distance > entry.distanceTraveled) ?? null;
      if (nextStop) {
        // Even on a real green light, don't enter a box another vehicle from a different approach
        // is still transiting — signal phasing alone doesn't guarantee this never overlaps (a car
        // running long on a green it's about to lose, or one still crossing when the all-red
        // clearance is too short for how long a real crossing actually takes at this sim's speeds).
        // Serializing box occupancy the same way a real 4-way intersection resolves an edge case
        // is what actually prevents the physical collision, rather than relying on timing alone —
        // found directly: two vehicles from perpendicular approaches both stopped, wedged together,
        // exactly at the intersection center, well after the signal had already changed correctly.
        const nextStopIntersectionId = this.mapDef.approaches.find((a) => a.id === nextStop.approachId)?.intersectionId;
        const occupiedByOther = nextStopIntersectionId
          ? [...this.tracked.values()].some((t) => {
              if (t === entry) return false;
              const tLastStop = [...t.path.stopLines].reverse().find((s) => s.distance <= t.distanceTraveled);
              if (!tLastStop || t.distanceTraveled - tLastStop.distance >= INTERSECTION_CLEARANCE_DISTANCE) return false;
              if (tLastStop.approachId === nextStop.approachId) return false;
              const tIntersectionId = this.mapDef.approaches.find((a) => a.id === tLastStop.approachId)?.intersectionId;
              if (tIntersectionId !== nextStopIntersectionId) return false;
              // Two approaches the signal itself groups into the SAME phase are explicitly meant
              // to move simultaneously without conflict (that's the entire point of a phase) — a
              // real 4-way intersection lets both directions of a through-phase flow at once, it
              // doesn't serialize them one at a time. Treating any other occupant as blocking,
              // regardless of phase grouping, needlessly forced same-phase traffic through one
              // vehicle at a time — found directly: transit times across the city map grew
              // unboundedly (cars taking 10+ minutes to cross a network with a ~90s free-flow
              // transit time) even at a low, clearly-sub-capacity arrival rate, traced to this
              // mutex serializing traffic that the signal already permits to move together.
              if (this.isSameSignalPhase(nextStopIntersectionId, nextStop.approachId, tLastStop.approachId)) return false;
              // An occupant already flagged as genuinely stalled (see the stall-escape valve
              // below) doesn't count as "occupying" the box — otherwise this mutex creates its
              // own permanent deadlock, invisible to the stall-escape itself: the escape valve
              // never touches a vehicle whose leader is a real stop line (leaderIsHardStop), and
              // "the box is occupied" reads exactly like a stop line to the vehicle waiting on it.
              // If the occupant is itself frozen, that "red" never clears on its own, so the
              // waiting vehicle sits there forever even on a real green light. Found directly: a
              // vehicle stuck in genuine contact with another car froze solid through 15+ seconds
              // of confirmed green, permanently, because the intersection it needed read as
              // occupied by that same frozen car for the entire time.
              //
              // t.noProgressMs is the second, slower half of that same fix (see its own top-level
              // comment): an occupant can be indefinitely stuck WITHOUT ever registering physical
              // contact (e.g. itself waiting on a different occupied box, recursively) — stalledMs
              // alone would never catch that, silently letting this exact deadlock re-form one level
              // removed. Excluding on either timer closes that gap.
              return t.stalledMs <= STALL_ESCAPE_MS && t.noProgressMs <= NO_PROGRESS_ESCAPE_MS;
            })
          : false;

        // ownSignalState is this approach's REAL, unforced light — never inflated by occupiedByOther.
        // occupiedByOther can only ever push the EFFECTIVE state (signalState) to "red"; it must never
        // be allowed to make leaderIsHardStop true, or a vehicle blocked purely by another (possibly
        // itself-stuck) occupant becomes indistinguishable from one legitimately stopped at its own
        // red light — exactly the condition that let the no-progress deadlock above go unrescued
        // forever, since the escape valves both explicitly refuse to touch a leaderIsHardStop wait.
        const ownSignalState = approachSignalStates.get(nextStop.approachId) ?? "red";
        const signalState = occupiedByOther ? "red" : ownSignalState;
        const distanceToStopLine = nextStop.distance - entry.distanceTraveled;

        if (signalState === "red") {
          if (!leader || leader.position > nextStop.distance) {
            leader = { position: nextStop.distance, speed: 0 };
            leaderIsHardStop = ownSignalState === "red";
          }
        } else if (signalState === "yellow") {
          const brakingDistance = (speed * speed) / (2 * this.idmParams.b);
          const canStopSafely = brakingDistance <= distanceToStopLine;
          if (canStopSafely && (!leader || leader.position > nextStop.distance)) {
            leader = { position: nextStop.distance, speed: 0 };
            leaderIsHardStop = true; // occupiedByOther can never force "yellow" — always a real signal state
          }
        }
      }

      // Escape valve for a genuine physical stall: two vehicles can end up in real, physically
      // touching contact — even a graze of a fraction of a unit — and Matter's own rigid-body
      // solver will never let one drive through the other no matter what velocity is requested.
      // This isn't always visible in the leader/IDM logic at all: found directly, a single,
      // completely isolated vehicle (zero other traffic, every signal green) drove normally for
      // 45s, then froze at one exact position for the rest of an arbitrarily long run after
      // grazing a second vehicle — with `leader` reading `null` (no obstacle detected) and full
      // throttle commanded every tick the whole time it sat frozen. IDM has no way to fix this: the
      // AI already wants to go, physics itself is the one refusing. The only real fix is a direct,
      // rare, last-resort position correction — nudging the vehicle forward past the wedge point —
      // not another acceleration/braking tweak. This compounds across a whole network once enough
      // vehicles queue up behind each stall, so leaving it unfixed doesn't stay a one-car problem.
      //
      // Gating on an ACTUAL Matter.js collision pair (vehiclesInPhysicalContact, computed once per
      // tick above), not IDM's own gap math, is what keeps this from ever firing during a normal,
      // correctly-settled red-light queue: a stopped car resting at IDM's own equilibrium gap (s0,
      // ~2 units) has zero body overlap, since real vehicle length is already subtracted out of
      // that gap — no Matter contact exists there at all. leaderIsHardStop additionally rules out
      // the stop-line case regardless of contact state.
      const isGenuineStall = !leaderIsHardStop && speed < STALL_SPEED_THRESHOLD && vehiclesInPhysicalContact.has(id);
      entry.stalledMs = isGenuineStall ? entry.stalledMs + dtMs : 0;

      // Tracks "hasn't actually advanced," independent of contact or speed at any single instant —
      // see NO_PROGRESS_ESCAPE_MS's own top-level comment for the soft, contact-free deadlock this
      // exists to break. Never advances the "stuck" clock while genuinely, presently blocked by a
      // real pedestrian: nudging through an actual person in the road would be a real safety
      // violation no matter how long the wait, unlike a manufactured intersection-occupancy "red".
      const progressed = entry.distanceTraveled - entry.lastProgressDistance > PROGRESS_EPSILON;
      if (progressed) {
        entry.lastProgressDistance = entry.distanceTraveled;
        entry.noProgressMs = 0;
      } else if (!pedestrianAhead) {
        entry.noProgressMs += dtMs;
      }

      // Never nudge across an upcoming stop line, red or not (nudgeLimit) — this valve exists to
      // break a physical wedge between vehicles, not to wave a car through an intersection it
      // hasn't earned the right of way to enter. A real regression caught by this repo's own test
      // suite: a car queued behind a red light, blocked by the car ahead of it rather than
      // directly by the stop line (so not exempted by leaderIsHardStop), got nudged clean past the
      // line into the intersection.
      //
      // That alone isn't enough, though: ordinary IDM braking overshoot (real controllers aren't
      // perfectly precise — a car can end up a few units past its own stop line before fully
      // arresting) leaves `nextStop` at `null` (there's no *upcoming* stop line once already past
      // it), which used to mean "no limit at all." If the escape valve then fired again on that
      // same car, it could re-nudge every ~1.5s with no clamp whatsoever, progressively shoving it
      // further through a red intersection over several cycles — a second real regression the
      // same test caught. `recentlyPassedRedOrYellow` refuses to nudge at all while sitting just
      // past a stop line whose light isn't actually green, regardless of `nextStop`.
      const recentlyPassedRedOrYellow =
        lastStopLine != null &&
        entry.distanceTraveled - lastStopLine.distance < INTERSECTION_CLEARANCE_DISTANCE &&
        (approachSignalStates.get(lastStopLine.approachId) ?? "red") !== "green";
      const eligibleForNoProgressEscape = entry.noProgressMs > NO_PROGRESS_ESCAPE_MS && !leaderIsHardStop && !pedestrianAhead;
      if ((entry.stalledMs > STALL_ESCAPE_MS || eligibleForNoProgressEscape) && !recentlyPassedRedOrYellow) {
        const NUDGE_DISTANCE = 20;
        const nudgeLimit = nextStop?.distance ?? entry.path.totalLength;
        const nudgeTarget = entry.path.pointAt(Math.min(entry.distanceTraveled + NUDGE_DISTANCE, nudgeLimit, entry.path.totalLength));
        Matter.Body.setPosition(entry.body.body, { x: nudgeTarget.x, y: nudgeTarget.y });
        Matter.Body.setVelocity(entry.body.body, { x: 0, y: 0 });
        entry.stalledMs = 0;
        entry.noProgressMs = 0;
        entry.lastProgressDistance = entry.distanceTraveled;
      }

      // Yield for an emergency vehicle closing in from behind: accelerate harder and tolerate a
      // faster free-road speed to open a gap, rather than cruising at the normal pace. Still
      // respects a real leader/red-light stop ahead (never runs a red for this) — this only
      // changes how *assertively* the car moves when it's actually clear to do so.
      const isYielding = activeEv !== null && evIsClosingFromBehind(entry.body, activeEv);
      const effectiveIdmParams = isYielding
        ? { ...this.idmParams, aMax: this.idmParams.aMax * 2, v0: this.idmParams.v0 * 1.3 }
        : this.idmParams;

      const accel = idmAcceleration({ position: entry.distanceTraveled, speed }, leader, effectiveIdmParams);
      const throttle = Math.max(0, Math.min(1, accel / effectiveIdmParams.aMax));
      const brake = Math.max(0, Math.min(1, -accel / effectiveIdmParams.b));

      // Below this speed, steering correction is skipped entirely rather than computed from the
      // lookahead target — see EvRouter.step's identical guard for why: steer sets angular
      // velocity directly, independent of linear speed, so a stopped/barely-moving vehicle can
      // still spin in place from noisy heading-error math at near-zero position deltas, eventually
      // rotating into its own lane's side wall while just sitting in a queue.
      const STEERING_MIN_SPEED = 1;
      let steer = 0;
      if (speed >= STEERING_MIN_SPEED) {
        const lookaheadDistance = Math.min(entry.distanceTraveled + LOOKAHEAD_DISTANCE, entry.path.totalLength);
        const targetPoint = entry.path.pointAt(lookaheadDistance);
        const desiredHeading = Math.atan2(
          targetPoint.y - entry.body.body.position.y,
          targetPoint.x - entry.body.body.position.x
        );
        const headingError = Math.atan2(Math.sin(desiredHeading - entry.body.body.angle), Math.cos(desiredHeading - entry.body.body.angle));
        steer = Math.max(-1, Math.min(1, headingError / (Math.PI / 4)));
      }

      entry.body.applyInput(throttle, brake, steer, dtMs);

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

  // True when the signal at `intersectionId` groups both approaches into the same phase — i.e.
  // they're designed to move through the box simultaneously (a real intersection's through-phase
  // moving both directions at once, or two non-conflicting turns sharing a phase), not a case the
  // box-occupancy mutex above needs to serialize.
  private isSameSignalPhase(intersectionId: string, approachIdA: string, approachIdB: string): boolean {
    const intersection = this.mapDef.intersections.find((i) => i.id === intersectionId);
    if (!intersection) return false;
    return intersection.phases.some(
      (phase) => phase.allowedApproachIds?.includes(approachIdA) && phase.allowedApproachIds?.includes(approachIdB)
    );
  }
}
