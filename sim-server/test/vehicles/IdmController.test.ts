import { describe, it, expect } from "vitest";
import { idmAcceleration, type IdmParams } from "../../src/vehicles/IdmController";

const params: IdmParams = { v0: 15, T: 1.5, aMax: 1.5, b: 2.0, delta: 4, s0: 2, vehicleLength: 4 };

describe("idmAcceleration", () => {
  it("accelerates toward v0 with no leader", () => {
    const a = idmAcceleration({ speed: 0, position: 0 }, null, params);
    expect(a).toBeCloseTo(params.aMax, 5);
  });

  it("returns ~0 acceleration once at desired speed with no leader", () => {
    const a = idmAcceleration({ speed: params.v0, position: 0 }, null, params);
    expect(a).toBeCloseTo(0, 5);
  });

  it("brakes when a slower leader is too close", () => {
    const self = { speed: 15, position: 0 };
    const leader = { speed: 5, position: 6 };
    const a = idmAcceleration(self, leader, params);
    expect(a).toBeLessThan(0);
  });
});
