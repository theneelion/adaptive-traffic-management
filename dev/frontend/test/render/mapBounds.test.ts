import { describe, it, expect } from "vitest";
import { computeMapBounds, computeCameraFit } from "../../src/render/mapBounds";

describe("computeMapBounds", () => {
  it("covers intersections, approach endpoints, waypoints, and pedestrian nodes", () => {
    const map = {
      intersections: [{ x: 0, y: 0 }, { x: 100, y: 50 }],
      approaches: [
        { laneStartX: -200, laneStartY: 0, laneEndX: 0, laneEndY: 0 },
        { laneStartX: 100, laneStartY: 50, laneEndX: 300, laneEndY: 200, waypoints: [{ x: 100, y: 50 }, { x: 250, y: -80 }, { x: 300, y: 200 }] }
      ],
      pedestrianNodes: [{ x: -10, y: 400 }]
    };
    const bounds = computeMapBounds(map);
    expect(bounds).toEqual({ minX: -200, maxX: 300, minY: -80, maxY: 400 });
  });
});

describe("computeCameraFit", () => {
  it("fits a square bounding box into a square canvas with margin, centered on its middle", () => {
    const bounds = { minX: -350, maxX: 350, minY: -350, maxY: 350 };
    const fit = computeCameraFit(bounds, 800, 800, 0.1);
    expect(fit.centerX).toBe(0);
    expect(fit.centerY).toBe(0);
    expect(fit.zoom).toBeCloseTo(800 / 770, 3);
  });

  it("fits a wider-than-tall bounding box by the constraining (width) axis", () => {
    const bounds = { minX: -551, maxX: 1200, minY: -593, maxY: 560 };
    const fit = computeCameraFit(bounds, 800, 800, 0.1);
    const width = 1751 * 1.1, height = 1153 * 1.1;
    expect(fit.zoom).toBeCloseTo(Math.min(800 / width, 800 / height), 3);
    expect(fit.centerX).toBeCloseTo((-551 + 1200) / 2, 3);
    expect(fit.centerY).toBeCloseTo((-593 + 560) / 2, 3);
  });

  it("returns a minZoom that still shows the full margined box, and a maxZoom several times tighter", () => {
    const bounds = { minX: -350, maxX: 350, minY: -350, maxY: 350 };
    const fit = computeCameraFit(bounds, 800, 800, 0.1);
    expect(fit.minZoom).toBeCloseTo(fit.zoom, 5);
    expect(fit.maxZoom).toBeGreaterThan(fit.zoom * 2);
  });
});
