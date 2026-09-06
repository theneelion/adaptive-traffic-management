import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("LocalDiskSessionStore", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "session-store-test-"));
    store = new LocalDiskSessionStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a session file with the §8 schema shape (snake_case on disk)", () => {
    store.create("sess_1", { mapId: "grid_1x1_v1", scenario: null });
    const file = store.read("sess_1");
    expect(file.sessionId).toBe("sess_1");
    expect(file.mapId).toBe("grid_1x1_v1");
    expect(file.events).toEqual([]);
  });

  it("appends events and kpi snapshots, persisted across reads", () => {
    store.create("sess_1", { mapId: "grid_1x1_v1", scenario: null });
    store.writeEvent("sess_1", { t: 1.2, type: "phase_change", intersection: "int_1", phase: "EW_through", controller: "rule_based" });
    store.writeKpiSnapshot("sess_1", { t: 60, avgVehicleWaitS: 4.2, throughput: 12, avgPedWaitS: 0, jaywalkEvents: 0 });

    const file = store.read("sess_1");
    expect(file.events).toHaveLength(1);
    expect(file.kpiSnapshots).toHaveLength(1);
  });

  it("finalize sets final_score and later reads reflect it", () => {
    store.create("sess_1", { mapId: "grid_1x1_v1", scenario: "rush_hour" });
    store.finalize("sess_1", { scenario: "rush_hour", result: "pass", avgWaitDeltaPct: 8.3 });

    expect(store.read("sess_1").finalScore).toEqual({ scenario: "rush_hour", result: "pass", avgWaitDeltaPct: 8.3 });
  });

  it("throws when reading a session that was never created", () => {
    expect(() => store.read("does_not_exist")).toThrow();
  });
});
