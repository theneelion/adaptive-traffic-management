import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("SimSession", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "simsession-test-"));
    store = new LocalDiskSessionStore(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("allows up to MAX_HUMAN_CARS clients to join, then reports capacity_reached", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 120, 1);

    for (let i = 0; i < 200; i++) await session.step();

    const results = [session.join("c1"), session.join("c2"), session.join("c3"), session.join("c4")];
    for (const r of results) expect(r).toHaveProperty("carId");

    const fifth = session.join("c5");
    expect(fifth).toEqual({ error: "capacity_reached" });
  });

  it("records a user_join event in the session file", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 120, 2);
    for (let i = 0; i < 200; i++) await session.step();

    session.join("c1");
    await session.step();

    const file = store.read(session.sessionId);
    expect(file.events.some((e) => e.type === "user_join")).toBe(true);
  });

  it("ignores input from a client that does not own the target car", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 120, 3);
    for (let i = 0; i < 200; i++) await session.step();
    session.join("c1");

    expect(() => session.applyInput("attacker", "some_car_id", 1, 0, 0)).not.toThrow();
  });

  it("forwards a controller mode change to SignalController", async () => {
    // SignalController only calls the AI client once per accumulated 1500ms decision interval
    // (Phase 2), not on every 50ms tick — a single session.step() call right after
    // setControllerMode wouldn't yet have triggered any fetch call at all. Step enough ticks
    // (40 x 50ms = 2000ms > 1500ms) to guarantee at least one decision request goes out.
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 120, 4);
    session.setControllerMode("rl");
    for (let i = 0; i < 40; i++) await session.step();
    const sentRequest = (global.fetch as any).mock.calls.at(-1)[1];
    const body = JSON.parse(sentRequest.body);
    expect(body.requestedController).toBe("rl");
  });

  it("spawning an EV logs ev_spawn and the EV appears in the state snapshot", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 60, 7);
    const result = session.spawnEmergencyVehicle("app_N", "app_S");
    expect(result).toHaveProperty("evId");

    const { snapshot } = await session.step();
    expect(snapshot.payload.vehicles.some((v) => v.controller === "ev")).toBe(true);

    const file = store.read(session.sessionId);
    expect(file.events.some((e) => e.type === "ev_spawn")).toBe(true);
  });
});
