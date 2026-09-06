import { PhysicsWorld } from "../physics/PhysicsWorld.js";
import { loadMap } from "../maps/loadMap.js";
import { isTerminalApproach, type MapDefinition } from "../maps/MapDefinition.js";
import { TrafficController } from "../vehicles/TrafficController.js";
import { RoomManager } from "./RoomManager.js";
import { QueueDetector } from "../signals/QueueDetector.js";
import { AiSignalClient } from "../signals/AiSignalClient.js";
import { SignalController } from "../signals/SignalController.js";
import { CollisionLogger } from "../physics/CollisionLogger.js";
import { PedestrianGraph } from "../pedestrians/PedestrianGraph.js";
import { PedestrianController } from "../pedestrians/PedestrianController.js";
import { EvRouter } from "../ev/EvRouter.js";
import { buildRoadGraph } from "../ev/RoadGraph.js";
import { realSpeed } from "../physics/realSpeed.js";
import { LocalDiskSessionStore } from "../session/LocalDiskSessionStore.js";
import type { SessionStore } from "../session/SessionStore.js";
import type { SessionFile, KpiSnapshot } from "../session/SessionEvent.js";
import type { ServerStateSnapshot } from "shared-contracts/generated/ts/state-snapshot.schema";
import type { RoomEventMessage } from "shared-contracts/generated/ts/room-events.schema";
import type { KpiUpdateMessage } from "shared-contracts/generated/ts/kpi-update.schema";
import type { ScenarioCompleteMessage } from "shared-contracts/generated/ts/scenario-control.schema";
import { mulberry32 } from "../util/mulberry32.js";
import { randomUUID } from "node:crypto";
import { SCENARIO_CONFIGS, type Scenario } from "../scoring/scenarios.js";
import { scoreScenario } from "../scoring/scoreScenario.js";

const TICK_MS = 50;
const MAX_HUMAN_CARS = 4;
const DISCONNECT_GRACE_MS = 3000;
const IDM_PARAMS = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 36 };
const KPI_SNAPSHOT_INTERVAL_MS = 10_000;
// Spec §7.3: how far ahead (in EV ETA seconds) SimSession starts forcing an upcoming intersection's
// signal toward the EV's required phase. A starting value, not yet empirically tuned against a
// real multi-intersection city map (Stage 3's job) — 8s gives some margin over typical
// yellow+all-red clearance time (4.5s total) at the EV's real cruise speed.
const EV_PREEMPT_THRESHOLD_S = 8;

type SignalLightState = "green" | "yellow" | "red";

export class SimSession {
  readonly sessionId = randomUUID();
  private readonly world: PhysicsWorld;
  private readonly mapDef: MapDefinition;
  private readonly traffic: TrafficController;
  private readonly pedestrians: PedestrianController;
  private readonly evRouter: EvRouter;
  private readonly room: RoomManager;
  private readonly detector: QueueDetector;
  private readonly signalControllers = new Map<string, SignalController>();
  private readonly forcedIntersections = new Set<string>();
  private readonly store: SessionStore;
  private readonly mapId: string;
  private pendingRoomEvents: RoomEventMessage[] = [];
  private tick = 0;
  private activeScenario: Scenario | null = null;
  private scenarioElapsedS = 0;
  private kpiElapsedMs = 0;
  private cumulativeJaywalkEvents = 0;
  private lastControllerMode: "rule_based" | "rl" = "rule_based";
  private evSpawnTick: number | null = null;

