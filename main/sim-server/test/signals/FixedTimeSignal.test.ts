import { describe, it, expect } from "vitest";
import { FixedTimeSignal } from "../../src/signals/FixedTimeSignal";

describe("FixedTimeSignal", () => {
  const phases = [
    { id: "NS_through", allowedDirections: ["N", "S"] as const, durationMs: 8000 },
    { id: "EW_through", allowedDirections: ["E", "W"] as const, durationMs: 8000 }
  ];

  it("starts on the first phase with full duration remaining", () => {
    const signal = new FixedTimeSignal(phases);
    expect(signal.currentPhase.id).toBe("NS_through");
    expect(signal.msRemaining).toBe(8000);
  });

  it("advances to the next phase once duration elapses, wrapping around", () => {
    const signal = new FixedTimeSignal(phases);
    signal.step(8000);
    expect(signal.currentPhase.id).toBe("EW_through");
    signal.step(8000);
    expect(signal.currentPhase.id).toBe("NS_through");
  });
});
