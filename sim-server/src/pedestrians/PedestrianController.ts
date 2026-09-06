import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld.js";
import { PedestrianGraph } from "./PedestrianGraph.js";
import { computeSteeringForce, DEFAULT_STEERING_PARAMS } from "./steering.js";
import { jaywalkProbability } from "./JaywalkModel.js";
import { TrafficSpawner } from "../vehicles/TrafficSpawner.js";
import { realVelocity, MATTER_VELOCITY_SCALE } from "../physics/realSpeed.js";

type SignalLightState = "green" | "yellow" | "red";
const PATIENCE_S = 8;
// Without a cap, a crossing that's permanently unsafe (e.g. a stuck signal) lets pedestrians queue
// up without bound — each additional agent adds O(n) neighbor-separation cost per tick to every
// other agent's steering, so an unbounded queue turns into O(n^2) per-tick cost that can grind
// the whole simulation to a halt. This surfaced concretely as a test that never finished, not as
// a theoretical concern. Capping total tracked agents (mirroring TrafficController's
// MAX_VEHICLES_PER_APPROACH) keeps a stuck crossing from taking down performance — new arrivals
// simply wait to spawn until the population has room, exactly like real pedestrian crowding would
// self-limit at a jammed crossing.
const MAX_TRACKED_PEDESTRIANS = 60;

export interface PedestrianSnapshot {
  id: string;
  x: number;
  y: number;
}

interface Agent {
  id: string;
  body: Matter.Body;
  path: string[]; // remaining node ids, path[0] is the next target
  lastNodeId: string;
  waitStartMs: number | null;
  waitingAtCrossingId: string | null;
  jaywalking: boolean;
}

export class PedestrianController {
  private readonly agents2 = new Map<string, Agent>();
  private spawner: TrafficSpawner;
  private spawnCounter = 0;

  constructor(
    private readonly world: PhysicsWorld,
    private readonly graph: PedestrianGraph,
    private readonly farNodeIds: string[],
    private readonly rng: () => number,
    arrivalRatePerMinPerNode: number
  ) {
    this.spawner = new TrafficSpawner(farNodeIds, rng, arrivalRatePerMinPerNode);
  }

  setArrivalRate(ratePerMinPerNode: number): void {
    this.spawner = new TrafficSpawner(this.farNodeIds, this.rng, ratePerMinPerNode);
  }

  step(dtMs: number, approachSignalStates: Map<string, SignalLightState>): void {
    for (const originId of this.spawner.step(dtMs)) {
      if (this.agents2.size >= MAX_TRACKED_PEDESTRIANS) continue;
      const destinationId = this.pickDestination(originId);
      const origin = this.graph.node(originId);
      const path = this.graph.shortestPath(originId, destinationId).slice(1);
      const id = `ped_${this.spawnCounter++}`;
      // frictionAir: 0 is deliberate — see VehicleBody's identical fix. Steering is a per-tick
      // kinematic velocity update (applySteering), so Matter's own per-substep air-friction decay
      // would otherwise fight the once-per-tick velocity that update sets.
      const body = Matter.Bodies.circle(origin.x, origin.y, 6, { label: `pedestrian_${id}`, frictionAir: 0 });
      Matter.Composite.add(this.world.engine.world, body);
      this.agents2.set(id, { id, body, path, lastNodeId: originId, waitStartMs: null, waitingAtCrossingId: null, jaywalking: false });
    }

    for (const [id, agent] of [...this.agents2.entries()]) {
      this.stepAgent(agent, dtMs, approachSignalStates);
      if (agent.path.length === 0) {
        Matter.Composite.remove(this.world.engine.world, agent.body);
        this.agents2.delete(id);
      }
    }
  }

  private pickDestination(originId: string): string {
    const others = this.farNodeIds.filter((id) => id !== originId);
    return others[Math.floor(this.rng() * others.length)] ?? others[0];
  }

  private stepAgent(agent: Agent, dtMs: number, approachSignalStates: Map<string, SignalLightState>): void {
    const nextId = agent.path[0];
    const edge = this.graph.edgeBetween(agent.lastNodeId, nextId);
    const isSafeToCross = edge?.approachId ? approachSignalStates.get(edge.approachId) === "red" : true;

    if (edge?.kind === "crosswalk" && edge.approachId && !isSafeToCross && !agent.jaywalking) {
      if (agent.waitStartMs === null) agent.waitStartMs = 0;
      agent.waitStartMs += dtMs;
      agent.waitingAtCrossingId = edge.crossingId ?? null;

      const waitS = agent.waitStartMs / 1000;
      const p = jaywalkProbability(waitS, PATIENCE_S) * (dtMs / 1000);
      if (!agent.jaywalking && this.rng() < p) {
        agent.jaywalking = true;
      }

      this.applySteering(agent, this.bodyPosition(agent), [], dtMs); // decelerate toward a stop at the current position
      return;
    }

    if (edge?.kind === "crosswalk" && agent.jaywalking) {
      agent.waitingAtCrossingId = null; // no longer "waiting" — now a live collision risk, per spec §5
    }

    agent.waitStartMs = null;
    if (!agent.jaywalking) agent.waitingAtCrossingId = null;

    const target = this.graph.node(nextId);
    const neighbors = [...this.agents2.values()]
      .filter((other) => other !== agent)
      .map((other) => ({ x: other.body.position.x, y: other.body.position.y }));

    this.applySteering(agent, target, neighbors, dtMs);

    const dist = Math.hypot(target.x - agent.body.position.x, target.y - agent.body.position.y);
    if (dist < 4) {
      agent.lastNodeId = nextId;
      agent.path.shift();
      agent.jaywalking = false;
    }
  }

  private applySteering(agent: Agent, target: { x: number; y: number }, neighbors: { x: number; y: number }[], dtMs: number): void {
    // Direct kinematic velocity update, not an applied Matter force — see VehicleBody.applyInput's
    // comment for why: a force-based version was unstable at this sim's 50ms control cadence (the
    // steering correction overshoots each tick, and the overshoot itself feeds back into next
    // tick's correction). computeSteeringForce's {fx,fy} is treated as a real acceleration
    // (u/s^2), integrated directly into velocity over this tick's duration.
    const v = realVelocity(agent.body);
    const { fx, fy } = computeSteeringForce(
      { x: agent.body.position.x, y: agent.body.position.y, vx: v.x, vy: v.y },
      target,
      neighbors,
      DEFAULT_STEERING_PARAMS
    );
    const dtS = dtMs / 1000;
    const newVx = v.x + fx * dtS;
    const newVy = v.y + fy * dtS;
    Matter.Body.setVelocity(agent.body, { x: newVx / MATTER_VELOCITY_SCALE, y: newVy / MATTER_VELOCITY_SCALE });
  }

  private bodyPosition(agent: Agent): { x: number; y: number } {
    return { x: agent.body.position.x, y: agent.body.position.y };
  }

  getCrossingState(crossingId: string): { queueLength: number; waitS: number } {
    const waiting = [...this.agents2.values()].filter((a) => a.waitingAtCrossingId === crossingId);
    const waits = waiting.map((a) => (a.waitStartMs ?? 0) / 1000);
    return { queueLength: waiting.length, waitS: waits.length ? Math.max(...waits) : 0 };
  }

  isJaywalking(pedId: string): boolean {
    return this.agents2.get(pedId)?.jaywalking ?? false;
  }

  get agents(): PedestrianSnapshot[] {
    return [...this.agents2.values()].map((a) => ({ id: a.id, x: a.body.position.x, y: a.body.position.y }));
  }
}