  constructor(
    mapPath: string,
    sessionStore: SessionStore | undefined,
    aiServiceUrl: string,
    arrivalRatePerMin: number,
    rngSeed: number
  ) {
    const map = loadMap(mapPath);
    this.mapDef = map;
    this.mapId = map.id;
    this.world = new PhysicsWorld(map);
    this.detector = new QueueDetector(this.world, map.approaches);
    this.traffic = new TrafficController(this.world, map, IDM_PARAMS, mulberry32(rngSeed), arrivalRatePerMin, () => {});
    // "far_" prefix is the map-authoring convention for pedestrian terminal spawn/despawn points
    // (grid_1x1_v1.json's far_N/S/E/W already follow it, and city_v1.json's own far_<approachId>
    // nodes do too) — any map that follows the convention gets real pedestrian spawning; a map
    // with no pedestrian graph yet (fixture_curved_3int.json) still safely yields an empty list
    // instead of crashing on an unknown node id.
    const pedestrianFarNodeIds = map.pedestrianNodes.filter((n) => n.id.startsWith("far_")).map((n) => n.id);
    this.pedestrians = new PedestrianController(
      this.world,
      new PedestrianGraph(map.pedestrianNodes, map.pedestrianEdges),
      pedestrianFarNodeIds,
      mulberry32(rngSeed + 1),
      20
    );
    this.evRouter = new EvRouter(this.world, map);
    const roadGraph = buildRoadGraph(map);

    for (const intersection of map.intersections) {
      const ownApproaches = map.approaches.filter((a) => a.intersectionId === intersection.id);
      const crossingIdsByApproach: Record<string, string> = {};
      for (const edge of map.pedestrianEdges) {
        if (edge.kind === "crosswalk" && edge.approachId && edge.crossingId && ownApproaches.some((a) => a.id === edge.approachId)) {
          crossingIdsByApproach[edge.approachId] = edge.crossingId;
        }
      }
      this.signalControllers.set(
        intersection.id,
        new SignalController(
          intersection.phases,
          ownApproaches,
          new AiSignalClient(aiServiceUrl),
          this.detector,
          intersection.id,
          (crossingId) => this.pedestrians.getCrossingState(crossingId),
          crossingIdsByApproach,
          "rule_based",
          () => {
            const vehicle = this.evRouter.activeVehicle();
            if (!vehicle) return null;
            const etaS = this.evRouter.etaToIntersection(vehicle.id, intersection.id);
            if (etaS === null) return null;
            const requiredPhaseId = this.evRouter.upcomingStops(vehicle.id).find((s) => s.intersectionId === intersection.id)?.phaseId;
            if (!requiredPhaseId) return null;
            return { evId: vehicle.id, etaS, requiredPhaseId };
          },
          () =>
            roadGraph
              .neighborsOf(intersection.id)
              .map((id) => this.signalControllers.get(id))
              .filter((c): c is SignalController => c !== undefined)
              .map((c) => ({
                intersectionId: c.id,
                currentPhaseId: c.currentPhaseId,
                timeInPhaseMs: c.timeInPhaseMs,
                totalPressure: map.approaches
                  .filter((a) => a.intersectionId === c.id)
                  .reduce((sum, a) => {
                    const state = this.detector.getApproachState(a.id);
                    return sum + state.queueLength + state.waitS;
                  }, 0)
              }))
        )
      );
    }

    this.room = new RoomManager(() => this.traffic.claimableVehicle(), MAX_HUMAN_CARS, DISCONNECT_GRACE_MS);
    this.store = sessionStore ?? new LocalDiskSessionStore(process.env.SESSION_STORE_DIR ?? "./sessions");
    this.store.create(this.sessionId, { mapId: this.mapId, scenario: null });

    new CollisionLogger(this.world, (entities, kind) => {
      const cause = kind === "vehicle_pedestrian" && this.pedestrians.isJaywalking(entities[1]) ? "jaywalk" : undefined;
      if (cause === "jaywalk") this.cumulativeJaywalkEvents += 1;
      this.store.writeEvent(this.sessionId, {
        t: this.tick * (TICK_MS / 1000),
        type: "collision",
        entities,
        kind,
        ...(cause ? { cause } : {})
      });
      this.pendingRoomEvents.push({
        type: "room_event",
        ts: Date.now(),
        payload: { kind: "collision", entities, collisionKind: kind }
      });
    });
  }

  join(clientId: string): { carId: string } | { error: "capacity_reached" } {
    const result = this.room.join(clientId);
    if ("carId" in result) {
      this.store.writeEvent(this.sessionId, { t: this.tick * (TICK_MS / 1000), type: "user_join", clientId, carId: result.carId });
      this.pendingRoomEvents.push({ type: "room_event", ts: Date.now(), payload: { kind: "user_join", clientId, carId: result.carId } });
    }
    return result;
  }

  leave(clientId: string): void {
    this.room.leave(clientId);
  }

  debugReadSession(): SessionFile {
    return this.store.read(this.sessionId);
  }

  setControllerMode(mode: "rule_based" | "rl"): void {
    for (const controller of this.signalControllers.values()) controller.setRequestedController(mode);
  }

