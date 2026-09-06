import { describe, it, expect } from "vitest";
import { scoreScenario } from "../../src/scoring/scoreScenario";
import type { SessionFile } from "../../src/session/SessionEvent";

function baseSession(overrides: Partial<SessionFile>): SessionFile {
  return {
    sessionId: "s1",
    startedAt: new Date(0).toISOString(),
    mapId: "grid_1x1_v1",
    scenario: null,
    participants: [],
    events: [],
    kpiSnapshots: [],
    finalScore: null,
    ...overrides
  };
}

describe("scoreScenario", () => {
  it("rush_hour passes when avg wait stays under threshold", () => {
    const session = baseSession({
      kpiSnapshots: [{ t: 10, avgVehicleWaitS: 10, throughput: 5, avgPedWaitS: 5, jaywalkEvents: 0 }]
    });
    const score = scoreScenario("rush_hour", session);
    expect(score.result).toBe("pass");
  });

  it("rush_hour fails when avg wait exceeds threshold", () => {
    const session = baseSession({
      kpiSnapshots: [{ t: 10, avgVehicleWaitS: 45, throughput: 2, avgPedWaitS: 5, jaywalkEvents: 0 }]
    });
    const score = scoreScenario("rush_hour", session);
    expect(score.result).toBe("fail");
  });

  it("emergency_vehicle passes when ev_preempt fired and transit time is under threshold", () => {
    const session = baseSession({
      events: [
        { t: 0, type: "ev_spawn", evId: "amb_1", route: ["app_N", "int_1", "app_S"] },
        { t: 4, type: "ev_preempt", intersection: "int_1", etaS: 8 },
        { t: 20, type: "ev_complete", evId: "amb_1", transitTimeS: 20 }
      ]
    });
    const score = scoreScenario("emergency_vehicle", session);
    expect(score.result).toBe("pass");
  });

  it("emergency_vehicle fails when no preemption occurred", () => {
    const session = baseSession({
      events: [
        { t: 0, type: "ev_spawn", evId: "amb_1", route: ["app_N", "int_1", "app_S"] },
        { t: 30, type: "ev_complete", evId: "amb_1", transitTimeS: 30 }
      ]
    });
    const score = scoreScenario("emergency_vehicle", session);
    expect(score.result).toBe("fail");
  });

  it("chaos passes when wait rose substantially between the start and end of the run", () => {
    const session = baseSession({
      kpiSnapshots: [
        { t: 10, avgVehicleWaitS: 5, throughput: 5, avgPedWaitS: 3, jaywalkEvents: 0 },
        { t: 20, avgVehicleWaitS: 5, throughput: 5, avgPedWaitS: 3, jaywalkEvents: 0 },
        { t: 80, avgVehicleWaitS: 20, throughput: 2, avgPedWaitS: 3, jaywalkEvents: 0 },
        { t: 90, avgVehicleWaitS: 22, throughput: 2, avgPedWaitS: 3, jaywalkEvents: 0 }
      ]
    });
    const score = scoreScenario("chaos", session);
    expect(score.result).toBe("pass");
  });

  it("chaos passes when at least one collision occurred, even without a large wait increase", () => {
    const session = baseSession({
      kpiSnapshots: [
        { t: 10, avgVehicleWaitS: 5, throughput: 5, avgPedWaitS: 3, jaywalkEvents: 0 },
        { t: 90, avgVehicleWaitS: 5, throughput: 5, avgPedWaitS: 3, jaywalkEvents: 0 }
      ],
      events: [{ t: 45, type: "collision", entities: ["car_1", "car_2"], kind: "vehicle_vehicle" }]
    });
    const score = scoreScenario("chaos", session);
    expect(score.result).toBe("pass");
  });

  it("pedestrian_pressure passes when ped wait stays under threshold", () => {
    const session = baseSession({
      kpiSnapshots: [{ t: 10, avgVehicleWaitS: 8, throughput: 5, avgPedWaitS: 6, jaywalkEvents: 1 }]
    });
    const score = scoreScenario("pedestrian_pressure", session);
    expect(score.result).toBe("pass");
  });
});
