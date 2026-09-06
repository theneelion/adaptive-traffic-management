import { describe, it, expect } from "vitest";
import { loadMap } from "../../src/maps/loadMap";
import { buildVehiclePath } from "../../src/vehicles/TurnPaths";

describe("buildVehiclePath on a curved, non-90-degree, non-origin intersection", () => {
  const map = loadMap("../../maps/fixture_curved_3int.json");

  // Stage 1 keeps buildVehiclePath's existing single-intersection, one-entry-one-exit contract —
  // multi-hop routing across several intersections is Stage 2 (spec §7.1). Every pair below shares
  // one intersection, matching how grid_1x1_v1.json's own tests only ever cross app_N/S/E/W (all
  // one intersection) too.
  it("a turn at int_B (400,0), a non-origin intersection, ends near the exit approach's far point — regression check for the old cornerPoint's implicit origin assumption", () => {
    const path = buildVehiclePath(map, "b_from_a", "b_far_north");
    const end = path.pointAt(path.totalLength);
    // Precision loosened to -2 (tolerance ~50) to allow for LANE_OFFSET (10) shifting the path off
    // the raw centerline/far point — see TurnPaths.ts's offsetSegment.
    expect(end.x).toBeCloseTo(400, -2);
    expect(end.y).toBeCloseTo(-300, -2);
  });

  it("a path exiting via the curved b_from_c connector is noticeably longer than the straight-line distance between its endpoints", () => {
    const path = buildVehiclePath(map, "b_from_a", "b_from_c");
    const start = path.pointAt(0);
    const end = path.pointAt(path.totalLength);
    const straightLineDistance = Math.hypot(end.x - start.x, end.y - start.y);
    expect(path.totalLength).toBeGreaterThan(straightLineDistance * 1.02);
  });

  it("a path exiting via the curved b_from_c connector ends near that approach's far point (700,250), not at int_B", () => {
    const path = buildVehiclePath(map, "b_from_a", "b_from_c");
    const end = path.pointAt(path.totalLength);
    // Precision loosened to -2 (tolerance ~50) to allow for LANE_OFFSET (10) shifting the path off
    // the raw centerline/far point — see TurnPaths.ts's offsetSegment.
    expect(end.x).toBeCloseTo(700, -2);
    expect(end.y).toBeCloseTo(250, -2);
  });

  it("closestProgress still recovers a known distance correctly on a path that exits via a curved connector", () => {
    const path = buildVehiclePath(map, "b_from_a", "b_from_c");
    const knownDistance = path.totalLength * 0.6;
    const point = path.pointAt(knownDistance);
    // A curved exit segment is itself a chain of bezier segments (Task 3's
    // chainedWaypointSegment), each internally sampled via composePath's own
    // CLOSEST_PROGRESS_SAMPLE_STEP-based table — nesting that inside buildVehiclePath's own outer
    // composePath compounds quantization slightly versus a single-level straight/single-bezier
    // path (grid_1x1_v1.json's equivalent test uses the tighter default precision). Within 2 units
    // on a 500+ unit path is well under 0.5% relative error, negligible for closed-loop vehicle
    // position tracking (this value's actual purpose — see composePath's own comment).
    expect(Math.abs(path.closestProgress(point) - knownDistance)).toBeLessThan(2);
  });
});
