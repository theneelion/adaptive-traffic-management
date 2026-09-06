import { describe, it, expect } from "vitest";
import { sampleCenterline } from "../../src/render/roadCenterline";

describe("sampleCenterline", () => {
  it("samples a straight approach evenly along the direct line, with a constant heading", () => {
    const samples = sampleCenterline({ laneStartX: 0, laneStartY: 0, laneEndX: 100, laneEndY: 0 }, 25);
    expect(samples.length).toBeGreaterThanOrEqual(4);
    for (const s of samples) {
      expect(s.y).toBeCloseTo(0, 5);
      expect(s.heading).toBeCloseTo(0, 5);
    }
    expect(samples[0].x).toBeCloseTo(0, 5);
    expect(samples[samples.length - 1].x).toBeCloseTo(100, 0);
  });

  it("samples a curved (waypoint) approach as a smooth, monotonically-progressing curve, not a straight chord", () => {
    const samples = sampleCenterline(
      {
        laneStartX: 700, laneStartY: 250, laneEndX: 400, laneEndY: 0,
        waypoints: [{ x: 700, y: 250 }, { x: 550, y: 40 }, { x: 400, y: 0 }]
      },
      20
    );
    const mid = samples[Math.floor(samples.length / 2)];
    const chordMidX = (700 + 400) / 2;
    const chordMidY = (250 + 0) / 2;
    const deviation = Math.hypot(mid.x - chordMidX, mid.y - chordMidY);
    expect(deviation).toBeGreaterThan(5);
    expect(samples[0].x).toBeCloseTo(700, 0);
    expect(samples[0].y).toBeCloseTo(250, 0);
    expect(samples[samples.length - 1].x).toBeCloseTo(400, 0);
    expect(samples[samples.length - 1].y).toBeCloseTo(0, 0);
  });
});
