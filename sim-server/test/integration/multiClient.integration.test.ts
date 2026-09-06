// Requires: `ai-service` running on :8000 and `sim-server` built+running on :8080
// (docker compose -f infra/docker-compose.yml up), or run manually.
import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";

const SIM_URL = process.env.SIM_SERVER_URL ?? "ws://localhost:8080";

function connectAndAwaitJoin(): Promise<any> {
  // The "joined" message listener must be attached before (or at latest, synchronously with)
  // socket creation — the server sends "joined" immediately on connection, and on a fast
  // localhost round-trip it can arrive before an `await`-delayed listener registration ever
  // happens, silently dropping the message (EventEmitters don't replay past events to late
  // listeners). Attaching the listener in the same synchronous tick as `new WebSocket(...)`
  // avoids that race entirely.
  return new Promise((resolve) => {
    const socket = new WebSocket(SIM_URL);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "joined") resolve({ socket, msg });
    });
  });
}

describe.skipIf(!process.env.RUN_INTEGRATION)("multi-client room join/leave/claim (integration)", () => {
  it("two clients joining receive distinct car ids and each other's join events", async () => {
    const [{ socket: clientA, msg: joinedA }, { socket: clientB, msg: joinedB }] = await Promise.all([
      connectAndAwaitJoin(),
      connectAndAwaitJoin()
    ]);

    expect(joinedA.payload.carId).toBeDefined();
    expect(joinedB.payload.carId).toBeDefined();
    expect(joinedA.payload.carId).not.toBe(joinedB.payload.carId);

    clientA.close();
    clientB.close();
  }, 15000);
});
