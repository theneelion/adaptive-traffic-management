import { describe, it, expect } from "vitest";
import { computeSteeringForce, DEFAULT_STEERING_PARAMS } from "../../src/pedestrians/steering";

describe("computeSteeringForce", () => {
  it("pushes toward the target when at rest with no neighbors", () => {
    const { fx, fy } = computeSteeringForce({ x: 0, y: 0, vx: 0, vy: 0 }, { x: 10, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    expect(fx).toBeGreaterThan(0);
    expect(fy).toBeCloseTo(0, 5);
  });

  it("slows the desired velocity within the arrival radius", () => {
    // Start already moving at walkSpeed so the comparison isn't masked by both cases saturating
    // identically at maxForce from a resting start (an earlier version of this test did exactly
    // that and failed — both "far" and "near" produced the same clamped force since the raw
    // force needed in either case vastly exceeded maxForce). Approaching a near target should
    // now call for deceleration (negative force) since the arrival-scaled desired speed is far
    // below the current speed; approaching a far target should call for ~no change.
    const movingAtWalkSpeed = { x: 0, y: 0, vx: DEFAULT_STEERING_PARAMS.walkSpeed, vy: 0 };
    const far = computeSteeringForce(movingAtWalkSpeed, { x: 100, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    const near = computeSteeringForce(movingAtWalkSpeed, { x: 1, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    expect(near.fx).toBeLessThan(far.fx);
  });

  it("adds a separation push away from a very close neighbor", () => {
    // Same masking issue as the arrival-radius test above: starting from rest, both the
    // with- and without-neighbor raw pulls vastly exceed maxForce and clamp to the identical
    // +maxForce value, hiding the separation effect entirely. Starting already at the
    // no-neighbor desired velocity makes that baseline case unclamped (fx == 0), so the
    // neighbor's separation push shows up as a genuine (clamped) negative deviation from it.
    const movingAtWalkSpeed = { x: 0, y: 0, vx: DEFAULT_STEERING_PARAMS.walkSpeed, vy: 0 };
    const withoutNeighbor = computeSteeringForce(movingAtWalkSpeed, { x: 100, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    const withNeighbor = computeSteeringForce(
      movingAtWalkSpeed,
      { x: 100, y: 0 },
      [{ x: 2, y: 0 }],
      DEFAULT_STEERING_PARAMS
    );
    expect(withNeighbor.fx).toBeLessThan(withoutNeighbor.fx);
  });

  it("clamps the resulting force to maxForce", () => {
    const { fx, fy } = computeSteeringForce({ x: 0, y: 0, vx: -50, vy: 0 }, { x: 1000, y: 0 }, [], DEFAULT_STEERING_PARAMS);
    expect(Math.hypot(fx, fy)).toBeLessThanOrEqual(DEFAULT_STEERING_PARAMS.maxForce + 1e-9);
  });
});
