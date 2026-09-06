import Matter from "matter-js";
import type { MapDefinition, ApproachDef } from "../maps/MapDefinition.js";
import { buildApproachCenterline } from "../vehicles/TurnPaths.js";

const WALL_CHAIN_SEGMENT_LENGTH = 20; // short enough to hug a curve, long enough to keep body count reasonable

// Independent of STOP_LINE_OFFSET (15) — see buildStraightWalls's own comment for why they used to
// be the same constant and why city_v1.json's real, unevenly-angled 4-way intersections (unlike
// grid_1x1_v1.json's perfectly symmetric one, or fixture_curved_3int.json's simpler 3-way/2-way
// nodes) needed this decoupled: a turning vehicle's crossing bezier at a real intersection with
// roads meeting at genuinely uneven angles (and, at I2, a curved connector on top of that) can
// swing close enough to an *adjacent* (not even the straight-through) approach's wall to clip its
// near-intersection corner at the old 15-unit gap — found by actually driving probe vehicles
// across every route in city_v1.json, not by inspecting the geometry: 30 cleared I1's collision
// but left two other intersections (I2, where a car got physically wedged oscillating between two
// adjacent walls) still colliding. Widening the wall gap alone (leaving STOP_LINE_OFFSET, and
// therefore where vehicles actually queue, unchanged) was sufficient once wide enough — swept
// 30/50, 50 was the value that cleared every route probed (the original I1 case, plus 4 more
// spanning every curved/straight/diagonal road and every 3-way/4-way intersection in the map).
const WALL_INTERSECTION_GAP = 50;

export class PhysicsWorld {
  readonly engine: Matter.Engine;

