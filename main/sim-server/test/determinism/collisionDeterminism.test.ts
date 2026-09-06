import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimSession } from "../../src/room/SimSession";
import { LocalDiskSessionStore } from "../../src/session/LocalDiskSessionStore";

async function runAndCollectCollisionEvents(seed: number, dir: string): Promise<unknown[]> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ phaseId: "NS_through", controller: "rule_based" }) })
  );
  const store = new LocalDiskSessionStore(dir);
  const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 300, seed);
  for (let i = 0; i < 2000; i++) await session.step();
  const file = store.read(session.sessionId);
  vi.restoreAllMocks();
  return file.events.filter((e) => e.type === "collision");
}

describe("physics determinism", () => {
  it("produces identical collision event sequences run-to-run given the same seed and inputs", async () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "determinism-a-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "determinism-b-"));

    const eventsA = await runAndCollectCollisionEvents(1234, dirA);
    const eventsB = await runAndCollectCollisionEvents(1234, dirB);

    expect(eventsA).toEqual(eventsB);

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});
