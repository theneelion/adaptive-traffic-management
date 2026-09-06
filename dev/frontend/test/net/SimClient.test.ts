import { describe, it, expect, vi } from "vitest";
import { SimClient } from "../../src/net/SimClient";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
}

describe("SimClient", () => {
  it("invokes onState callback when a state message arrives", () => {
    // @ts-expect-error test override
    global.WebSocket = FakeWebSocket;
    const client = new SimClient("ws://localhost:8080");
    const cb = vi.fn();
    client.onState(cb);

    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onmessage?.({ data: JSON.stringify({ type: "state", ts: 1, payload: { tick: 1, vehicles: [], signals: [], pedestrians: [] } }) });

    expect(cb).toHaveBeenCalledOnce();
  });

  it("sends a well-formed input message", () => {
    // @ts-expect-error test override
    global.WebSocket = FakeWebSocket;
    const client = new SimClient("ws://localhost:8080");
    client.sendInput({ carId: "car_1", throttle: 1, brake: 0, steer: 0, inputMethod: "keyboard" });

    const ws = FakeWebSocket.instances.at(-1)!;
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("input");
    expect(sent.payload.carId).toBe("car_1");
  });
});
