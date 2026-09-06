import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { SimSession } from "./room/SimSession.js";
import type { ClientInputMessage } from "shared-contracts/generated/ts/client-input.schema";
import type { ControllerModeMessage } from "shared-contracts/generated/ts/controller-mode.schema";
import type { StartScenarioMessage } from "shared-contracts/generated/ts/scenario-control.schema";

const PORT = Number(process.env.PORT ?? 8080);
const session = new SimSession(
  "../../maps/city_v1.json",
  undefined,
  process.env.AI_SERVICE_URL ?? "http://localhost:8000",
  // 30 previously; retuned to 15 alongside MAX_VEHICLES_PER_APPROACH's 8 -> 5 -> 3 drop in
  // TrafficController.ts — 30 saturated the network almost immediately and stayed congested
  // indefinitely (verified against the real ai-service, not a mock). See scenarios.ts's own
  // comment for the same retuning applied to the scenario configs.
  Number(process.env.ARRIVAL_RATE_PER_MIN ?? 15),
  Number(process.env.SIM_RNG_SEED ?? Date.now())
);

// Deployed as a single Fly.io app that also serves the built frontend (see infra/fly/) — only two
// apps are deployed total, not three, per spec §10's own suggestion.
const FRONTEND_DIST = path.resolve(import.meta.dirname, "../../frontend/dist");
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png"
};

const httpServer = createServer((req, res) => {
  if (process.env.DEBUG_ENDPOINTS === "1" && req.url === "/debug/session") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(session.debugReadSession()));
    return;
  }

  const requestedPath = req.url === "/" || !req.url ? "/index.html" : req.url;
  const filePath = path.join(FRONTEND_DIST, requestedPath);
  // filePath.startsWith(FRONTEND_DIST) guards against a `..`-traversal request escaping the dist
  // directory, now that this server accepts arbitrary request paths.
  if (existsSync(FRONTEND_DIST) && existsSync(filePath) && filePath.startsWith(FRONTEND_DIST)) {
    res.setHeader("Content-Type", MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream");
    res.end(readFileSync(filePath));
    return;
  }

  res.statusCode = 404;
  res.end();
});
const wss = new WebSocketServer({ server: httpServer });
const socketsByClientId = new Map<string, import("ws").WebSocket>();

wss.on("connection", (socket) => {
  const clientId = randomUUID();
  socketsByClientId.set(clientId, socket);
  const joinResult = session.join(clientId);
  socket.send(JSON.stringify({ type: "joined", ts: Date.now(), payload: joinResult }));

  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as
      | ClientInputMessage
      | ControllerModeMessage
      | StartScenarioMessage
      | { type: "debug_spawn_ev"; payload: { originApproachId?: string; destinationApproachId?: string } };
    if (msg.type === "input") {
      session.applyInput(clientId, msg.payload.carId, msg.payload.throttle, msg.payload.brake, msg.payload.steer);
    } else if (msg.type === "controller_mode") {
      session.setControllerMode(msg.payload.mode);
    } else if (msg.type === "debug_spawn_ev") {
      session.spawnEmergencyVehicle(msg.payload.originApproachId ?? "app_N", msg.payload.destinationApproachId ?? "app_S");
    } else if (msg.type === "start_scenario") {
      session.startScenario(msg.payload.scenario);
    }
  });

  socket.on("close", () => {
    session.leave(clientId);
    socketsByClientId.delete(clientId);
  });
});

setInterval(async () => {
  // A safety net, not the primary fix: SignalController.step already catches ai-service failures
  // internally (falls back to holding the current phase) so this shouldn't normally trigger. It
  // exists so that ANY future unexpected error in the tick pipeline logs and skips one tick rather
  // than crashing the whole process for every connected client — one bad tick taking down an
  // entire live session (found directly: a single unhandled ai-service fetch rejection here was
  // enough to kill the server outright) is worse than a single dropped 50ms frame.
  try {
    const { snapshot, roomEvents, kpiUpdate, scenarioCompleteMessage } = await session.step();
    const statePayload = JSON.stringify(snapshot);
    for (const socket of socketsByClientId.values()) {
      if (socket.readyState === socket.OPEN) socket.send(statePayload);
    }
    for (const event of roomEvents) {
      const payload = JSON.stringify(event);
      for (const socket of socketsByClientId.values()) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
    if (kpiUpdate) {
      const payload = JSON.stringify(kpiUpdate);
      for (const socket of socketsByClientId.values()) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
    if (scenarioCompleteMessage) {
      const payload = JSON.stringify(scenarioCompleteMessage);
      for (const socket of socketsByClientId.values()) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
  } catch (err) {
    console.error("[tick] unexpected error, skipping this tick:", err);
  }
}, 50);

httpServer.listen(PORT, () => {
  console.log(`sim-server listening on :${PORT}`);
});