  constructor(mapDef: MapDefinition) {
    this.engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });

    for (const approach of mapDef.approaches) {
      if (approach.waypoints && approach.waypoints.length >= 3) {
        this.buildCurvedWalls(approach);
      } else {
        this.buildStraightWalls(approach);
      }
      this.buildQueueZone(approach);
    }
  }

  // Each approach's lane-boundary walls originally ran the full laneStart-to-laneEnd length,
  // i.e. right up to the shared intersection center. Since every approach converges on that
  // same point, the perpendicular approaches' walls then physically cross the through-lane:
  // e.g. app_E_left_edge/app_W_right_edge together span the *entire* x-axis at y=+-20,
  // forming a complete solid barrier across the N/S lane a car passes through well before
  // ever reaching the stop line. Found only by tracing a straight-through vehicle's position
  // and seeing it permanently wedged there — half of all straight-through traffic in the
  // whole simulation (pickExitApproachId picks straight ~50% of the time) would silently get
  // stuck at that pinch point forever, masked because existing tests only assert that *some*
  // vehicle (any turning one) eventually despawns, not that every vehicle does.
  //
  // The gap must be small enough that the wall still reaches the stop line (protecting a
  // vehicle queued there from lateral traffic on a green cross-street — using half the
  // approach's own width, 20, for the gap regressed exactly this: TrafficController's "holds
  // at a red light" test started failing because the stopped car, sitting at the stop line
  // (STOP_LINE_OFFSET=15 from center), was left outside its now-shortened wall and got
  // clipped by real cross-traffic). Using STOP_LINE_OFFSET itself as the gap satisfies both
  // constraints at once: each wall still reaches exactly to its own stop line, and at the
  // crossing walls' position (y=+-20 for the N/S walls' perpendicular partners) this leaves an
  // x∈(-15,15) gap — wide enough for an 18-unit-wide vehicle body to pass through untouched.
  //
  // The gap is trimmed from BOTH ends, not just the laneEnd side. grid_1x1_v1.json's single
  // intersection made this invisible: every approach's laneEnd IS that one intersection, and
  // laneStart is always just a synthetic far spawn point, so only the laneEnd-side gap ever
  // mattered. A multi-intersection map's road between two REAL intersections needs one approach
  // per direction (e.g. a_from_b / b_from_a), and each one's laneStart is the OTHER
  // intersection, not a spawn stub — trimming only the laneEnd side left that far end's wall
  // reaching fully, ungapped, into the other intersection, crossing its perpendicular approaches'
  // walls there (found via fixture_curved_3int.json's b_far_north vehicle stalling dead at
  // (400,-40), pinned against a_from_b_left_edge — which, having no gap at its laneStart end
  // (int_B), extended all the way into int_B's cross-lane zone). Trimming both ends costs a
  // harmless 15-unit gap near each approach's far spawn point instead.
  private buildStraightWalls(approach: ApproachDef): void {
    const dx = approach.laneEndX - approach.laneStartX;
    const dy = approach.laneEndY - approach.laneStartY;
    const fullLength = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    const gap = WALL_INTERSECTION_GAP;
    const length = Math.max(fullLength - 2 * gap, 1);
    const unitX = dx / fullLength;
    const unitY = dy / fullLength;
    const midX = approach.laneStartX + unitX * (gap + length / 2);
    const midY = approach.laneStartY + unitY * (gap + length / 2);
    const perpX = -Math.sin(angle) * (approach.width / 2);
    const perpY = Math.cos(angle) * (approach.width / 2);

    const leftEdge = Matter.Bodies.rectangle(midX + perpX, midY + perpY, length, 4, {
      isStatic: true,
      angle,
      label: `${approach.id}_left_edge`
    });
    const rightEdge = Matter.Bodies.rectangle(midX - perpX, midY - perpY, length, 4, {
      isStatic: true,
      angle,
      label: `${approach.id}_right_edge`
    });
    Matter.Composite.add(this.engine.world, [leftEdge, rightEdge]);
  }

  // Only reached for approaches with waypoints (never grid_1x1_v1.json). Samples the approach's
  // real (curved) centerline in short straight segments and places a left/right wall-rectangle
  // pair along each one, rotated to that segment's own local tangent — the same "chain of short
  // straight pieces approximates a curve" technique the turn-curve's own 24-point sampling already
  // relies on, just walked along the whole road instead of only the last few meters into an
  // intersection.
  private buildCurvedWalls(approach: ApproachDef): void {
    const centerline = buildApproachCenterline(approach);
    const gap = WALL_INTERSECTION_GAP;
    // Trimmed from BOTH ends, for the same reason buildStraightWalls is — see its comment.
    const length = Math.max(centerline.length - 2 * gap, 1);
    const segmentCount = Math.max(1, Math.ceil(length / WALL_CHAIN_SEGMENT_LENGTH));
    const segmentLength = length / segmentCount;

    const bodies: Matter.Body[] = [];
    for (let i = 0; i < segmentCount; i++) {
      const dStart = gap + i * segmentLength;
      const dEnd = gap + (i + 1) * segmentLength;
      const pStart = centerline.pointAtDistance(dStart);
      const pEnd = centerline.pointAtDistance(dEnd);
      const midX = (pStart.x + pEnd.x) / 2;
      const midY = (pStart.y + pEnd.y) / 2;
      const segAngle = Math.atan2(pEnd.y - pStart.y, pEnd.x - pStart.x);
      const segLen = Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y);
      const perpX = -Math.sin(segAngle) * (approach.width / 2);
      const perpY = Math.cos(segAngle) * (approach.width / 2);

      bodies.push(
        Matter.Bodies.rectangle(midX + perpX, midY + perpY, segLen, 4, {
          isStatic: true,
          angle: segAngle,
          label: `${approach.id}_left_edge_${i}`
        })
      );
      bodies.push(
        Matter.Bodies.rectangle(midX - perpX, midY - perpY, segLen, 4, {
          isStatic: true,
          angle: segAngle,
          label: `${approach.id}_right_edge_${i}`
        })
      );
    }
    Matter.Composite.add(this.engine.world, bodies);
  }

  private buildQueueZone(approach: ApproachDef): void {
    const dx = approach.laneEndX - approach.laneStartX;
    const dy = approach.laneEndY - approach.laneStartY;
    const fullLength = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    const zoneLength = 60;
    const zoneCenterOffset = zoneLength / 2;
    const towardIntersectionX = dx / fullLength;
    const towardIntersectionY = dy / fullLength;
    const zoneCenterX = approach.laneEndX - towardIntersectionX * zoneCenterOffset;
    const zoneCenterY = approach.laneEndY - towardIntersectionY * zoneCenterOffset;

    const queueZone = Matter.Bodies.rectangle(zoneCenterX, zoneCenterY, zoneLength, approach.width, {
      isStatic: true,
      isSensor: true,
      angle,
      label: `${approach.id}_queue_zone`
    });
    Matter.Composite.add(this.engine.world, queueZone);
  }

  step(dtMs: number): void {
    // Matter.js's integrator is only numerically stable for step sizes up to ~16.667ms (its own
    // recommendation). The sim's real tick rate is 50ms (20Hz broadcast, TR-2) — handing that
    // whole 50ms to Matter.Engine.update() in one call compounds instability over many ticks
    // (vehicles gaining unbounded speed/energy over a long-running session). Subdividing into
    // fixed ~16.667ms substeps keeps each individual integration step within Matter's stable
    // range while still advancing the full requested dtMs per call.
    const SUB_STEP_MS = 1000 / 60;
    let remaining = dtMs;
    while (remaining > 1e-6) {
      const step = Math.min(SUB_STEP_MS, remaining);
      Matter.Engine.update(this.engine, step);
      remaining -= step;
    }
  }
}
