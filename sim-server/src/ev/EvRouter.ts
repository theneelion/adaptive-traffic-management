import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld.js";
import type { MapDefinition } from "../maps/MapDefinition.js";
import { VehicleBody } from "../vehicles/VehicleBody.js";
import { idmAcceleration, type IdmParams } from "../vehicles/IdmController.js";
import { buildMultiHopVehiclePath, type VehiclePath } from "../vehicles/TurnPaths.js";
import { buildRoadGraph, type RoadGraph } from "./RoadGraph.js";
import { realSpeed } from "../physics/realSpeed.js";
import { findObstacleAhead, type ObstaclePoint } from "../vehicles/obstacleDetection.js";

// How far ahead to scan for a pedestrian blocking the EV's path — same distance as the
// vehicle-obstacle scan (OBSTACLE_SCAN_DISTANCE below), but its own constant since a pedestrian is
// a much smaller, slower-moving obstacle and deserves its own tuning if these ever diverge.
// See TrafficController's identical constant for why this was shrunk from an earlier 45 — a busy
// crosswalk can have some pedestrian somewhere in a 45-unit scan almost continuously, permanently
// re-pinning the leader target before the vehicle ever gets to accelerate away.
const PEDESTRIAN_OBSTACLE_SCAN_DISTANCE = 25;
// Roughly a vehicle's own half-width (9) plus a pedestrian's radius (6) plus a small buffer —
// only a pedestrian genuinely within the lane counts as blocking, not one merely standing
// nearby (see obstacleDetection.ts's own comment for the real regression this replaced: an
// angle-cone check widened far too much at any real distance).
const PEDESTRIAN_OBSTACLE_LATERAL_TOLERANCE = 15;

// vehicleLength=36 matches VehicleBody's real Matter.js rectangle length — previously 5, a value
// that was harmless only because `leader` was always null (no leader-following existed at all, so
// this constant was never actually read). Now that the EV really does follow a leader, it needs
// to be correct: too small would make the IDM formula's gap calculation think there's far more
// following room than physically exists, letting the EV creep dangerously close before braking.
const EV_IDM_PARAMS: IdmParams = { v0: 22, T: 1.0, aMax: 2.5, b: 3.0, delta: 4, s0: 2, vehicleLength: 36 };
const LOOKAHEAD_DISTANCE = 20;
// How far ahead to scan for a physical obstacle blocking the EV's path (spec-adjacent fix: the EV
// previously drove with a hardcoded `leader: null`, meaning zero awareness of other traffic —
// found directly from a user report of the ambulance getting permanently wedged behind ordinary
// traffic instead of the green wave actually clearing a path for it). A real leader-following
// vehicle would slow for real traffic; a real emergency vehicle in a green-wave corridor should
// rarely need to, since the corridor itself is supposed to be cleared — this braking behavior is
// the safety net for whenever it isn't (an unlucky pocket of traffic already committed to the
// intersection when preemption fires).
const OBSTACLE_SCAN_DISTANCE = 100;
// cos(~28 degrees) — how far off dead-ahead another vehicle can be and still count as "blocking
// this lane" rather than a car in an adjacent/crossing lane that just happens to be nearby.
const OBSTACLE_ANGLE_COS_THRESHOLD = 0.88;
let spawnCounter = 0;

// Finds the nearest other vehicle within OBSTACLE_SCAN_DISTANCE that's roughly straight ahead of
// this one (by heading, not by shared-path distance — the EV and a regular vehicle are on
// different, independently-built VehiclePaths, so there's no shared 1-D coordinate to compare
// directly). A simple physical proximity + heading-alignment check is a robust, route-agnostic way
// to detect "something is physically blocking my lane right now."
function findVehicleAhead(body: VehicleBody, others: VehicleBody[]): { distance: number; speed: number } | null {
  const pos = body.body.position;
  const heading = body.body.angle;
  const forwardX = Math.cos(heading);
  const forwardY = Math.sin(heading);
  let best: { distance: number; speed: number } | null = null;
  for (const other of others) {
    if (other === body) continue;
    const dx = other.body.position.x - pos.x;
    const dy = other.body.position.y - pos.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-6 || distance > OBSTACLE_SCAN_DISTANCE) continue;
    const forwardComponent = (dx * forwardX + dy * forwardY) / distance;
    if (forwardComponent < OBSTACLE_ANGLE_COS_THRESHOLD) continue;
    if (!best || distance < best.distance) best = { distance, speed: realSpeed(other.body) };
  }
  return best;
}

