import { describe, it, expect } from "vitest";
import { SCENARIO_CONFIGS } from "../../src/scoring/scenarios";

describe("SCENARIO_CONFIGS", () => {
  it("defines all four required scenarios", () => {
    expect(Object.keys(SCENARIO_CONFIGS).sort()).toEqual(
      ["chaos", "emergency_vehicle", "pedestrian_pressure", "rush_hour"].sort()
    );
  });

  it("rush_hour elevates both vehicle and pedestrian arrival rates above chaos's baseline vehicle rate", () => {
    expect(SCENARIO_CONFIGS.rush_hour.vehicleArrivalRatePerMin).toBeGreaterThan(SCENARIO_CONFIGS.chaos.vehicleArrivalRatePerMin);
  });

  it("only emergency_vehicle auto-spawns an EV", () => {
    expect(SCENARIO_CONFIGS.emergency_vehicle.autoSpawnEv).toBe(true);
    expect(SCENARIO_CONFIGS.rush_hour.autoSpawnEv).toBe(false);
  });

  it("pedestrian_pressure elevates pedestrian rate well above vehicle rate", () => {
    const cfg = SCENARIO_CONFIGS.pedestrian_pressure;
    expect(cfg.pedestrianArrivalRatePerMin).toBeGreaterThan(cfg.vehicleArrivalRatePerMin);
  });
});
