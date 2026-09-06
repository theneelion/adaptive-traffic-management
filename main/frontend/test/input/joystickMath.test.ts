import { describe, it, expect } from "vitest";
import { computeJoystickOutput } from "../../src/input/joystickMath";

describe("computeJoystickOutput", () => {
  it("returns all zeros at the origin", () => {
    expect(computeJoystickOutput(0, 0, 60)).toEqual({ throttle: 0, brake: 0, steer: 0 });
  });

  it("maps upward drag to throttle only", () => {
    const out = computeJoystickOutput(0, -30, 60);
    expect(out.throttle).toBeCloseTo(0.5, 5);
    expect(out.brake).toBe(0);
  });

  it("maps downward drag to brake only", () => {
    const out = computeJoystickOutput(0, 45, 60);
    expect(out.brake).toBeCloseTo(0.75, 5);
    expect(out.throttle).toBe(0);
  });

  it("maps rightward drag to positive steer, clamped to [-1, 1]", () => {
    expect(computeJoystickOutput(90, 0, 60).steer).toBe(1);
    expect(computeJoystickOutput(-90, 0, 60).steer).toBe(-1);
    expect(computeJoystickOutput(30, 0, 60).steer).toBeCloseTo(0.5, 5);
  });
});
