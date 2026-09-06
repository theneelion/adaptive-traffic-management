import { describe, it, expect } from "vitest";
import { mulberry32 } from "../../src/util/mulberry32";
import { TrafficSpawner } from "../../src/vehicles/TrafficSpawner";

describe("TrafficSpawner", () => {
  it("spawns roughly arrivalRatePerMin vehicles per approach over one simulated minute, deterministically for a fixed seed", () => {
    const spawner = new TrafficSpawner(["app_N"], mulberry32(1), 12);
    let spawnCount = 0;
    for (let t = 0; t < 60_000; t += 100) spawnCount += spawner.step(100).length;
    expect(spawnCount).toBeGreaterThan(3);
    expect(spawnCount).toBeLessThan(30);
  });

  it("is deterministic for a fixed seed", () => {
    const run = () => {
      const spawner = new TrafficSpawner(["app_N", "app_S"], mulberry32(99), 12);
      const events: string[] = [];
      for (let t = 0; t < 30_000; t += 100) events.push(...spawner.step(100));
      return events;
    };
    expect(run()).toEqual(run());
  });
});
