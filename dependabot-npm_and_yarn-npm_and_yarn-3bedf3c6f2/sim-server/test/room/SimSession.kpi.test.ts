import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("SimSession KPI snapshots", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kpi-test-"));
    store = new LocalDiskSessionStore(dir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes a KPI snapshot roughly every 10 seconds of simulated time", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 60, 20);
    for (let i = 0; i < 400; i++) await session.step(); // 400 * 50ms = 20s

    const file = store.read(session.sessionId);
    expect(file.kpiSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(file.kpiSnapshots[0]).toHaveProperty("avgVehicleWaitS");
    expect(file.kpiSnapshots[0]).toHaveProperty("avgPedWaitS");
  });

  it("step() returns a kpiUpdate alongside the snapshot and roomEvents whenever a new KPI snapshot is taken", async () => {
    const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 60, 21);
    let sawKpiUpdate = false;
    for (let i = 0; i < 400; i++) {
      const result = await session.step();
      if (result.kpiUpdate) sawKpiUpdate = true;
    }
    expect(sawKpiUpdate).toBe(true);
  });
});
