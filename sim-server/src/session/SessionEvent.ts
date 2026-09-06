export interface PhaseChangeEvent {
  t: number;
  type: "phase_change";
  intersection: string;
  phase: string;
  controller: "rule_based" | "rl";
}

export interface UserJoinEvent {
  t: number;
  type: "user_join";
  clientId: string;
  carId: string;
}

export interface UserLeaveEvent {
  t: number;
  type: "user_leave";
  clientId: string;
  carId: string;
}

export interface CollisionEvent {
  t: number;
  type: "collision";
  entities: [string, string];
  kind: "vehicle_vehicle" | "vehicle_pedestrian";
  cause?: "jaywalk";
}

export interface EvSpawnEvent {
  t: number;
  type: "ev_spawn";
  evId: string;
  route: string[];
}

export interface EvPreemptEvent {
  t: number;
  type: "ev_preempt";
  intersection: string;
  etaS: number;
}

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

export interface KpiSnapshot {
  t: number;
  avgVehicleWaitS: number;
  throughput: number;
  avgPedWaitS: number;
  jaywalkEvents: number;
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
