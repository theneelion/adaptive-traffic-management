import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { SimSession } from "../src/room/SimSession";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDiskSessionStore } from "../src/session/LocalDiskSessionStore";

describe("debug session endpoint", () => {
  let httpServer: ReturnType<typeof createServer>;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    process.env.DEBUG_ENDPOINTS = "1";
    dir = mkdtempSync(path.join(tmpdir(), "debug-endpoint-test-"));
    const store = new LocalDiskSessionStore(dir);
    // Only fake the AI-service call SimSession/SignalController makes internally (to the "http://fake"
    // base URL) — a blanket vi.stubGlobal would also intercept this test's own fetch to the local
    // debug HTTP server below, silently returning the fake AI decision object (no mapId field)
    // instead of a real response. Found only by actually running this test and seeing `res.text`
    // fail (the mock object has no .text method either), not from reading the mock in isolation.
    const realFetch = global.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, ...args: unknown[]) => {
        if (String(url).includes("/signal-decision")) {
          return Promise.resolve({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) } as Response);
        }
        return realFetch(url as any, ...(args as []));
      })
    );
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 60, 1);

    httpServer = createServer((req, res) => {
      if (process.env.DEBUG_ENDPOINTS === "1" && req.url === "/debug/session") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(session.debugReadSession()));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    new WebSocketServer({ server: httpServer }); // present so the server behaves like the real one; unused here
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterAll(() => {
    httpServer.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DEBUG_ENDPOINTS;
    vi.restoreAllMocks();
  });

  it("returns the current session file as JSON", async () => {
    const res = await fetch(`http://localhost:${port}/debug/session`);
    const body = await res.json();
    expect(body.mapId).toBe("grid_1x1_v1");
  });
});