  startScenario(scenario: Scenario): void {
    const config = SCENARIO_CONFIGS[scenario];
    this.traffic.setArrivalRate(config.vehicleArrivalRatePerMin);
    this.pedestrians.setArrivalRate(config.pedestrianArrivalRatePerMin);
    this.activeScenario = scenario;
    this.scenarioElapsedS = 0;
    this.store.create(this.sessionId, { mapId: this.mapId, scenario }); // re-tag the session with the chosen scenario
    if (config.autoSpawnEv) {
      // Generalizes the old hardcoded "app_N"/"app_S" (grid_1x1_v1.json-only approach IDs, which
      // don't exist on any other map) to any map: pick the two terminal approaches farthest apart,
      // giving a real cross-network demo route regardless of the map's own naming/topology.
      const terminals = this.mapDef.approaches.filter((a) => isTerminalApproach(this.mapDef, a));
      let best: { a: string; b: string; dist: number } | null = null;
      for (const a of terminals) {
        for (const b of terminals) {
          if (a.id === b.id) continue;
          const dist = Math.hypot(a.laneStartX - b.laneStartX, a.laneStartY - b.laneStartY);
          if (!best || dist > best.dist) best = { a: a.id, b: b.id, dist };
        }
      }
      if (best) this.spawnEmergencyVehicle(best.a, best.b);
    }
  }

  spawnEmergencyVehicle(originApproachId: string, destinationApproachId: string): { evId: string } | { error: string } {
    const result = this.evRouter.spawn(originApproachId, destinationApproachId, this.traffic.vehicles);
    if ("evId" in result) {
      this.evSpawnTick = this.tick;
      this.store.writeEvent(this.sessionId, {
        t: this.tick * (TICK_MS / 1000),
        type: "ev_spawn",
        evId: result.evId,
        route: [originApproachId, destinationApproachId]
      });
      // Also broadcast to connected clients (the disk-log write above is for the session
      // replay/scoring file, a separate concern from live UI feedback) — the frontend's real-time
      // analytics panel surfaces this the moment it happens, not just after the fact from a log.
      this.pendingRoomEvents.push({
        type: "room_event",
        ts: Date.now(),
        payload: { kind: "ev_spawn", evId: result.evId, route: [originApproachId, destinationApproachId] }
      });
    }
    return result;
  }

  applyInput(clientId: string, carId: string, throttle: number, brake: number, steer: number): void {
    if (this.room.ownerOf(carId) !== clientId) return; // not this client's car — ignore
    const vehicle = this.traffic.vehicles.find((v) => v.id === carId);
    vehicle?.applyInput(throttle, brake, steer, TICK_MS);
  }

