import type { ServerStateSnapshot } from "shared-contracts/generated/ts/state-snapshot.schema";
import type { ClientInputMessage } from "shared-contracts/generated/ts/client-input.schema";
import type { KpiUpdateMessage } from "shared-contracts/generated/ts/kpi-update.schema";
import type { ScenarioCompleteMessage } from "shared-contracts/generated/ts/scenario-control.schema";
import type { RoomEventMessage } from "shared-contracts/generated/ts/room-events.schema";

export type Scenario = "rush_hour" | "emergency_vehicle" | "chaos" | "pedestrian_pressure";

export class SimClient {
  private readonly socket: WebSocket;
  private stateHandler: ((snapshot: ServerStateSnapshot) => void) | null = null;
  private joinedHandler: ((carId: string) => void) | null = null;
  private kpiHandler: ((payload: KpiUpdateMessage["payload"]) => void) | null = null;
  private scenarioCompleteHandler: ((payload: ScenarioCompleteMessage["payload"]) => void) | null = null;
  private roomEventHandler: ((payload: RoomEventMessage["payload"]) => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "state" && this.stateHandler) this.stateHandler(msg as ServerStateSnapshot);
      if (msg.type === "joined" && "carId" in msg.payload && this.joinedHandler) this.joinedHandler(msg.payload.carId);
      if (msg.type === "kpi_update" && this.kpiHandler) this.kpiHandler(msg.payload);
      if (msg.type === "scenario_complete" && this.scenarioCompleteHandler) this.scenarioCompleteHandler(msg.payload);
      if (msg.type === "room_event" && this.roomEventHandler) this.roomEventHandler(msg.payload);
    };
  }

  onState(cb: (snapshot: ServerStateSnapshot) => void): void {
    this.stateHandler = cb;
  }

  onJoined(cb: (carId: string) => void): void {
    this.joinedHandler = cb;
  }

  onKpiUpdate(cb: (payload: KpiUpdateMessage["payload"]) => void): void {
    this.kpiHandler = cb;
  }

  onScenarioComplete(cb: (payload: ScenarioCompleteMessage["payload"]) => void): void {
    this.scenarioCompleteHandler = cb;
  }

  onRoomEvent(cb: (payload: RoomEventMessage["payload"]) => void): void {
    this.roomEventHandler = cb;
  }

  sendInput(payload: ClientInputMessage["payload"]): void {
    const msg: ClientInputMessage = { type: "input", ts: Date.now(), payload };
    this.socket.send(JSON.stringify(msg));
  }

  sendControllerMode(mode: "rule_based" | "rl"): void {
    this.socket.send(JSON.stringify({ type: "controller_mode", ts: Date.now(), payload: { mode } }));
  }

  sendDebugSpawnEv(originApproachId: string, destinationApproachId: string): void {
    this.socket.send(JSON.stringify({ type: "debug_spawn_ev", ts: Date.now(), payload: { originApproachId, destinationApproachId } }));
  }

  sendStartScenario(scenario: Scenario): void {
    this.socket.send(JSON.stringify({ type: "start_scenario", ts: Date.now(), payload: { scenario } }));
  }
}
