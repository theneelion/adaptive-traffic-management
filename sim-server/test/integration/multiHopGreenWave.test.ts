import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

describe("multi-hop EV green wave on fixture_curved_3int.json", () => {
  let dir: string;
  let store: LocalDiskSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "greenwave-test-"));
    store = new LocalDiskSessionStore(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "p1", controller: "rule_based" }) })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("preempts both int_B and int_C, in order, as the EV crosses the whole route", async () => {
    // A negligible background arrival rate isolates the green-wave mechanism itself — general
    // multi-vehicle capacity/congestion on this synthetic engine-only fixture is Stage 3's job
    // (spec §10, validated against the real city map), not this proof's concern. EvRouter has no
    // leader-following/collision-avoidance logic (a pre-existing limitation, unchanged by Stage 2 —
    // confirmed by tracing a real physical stall against default traffic before writing this test),
    // so a busy fixture can physically jam the EV's own lane; that's a real, separate concern this
    // test deliberately avoids conflating with the preemption logic it's actually proving.
    const session = new SimSession("../../maps/fixture_curved_3int.json", store, "http://fake", 0.001, 1);
    const result = session.spawnEmergencyVehicle("b_far_north", "c_far_east");
    expect(result).toHaveProperty("evId");

    for (let i = 0; i < 1200; i++) {
      await session.step();
    }

    const file = store.read(session.sessionId);
    const preemptEvents = file.events.filter((e) => e.type === "ev_preempt") as { intersection: string }[];
    const preemptedIntersections = preemptEvents.map((e) => e.intersection);

    expect(preemptedIntersections).toContain("int_B");
    expect(preemptedIntersections).toContain("int_C");
    expect(preemptedIntersections.indexOf("int_B")).toBeLessThan(preemptedIntersections.indexOf("int_C"));

    expect(file.events.some((e) => e.type === "ev_complete")).toBe(true);
  });
});