interface Active {
  id: string;
  body: VehicleBody;
  originApproachId: string;
  path: VehiclePath;
  distanceTraveled: number;
}

export class EvRouter {
  private active: Active | null = null;
  private readonly graph: RoadGraph;

  constructor(private readonly world: PhysicsWorld, private readonly mapDef: MapDefinition) {
    // Built from the constructor's own `mapDef` parameter, not a `graph = buildRoadGraph(this.mapDef)`
    // field initializer: class field initializers run before TypeScript's constructor-parameter-
    // property assignments take effect, so `this.mapDef` would still be undefined at that point —
    // a real bug found only by actually running this class's tests, not by reading the code.
    this.graph = buildRoadGraph(mapDef);
  }

  spawn(
    originApproachId: string,
    destinationApproachId: string,
    otherVehicles: VehicleBody[] = []
  ): { evId: string } | { error: "already_active" | "invalid_destination" | "spawn_blocked" } {
    if (this.active) return { error: "already_active" };

    const origin = this.mapDef.approaches.find((a) => a.id === originApproachId);
    const destination = this.mapDef.approaches.find((a) => a.id === destinationApproachId);
    if (!origin || !destination || originApproachId === destinationApproachId) {
      return { error: "invalid_destination" };
    }

    const route = this.graph.shortestPath(`end_${originApproachId}`, `end_${destinationApproachId}`);
    const approachIds = route.edges.map((e) => e.approachId);
    const path = buildMultiHopVehiclePath(this.mapDef, approachIds);
    const heading = Math.atan2(origin.laneEndY - origin.laneStartY, origin.laneEndX - origin.laneStartX);
    // Spawn at the path's own real starting point, not the approach's raw laneStart — see
    // TrafficController's identical fix for why (the path is now offset to one side of the raw
    // centerline, so spawning at the unoffset point put the EV immediately off its own path).
    const spawnPoint = path.pointAt(0);
    // TrafficController's own spawn path refuses to place a new vehicle within
    // SPAWN_CLEARANCE_DISTANCE of an existing one on the same approach — but that check only looks
    // at other TrafficController-tracked vehicles, never the EV, and this spawn path had no
    // equivalent check in the other direction at all. A regular vehicle sitting at or near this
    // exact spawn point (routine — it's the same point every entry on this approach uses) meant
    // the EV could spawn directly on top of it, an instant, unavoidable collision at tick zero.
    // Found directly from a user report: "whenever the ambulance spawns, another car spawns too
    // and both crash" — there's no second spawn, it's the EV materializing into an already-present
    // car. Refusing to spawn this tick (the caller can just retry) is far better than a guaranteed
    // crash the EV can never recover from since it's wedged before its own route logic ever runs.
    const EV_SPAWN_CLEARANCE_DISTANCE = 45; // vehicle length (36) + ev length (36) / 2 + margin
    const blocked = otherVehicles.some(
      (v) => Math.hypot(v.body.position.x - spawnPoint.x, v.body.position.y - spawnPoint.y) < EV_SPAWN_CLEARANCE_DISTANCE
    );
    if (blocked) return { error: "spawn_blocked" };
    const id = `amb_${spawnCounter++}`;
    const body = new VehicleBody(this.world, id, { x: spawnPoint.x, y: spawnPoint.y, heading });
    body.controller = "ev";

    this.active = { id, body, originApproachId, path, distanceTraveled: 0 };
    return { evId: id };
  }

