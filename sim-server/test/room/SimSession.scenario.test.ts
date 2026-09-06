import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("SimSession scenarios", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "scenario-test-"));
    store = new LocalDiskSessionStore(dir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("starting emergency_vehicle auto-spawns an EV", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 30, 10);
    session.startScenario("emergency_vehicle");
    const { snapshot } = await session.step();
    expect(snapshot.payload.vehicles.some((v) => v.controller === "ev")).toBe(true);
  });

  it("starting a scenario retags the session file with that scenario", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 30, 11);
    session.startScenario("rush_hour");
    expect(store.read(session.sessionId).scenario).toBe("rush_hour");
  });
});