  async step(): Promise<{
    snapshot: ServerStateSnapshot;
    roomEvents: RoomEventMessage[];
    kpiUpdate: KpiUpdateMessage | null;
    scenarioCompleteMessage: ScenarioCompleteMessage | null;
  }> {
    this.world.step(TICK_MS);
    this.detector.step(TICK_MS, this.traffic.vehicles);
    this.room.step(TICK_MS);

    const approachSignalStates = new Map<string, SignalLightState>();
    const phaseByIntersection = new Map<string, string>();
    for (const [intersectionId, controller] of this.signalControllers) {
      const { phaseId, controller: usedController } = await controller.step(TICK_MS);
      phaseByIntersection.set(intersectionId, phaseId);
      this.lastControllerMode = usedController === "rl" ? "rl" : "rule_based";
      for (const [approachId, state] of controller.getApproachSignalStates()) {
        approachSignalStates.set(approachId, state);
      }
    }

    this.traffic.step(TICK_MS, approachSignalStates, this.evRouter.activeVehicle(), this.pedestrians.agents);
    this.pedestrians.step(TICK_MS, approachSignalStates);

    const evBefore = this.evRouter.activeVehicle();
    this.evRouter.step(TICK_MS, this.traffic.vehicles, this.pedestrians.agents);
    this.tick += 1;

    if (evBefore && !this.evRouter.activeVehicle()) {
      const transitTimeS = this.tick * (TICK_MS / 1000) - (this.evSpawnTick ?? 0) * (TICK_MS / 1000);
      this.store.writeEvent(this.sessionId, {
        t: this.tick * (TICK_MS / 1000),
        type: "ev_complete",
        evId: evBefore.id,
        transitTimeS
      });
      this.pendingRoomEvents.push({
        type: "room_event",
        ts: Date.now(),
        payload: { kind: "ev_complete", evId: evBefore.id, transitTimeS }
      });
      this.evSpawnTick = null;
    }

    // Green-wave preemption (spec §7.3): every intersection still ahead of the active EV, within
    // EV_PREEMPT_THRESHOLD_S of its own ETA, gets forced toward the EV's required phase — a hard,
    // deterministic override independent of whichever controller (rule-based/RL) would otherwise
    // decide. Once an intersection drops out of that window (EV has passed it, or it's no longer
    // active), its forced phase clears and normal adaptive control resumes immediately.
    const evVehicle = this.evRouter.activeVehicle();
    if (evVehicle) {
      const upcoming = this.evRouter.upcomingStops(evVehicle.id);
      const withinThreshold = new Set(upcoming.filter((s) => s.etaS < EV_PREEMPT_THRESHOLD_S).map((s) => s.intersectionId));

      for (const stop of upcoming) {
        if (!withinThreshold.has(stop.intersectionId) || stop.phaseId === null) continue;
        if (!this.forcedIntersections.has(stop.intersectionId)) {
          this.forcedIntersections.add(stop.intersectionId);
          this.store.writeEvent(this.sessionId, {
            t: this.tick * (TICK_MS / 1000),
            type: "ev_preempt",
            intersection: stop.intersectionId,
            etaS: stop.etaS
          });
          this.pendingRoomEvents.push({
            type: "room_event",
            ts: Date.now(),
            payload: { kind: "ev_preempt", intersectionId: stop.intersectionId, etaS: stop.etaS }
          });
        }
        this.signalControllers.get(stop.intersectionId)!.forcePhase(stop.phaseId);
      }
      for (const intersectionId of [...this.forcedIntersections]) {
        if (!withinThreshold.has(intersectionId)) {
          this.forcedIntersections.delete(intersectionId);
          this.signalControllers.get(intersectionId)!.clearForcedPhase();
        }
      }
    } else if (this.forcedIntersections.size > 0) {
      for (const intersectionId of this.forcedIntersections) this.signalControllers.get(intersectionId)!.clearForcedPhase();
      this.forcedIntersections.clear();
    }

    const roomEvents = this.pendingRoomEvents;
    this.pendingRoomEvents = [];

    const allVehicles = [...this.traffic.vehicles];
    if (evVehicle) allVehicles.push(evVehicle);

    this.kpiElapsedMs += TICK_MS;
    let kpiUpdate: KpiUpdateMessage | null = null;
    if (this.kpiElapsedMs >= KPI_SNAPSHOT_INTERVAL_MS) {
      this.kpiElapsedMs = 0;
      const approachStates = this.mapDef.approaches.map((a) => this.detector.getApproachState(a.id));
      const avgVehicleWaitS = approachStates.reduce((sum, s) => sum + s.waitS, 0) / approachStates.length;
      const throughput = this.traffic.vehicles.length; // current count as a simple proxy — see Phase 10 plan Risks
      const crossingIds = [
        ...new Set(this.mapDef.pedestrianEdges.filter((e) => e.kind === "crosswalk" && e.crossingId).map((e) => e.crossingId!))
      ];
      const crossingStates = crossingIds.map((id) => this.pedestrians.getCrossingState(id));
      const avgPedWaitS = crossingStates.length ? crossingStates.reduce((sum, s) => sum + s.waitS, 0) / crossingStates.length : 0;

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

    let scenarioCompleteMessage: ScenarioCompleteMessage | null = null;
    if (this.activeScenario) {
      this.scenarioElapsedS += TICK_MS / 1000;
      if (this.scenarioElapsedS >= SCENARIO_CONFIGS[this.activeScenario].durationS) {
        const finalScore = scoreScenario(this.activeScenario, this.store.read(this.sessionId));
        this.store.finalize(this.sessionId, finalScore);
        scenarioCompleteMessage = {
          type: "scenario_complete",
          ts: Date.now(),
          payload: { scenario: finalScore.scenario, result: finalScore.result, avgWaitDeltaPct: finalScore.avgWaitDeltaPct }
        };
        this.activeScenario = null;
      }
    }

    return {
      snapshot: {
        type: "state",
        ts: Date.now(),
        payload: {
          tick: this.tick,
          pedestrians: this.pedestrians.agents.map((p) => ({ id: p.id, x: p.x, y: p.y })),
          vehicles: allVehicles.map((v) => ({
            id: v.id,
            x: v.body.position.x,
            y: v.body.position.y,
            heading: v.body.angle,
            speed: realSpeed(v.body),
            controller: v.controller
          })),
          signals: [...this.signalControllers.entries()].map(([intersectionId, controller]) => {
            const states = controller.getApproachSignalStates();
            const firstApproachId = [...states.keys()][0];
            return {
              intersectionId,
              phase: phaseByIntersection.get(intersectionId)!,
              msRemainingMin: Math.max(0, 4000 - controller.timeInPhaseMs),
              light: firstApproachId ? states.get(firstApproachId)! : "red"
            };
          })
        }
      },
      roomEvents,
      kpiUpdate,
      scenarioCompleteMessage
    };
  }
}