  step(dtMs: number, otherVehicles: VehicleBody[] = [], pedestrians: ObstaclePoint[] = []): void {
    if (!this.active) return;
    const { body, path } = this.active;

    // Closed-loop distance tracking (see TurnPaths.closestProgress and TrafficController): an
    // open-loop `distanceTraveled += speed * dt` accumulation silently drifts from the vehicle's
    // real physical position whenever steering introduces lateral velocity. That drift feeds back
    // into the lookahead target lookup (wrong point on the path -> wrong steering -> more drift),
    // and at the EV's higher speed this diverges into the vehicle spinning off the road entirely
    // within a few seconds — found only by actually running this test and tracing the EV's
    // position, not by reading the code (it was copied from an EvRouter draft written before
    // Phase 3's closed-loop fix landed).
    this.active.distanceTraveled = path.closestProgress(body.body.position, this.active.distanceTraveled);

    const speed = realSpeed(body.body);
    const vehicleAhead = findVehicleAhead(body, otherVehicles);
    // Pedestrians never had any vehicle-avoidance counterpart at all — a pedestrian standing (or
    // waiting at a crosswalk, or jaywalking) anywhere in the EV's path could physically wedge it
    // with no way to ever resolve, since neither system was aware of the other. Treated as a hard
    // stop (speed 0), not a following-distance calculation — real drivers stop fully for a
    // pedestrian in the road rather than car-following them.
    const pedestrianAhead = findObstacleAhead(body.body.position, body.body.angle, pedestrians, PEDESTRIAN_OBSTACLE_SCAN_DISTANCE, PEDESTRIAN_OBSTACLE_LATERAL_TOLERANCE);
    const candidates = [
      vehicleAhead ? { position: this.active.distanceTraveled + vehicleAhead.distance, speed: vehicleAhead.speed } : null,
      pedestrianAhead ? { position: this.active.distanceTraveled + pedestrianAhead.distance, speed: 0 } : null
    ].filter((c): c is { position: number; speed: number } => c !== null);
    // Approximates the physical gap as an offset from the EV's own path-distance coordinate —
    // idmAcceleration is a 1-D car-following model, but the obstacle here is on a different,
    // independently-tracked coordinate with no shared path; converting the real Euclidean gap into
    // "my distance + that gap" is a reasonable local approximation for braking purposes (this
    // models "is there a physical obstacle in my way right now," not "where exactly is it on my
    // route graph"). Whichever candidate is closest is the binding constraint.
    const leader = candidates.length > 0 ? candidates.reduce((a, b) => (a.position < b.position ? a : b)) : null;
    const accel = idmAcceleration({ position: this.active.distanceTraveled, speed }, leader, EV_IDM_PARAMS);
    const throttle = Math.max(0, Math.min(1, accel / EV_IDM_PARAMS.aMax));
    const brake = Math.max(0, Math.min(1, -accel / EV_IDM_PARAMS.b));

    // Below this speed, steering correction is skipped entirely rather than computed from the
    // lookahead target. A stopped or barely-moving vehicle's own position is essentially fixed,
    // but steer still sets the body's ANGULAR velocity directly (VehicleBody.applyInput) —
    // independent of linear speed — so any nonzero steer value spins the vehicle in place. Tiny
    // physics jitter in position at near-zero speed makes the desiredHeading/atan2 calculation
    // numerically noisy (small position deltas produce disproportionately large angle swings),
    // which otherwise very visibly rotates a queued vehicle over time until it points into its own
    // lane's side wall — found directly: a stopped EV's heading had drifted ~29 degrees off its
    // approach's real direction, actively colliding with its own lane wall while blocked by a
    // leader ahead, nowhere near any curve or turn.
    const STEERING_MIN_SPEED = 1;
    let steer = 0;
    if (speed >= STEERING_MIN_SPEED) {
      const lookaheadDistance = Math.min(this.active.distanceTraveled + LOOKAHEAD_DISTANCE, path.totalLength);
      const target = path.pointAt(lookaheadDistance);
      const desiredHeading = Math.atan2(target.y - body.body.position.y, target.x - body.body.position.x);
      const headingError = Math.atan2(Math.sin(desiredHeading - body.body.angle), Math.cos(desiredHeading - body.body.angle));
      steer = Math.max(-1, Math.min(1, headingError / (Math.PI / 4)));
    }

    body.applyInput(throttle, brake, steer, dtMs);

    if (this.active.distanceTraveled >= path.totalLength - 1) {
      Matter.Composite.remove(this.world.engine.world, body.body);
      this.active = null;
    }
  }

  // Resolves the actual phase id from map data (e.g. "NS_through", or a city map's own phase
  // names) for whichever approach needs green at the given intersection — replaces the old
  // hardcoded compass APPROACH_DIRECTIONS lookup entirely.
  private phaseIdFor(intersectionId: string, approachId: string): string | null {
    const intersection = this.mapDef.intersections.find((i) => i.id === intersectionId);
    const phase = intersection?.phases.find((p) => p.allowedApproachIds!.includes(approachId));
    return phase?.id ?? null;
  }

  etaToIntersection(evId: string, intersectionId: string): number | null {
    if (!this.active || this.active.id !== evId) return null;
    const active = this.active;
    const stop = active.path.stopLines.find((s) => {
      const approach = this.mapDef.approaches.find((a) => a.id === s.approachId)!;
      return approach.intersectionId === intersectionId;
    });
    if (!stop || stop.distance <= active.distanceTraveled) return null; // no such stop, or already passed it

    const remaining = stop.distance - active.distanceTraveled;
    // Flooring at the EV's own cruise speed (not a near-zero value like 0.1) matters specifically
    // when the EV is stopped or barely moving — e.g. right at spawn, or genuinely blocked by
    // traffic ahead of its first intersection. A near-zero floor makes ETA blow up toward
    // infinity, which never drops below SimSession's preempt threshold — a real bug found by
    // tracing a spawned EV that never got its very first intersection preempted at all, because
    // it hadn't started moving yet when ETA was computed. Assuming it'll travel at roughly its own
    // target speed (this is a forward-looking "when should preemption kick in" estimate, not a
    // literal "at this instant's crawl speed" one) lets the green wave engage before the EV is
    // even moving, matching how real dispatch preemption works.
    const speed = Math.max(realSpeed(active.body.body), EV_IDM_PARAMS.v0 * 0.5);
    return Math.max(remaining, 0) / speed;
  }

  requiredPhaseId(evId: string): string | null {
    if (!this.active || this.active.id !== evId) return null;
    const active = this.active;
    const nextStop = active.path.stopLines.find((s) => s.distance > active.distanceTraveled);
    if (!nextStop) return null;
    const approach = this.mapDef.approaches.find((a) => a.id === nextStop.approachId)!;
    return this.phaseIdFor(approach.intersectionId, nextStop.approachId);
  }

  hasPassedIntersection(evId: string): boolean {
    if (!this.active || this.active.id !== evId) return true;
    const active = this.active;
    return !active.path.stopLines.some((s) => s.distance > active.distanceTraveled);
  }

  // The full ordered list of intersections still ahead of this EV, with ETA and the phase it needs
  // at each one — used by SimSession's green-wave preemption loop (spec §7.3) to force every
  // upcoming intersection along the route, not just the immediate one.
  upcomingStops(evId: string): { intersectionId: string; approachId: string; etaS: number; phaseId: string | null }[] {
    if (!this.active || this.active.id !== evId) return [];
    const active = this.active;
    // Flooring at the EV's own cruise speed (not a near-zero value like 0.1) matters specifically
    // when the EV is stopped or barely moving — e.g. right at spawn, or genuinely blocked by
    // traffic ahead of its first intersection. A near-zero floor makes ETA blow up toward
    // infinity, which never drops below SimSession's preempt threshold — a real bug found by
    // tracing a spawned EV that never got its very first intersection preempted at all, because
    // it hadn't started moving yet when ETA was computed. Assuming it'll travel at roughly its own
    // target speed (this is a forward-looking "when should preemption kick in" estimate, not a
    // literal "at this instant's crawl speed" one) lets the green wave engage before the EV is
    // even moving, matching how real dispatch preemption works.
    const speed = Math.max(realSpeed(active.body.body), EV_IDM_PARAMS.v0 * 0.5);
    return active.path.stopLines
      .filter((s) => s.distance > active.distanceTraveled)
      .map((s) => {
        const approach = this.mapDef.approaches.find((a) => a.id === s.approachId)!;
        return {
          intersectionId: approach.intersectionId,
          approachId: s.approachId,
          etaS: (s.distance - active.distanceTraveled) / speed,
          phaseId: this.phaseIdFor(approach.intersectionId, s.approachId)
        };
      });
  }

  activeVehicle(): VehicleBody | null {
    return this.active?.body ?? null;
  }
}
