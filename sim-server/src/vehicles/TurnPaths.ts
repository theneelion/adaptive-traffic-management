import type { MapDefinition, ApproachDef } from "../maps/MapDefinition.js";

// Must clear the vehicle's own half-length (VehicleBody's rectangle is 36 long, so 18) — a vehicle
// stopped with its center at the stop line has its front bumper extending that far past it. At the
// old value of 15, the front bumper protruded ~3 units past the stop line into the intersection
// box itself, physically overlapping where a cross-traffic vehicle's turn curve lands. Found
// directly: a car legitimately queued at its own stop line was solid-body blocking a different
// car mid-turn, whose own leader logic correctly showed no leader and full throttle commanded every
// tick, yet its real physical speed stayed pinned near zero — Matter's collision resolution was
// silently canceling the requested velocity every tick because moving forward meant driving through
// an already-touching rigid body. No braking/leader logic can fix that; the queued car's own resting
// position has to actually stay clear of the box.
export const STOP_LINE_OFFSET = 20;

// turnControlPoint's `fraction` argument: how far to pull the turn's Bezier control point from
// the ideal entry/exit tangent-line crossing (0) toward the straight-line midpoint between the
// two stop points (1) — see turnControlPoint's own comment for the geometric construction.
// Replaces the old compass-based cornerPoint's fixed 0.4-of-stopOffset formula, which implicitly
// assumed the intersection sat at the origin (only true for grid_1x1_v1.json's one intersection).
// This value uses a different parameterization (fraction of the way from an ideal ray-crossing
// toward the midpoint, not a fraction of stopOffset from the origin), so it needed its own
// empirical sweep, not a carried-over 0.4: swept against the real map's N->E 90-degree turn
// (bare-function probe, holding the map's real geometry fixed), 0.75 was the smallest value
// giving a turn radius comfortably above 30 units (42.4, close to the ~53-56 the old formula
// achieved) for an 18-wide, 36-long vehicle — smaller fractions (e.g. 0.65) dip below 30.
const TURN_CONTROL_FRACTION = 0.75;

interface Point {
  x: number;
  y: number;
}

interface Segment {
  length: number;
  pointAtDistance(d: number): Point;
  headingAtDistance(d: number): number;
}

export interface VehiclePath {
  totalLength: number;
  stopLineDistance: number; // = stopLines[0]?.distance ?? totalLength — kept for single-hop callers
  stopLines: { distance: number; approachId: string }[]; // one per intersection crossed, in order
  pointAt(distance: number): Point;
  headingAt(distance: number): number;
  closestProgress(position: Point, hint?: number): number;
  approachIdAt(distance: number): string; // which approach's physical lane this distance falls on
}

// Real geometric heading, computed from coordinates — never from the legacy compass `direction`
// field, which can't represent an organic city's arbitrary-angle approaches. "Into intersection"
// is the tangent direction a vehicle travels arriving at this approach's laneEnd (its
// intersection-side point); "out of intersection" is the reverse (the direction a vehicle departs
// this approach's laneEnd heading back out toward laneStart) — used when this same approach
// object is being traversed as an *exit* from a different intersection's perspective (see
// buildVehiclePath).
export function headingIntoIntersection(approach: ApproachDef): number {
  if (approach.waypoints && approach.waypoints.length >= 3) {
    const points = approach.waypoints;
    const last = points[points.length - 1];
    const secondToLast = points[points.length - 2];
    return Math.atan2(last.y - secondToLast.y, last.x - secondToLast.x);
  }
  return Math.atan2(approach.laneEndY - approach.laneStartY, approach.laneEndX - approach.laneStartX);
}

export function headingOutOfIntersection(approach: ApproachDef): number {
  const into = headingIntoIntersection(approach);
  return Math.atan2(Math.sin(into + Math.PI), Math.cos(into + Math.PI));
}

export function isRoughlyOpposite(headingA: number, headingB: number, toleranceRad = (20 * Math.PI) / 180): boolean {
  const diff = Math.atan2(Math.sin(headingA - headingB), Math.cos(headingA - headingB));
  return Math.abs(Math.abs(diff) - Math.PI) < toleranceRad;
}

// Replaces the old compass-based cornerPoint, which returned a point relative to an *assumed*
// intersection at the origin (only correct because grid_1x1_v1.json's one intersection happens to
// sit at (0,0) — a latent bug for any other intersection position). This is a real geometric
// construction: the ideal single control point for a quadratic bezier smoothly connecting two
// directed line segments is where their tangent lines cross (a car arriving along `entryHeading`
// and departing along `exitHeading` would, if it could travel in perfectly straight lines, meet
// at that crossing point). `fraction` pulls the actual control point from that ideal crossing
// toward the straight-line midpoint between the two stop points — fraction=0 is the full
// ideal-crossing point (can produce very wide curves for sharp angles), fraction=1 is a straight
// chord (no bulge at all). Falls back to the midpoint outright when the two tangent rays are
// nearly parallel (no well-defined intersection, e.g. a near-straight "turn" or a near-U-turn).
export function turnControlPoint(entryStopPoint: Point, entryHeading: number, exitStopPoint: Point, exitHeading: number, fraction: number): Point {
  const midpoint: Point = { x: (entryStopPoint.x + exitStopPoint.x) / 2, y: (entryStopPoint.y + exitStopPoint.y) / 2 };

  const d1x = Math.cos(entryHeading);
  const d1y = Math.sin(entryHeading);
  // The exit ray is traced backward from exitStopPoint (a vehicle departing along exitHeading
  // came *from* the direction opposite exitHeading).
  const d2x = Math.cos(exitHeading + Math.PI);
  const d2y = Math.sin(exitHeading + Math.PI);

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-6) return midpoint;

  const dx = exitStopPoint.x - entryStopPoint.x;
  const dy = exitStopPoint.y - entryStopPoint.y;
  const t = (dx * d2y - dy * d2x) / denom;
  const idealCrossing: Point = { x: entryStopPoint.x + d1x * t, y: entryStopPoint.y + d1y * t };

  return {
    x: idealCrossing.x + (midpoint.x - idealCrossing.x) * fraction,
    y: idealCrossing.y + (midpoint.y - idealCrossing.y) * fraction
  };
}

// How far each direction of travel sits from a road's raw centerline — the real fix for a class of
// bugs that all trace back to the same root cause: a terminal approach used both as an entry
// (forward) and, by a different vehicle, as an exit (reversed) shares the literal same coordinate
// line with no separation at all, so opposing traffic drives head-on down the same line. Found
// directly: a car turning into a lane where oncoming traffic was queued ended up in genuine,
// permanent Matter.js rigid-body contact with it — no leader/IDM logic can resolve two vehicles
// that are already physically touching, since Matter's collision resolution correctly refuses to
// let either one drive through the other.
//
// 10 (the geometric max that still clears the wall — approach.width is 40 here, so a vehicle's
// edge at offset+halfWidth=19 just fits inside the wall at 20) turned out to leave only 1 unit of
// real margin, and that's not enough: a vehicle driving a perfectly straight offset line still
// accumulates tiny floating-point heading drift over hundreds of ticks (present in this system all
// along — Matter.Body.setAngularVelocity's steer correction is never perfectly exactly zero), and
// the old zero-offset design had ~11 units of margin (half the 40-wide road minus the 9 half-width)
// to absorb that harmlessly. Found directly: a vehicle driving straight down its own offset lane
// clipped app_N's own wall and got permanently wedged, confirmed via a real collisionStart event,
// well before ever reaching the intersection. 6 gives up full separation (2*6=12 is less than the
// 18 needed to fully clear two vehicles' half-widths) in exchange for real wall clearance (5 units)
// — a real, if partial, improvement over the original 0 gap, and Matter's own collision response
// can resolve an occasional graze, unlike a permanent same-line overlap.
const LANE_OFFSET = 6;

// Shifts every point of `segment` perpendicular to its own direction-of-travel heading (already
// correctly reversed for a hop driven backward — see buildMultiHopVehiclePath) by `offset`. Applying
// this with the SAME sign to both directions of a road is what actually separates them: at any
// given physical point, a forward-traveling hop's heading is exactly the reverse of a
// reverse-traveling hop's heading there, so the perpendicular-right vector flips sign too — the two
// directions land on opposite sides of the original centerline automatically, without needing to
// know here which physical side "left" or "right" is.
function offsetSegment(segment: Segment, offset: number): Segment {
  const perpAt = (d: number): Point => {
    const heading = segment.headingAtDistance(d);
    return { x: -Math.sin(heading), y: Math.cos(heading) };
  };
  return {
    length: segment.length,
    pointAtDistance: (d) => {
      const p = segment.pointAtDistance(d);
      const perp = perpAt(d);
      return { x: p.x + perp.x * offset, y: p.y + perp.y * offset };
    },
    headingAtDistance: (d) => segment.headingAtDistance(d)
  };
}

function pointAlong(from: Point, to: Point, distance: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const t = distance / length;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function straightSegment(from: Point, to: Point): Segment {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const heading = Math.atan2(to.y - from.y, to.x - from.x);
  return {
    length,
    pointAtDistance: (d) => pointAlong(from, to, d),
    headingAtDistance: () => heading
  };
}

function bezierSegment(p0: Point, p1: Point, p2: Point, sampleCount = 24): Segment {
  const points: Point[] = Array.from({ length: sampleCount + 1 }, (_, i) => {
    const t = i / sampleCount;
    return {
      x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t ** 2 * p2.x,
      y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t ** 2 * p2.y
    };
  });
  const cumLength = [0];
  for (let i = 1; i < points.length; i++) {
    cumLength.push(cumLength[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const length = cumLength[cumLength.length - 1];

  function locate(d: number): { a: Point; b: Point; localT: number } {
    const clamped = Math.max(0, Math.min(d, length));
    let idx = cumLength.findIndex((c) => c >= clamped);
    if (idx <= 0) idx = 1;
    const segStart = cumLength[idx - 1];
    const segEnd = cumLength[idx];
    const localT = segEnd > segStart ? (clamped - segStart) / (segEnd - segStart) : 0;
    return { a: points[idx - 1], b: points[idx], localT };
  }

  return {
    length,
    pointAtDistance: (d) => {
      const { a, b, localT } = locate(d);
      return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT };
    },
    headingAtDistance: (d) => {
      const { a, b } = locate(d);
      return Math.atan2(b.y - a.y, b.x - a.x);
    }
  };
}

const CLOSEST_PROGRESS_SAMPLE_STEP = 4;

interface TaggedSegment {
  segment: Segment;
  approachId: string;
}

function composePath(
  segments: TaggedSegment[],
  stopLineDistance: number,
  stopLines: { distance: number; approachId: string }[] = []
): VehiclePath {
  const totalLength = segments.reduce((sum, s) => sum + s.segment.length, 0);

  function locate(d: number): { segment: Segment; localD: number; approachId: string } {
    let remaining = Math.max(0, Math.min(d, totalLength));
    for (const { segment, approachId } of segments) {
      if (remaining <= segment.length) return { segment, localD: remaining, approachId };
      remaining -= segment.length;
    }
    const last = segments[segments.length - 1];
    return { segment: last.segment, localD: last.segment.length, approachId: last.approachId };
  }

  const pointAt = (d: number): Point => {
    const { segment, localD } = locate(d);
    return segment.pointAtDistance(localD);
  };

  // Precomputed once per path: a lookup table used by closestProgress to find how far along the
  // path the vehicle's *actual* physics position corresponds to. This exists specifically so
  // progress tracking is closed-loop (derived from real position every tick) rather than
  // open-loop (integrating speed*dt) — the open-loop version silently drifted from the vehicle's
  // real position whenever steering introduced any lateral/rotational velocity component (e.g.
  // while braking hard near a stop line), eventually reporting the vehicle as past the stop line
  // when it physically wasn't, which broke red-light compliance. See TrafficController.
  const sampleCount = Math.max(1, Math.ceil(totalLength / CLOSEST_PROGRESS_SAMPLE_STEP));
  const samples: { distance: number; point: Point }[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const d = Math.min((i / sampleCount) * totalLength, totalLength);
    samples.push({ distance: d, point: pointAt(d) });
  }

  return {
    totalLength,
    stopLineDistance,
    stopLines,
    pointAt,
    headingAt: (d) => {
      const { segment, localD } = locate(d);
      return segment.headingAtDistance(localD);
    },
    approachIdAt: (d) => locate(d).approachId,
    closestProgress: (position: Point, hint?: number): number => {
      // A curved (turning) path can fold back near itself in raw XY space — a corner's Bezier
      // bulge can sit geometrically close to a point on the straight entry segment. An
      // unconstrained global nearest-point search can therefore snap to the wrong arc-length
      // value (e.g. jumping past the stop line) whenever steering leaves the vehicle briefly
      // off-path. Searching only a local window around the previous tick's known progress makes
      // this self-correcting instead: it can't jump further than a vehicle could plausibly have
      // traveled in one tick, so a momentary steering wobble can't be misread as "already past
      // the intersection."
      const SEARCH_WINDOW = 80;
      let candidates = samples;
      if (hint !== undefined) {
        const windowed = samples.filter((s) => Math.abs(s.distance - hint) <= SEARCH_WINDOW);
        if (windowed.length > 0) candidates = windowed;
      }

      let bestDistance = candidates[0].distance;
      let bestDistSq = Infinity;
      for (const sample of candidates) {
        const dx = sample.point.x - position.x;
        const dy = sample.point.y - position.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestDistance = sample.distance;
        }
      }
      return bestDistance;
    }
  };
}

function cubicBezierSegment(p0: Point, p1: Point, p2: Point, p3: Point, sampleCount = 24): Segment {
  const points: Point[] = Array.from({ length: sampleCount + 1 }, (_, i) => {
    const t = i / sampleCount;
    const mt = 1 - t;
    return {
      x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
      y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y
    };
  });
  const cumLength = [0];
  for (let i = 1; i < points.length; i++) {
    cumLength.push(cumLength[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const length = cumLength[cumLength.length - 1];

  function locate(d: number): { a: Point; b: Point; localT: number } {
    const clamped = Math.max(0, Math.min(d, length));
    let idx = cumLength.findIndex((c) => c >= clamped);
    if (idx <= 0) idx = 1;
    const segStart = cumLength[idx - 1];
    const segEnd = cumLength[idx];
    const localT = segEnd > segStart ? (clamped - segStart) / (segEnd - segStart) : 0;
    return { a: points[idx - 1], b: points[idx], localT };
  }

  return {
    length,
    pointAtDistance: (d) => {
      const { a, b, localT } = locate(d);
      return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT };
    },
    headingAtDistance: (d) => {
      const { a, b } = locate(d);
      return Math.atan2(b.y - a.y, b.x - a.x);
    }
  };
}

// Chains a sequence of waypoints into one smooth Segment using a Catmull-Rom-derived cubic bezier
// per consecutive pair. Each interior waypoint's tangent is the direction from its previous to its
// next neighbor (endpoints use the direction to/from their one neighbor); each segment's control
// points are placed a third of that segment's own length along the shared endpoint tangents. This
// is deliberately symmetric under reversing the waypoint list: reversing negates every tangent but
// leaves each segment's own length (the scale factor) unchanged, so a physical road represented as
// two opposite-direction approaches with mirrored waypoint lists (e.g. b_from_c and c_from_b)
// produces the *same* physical curve for both, just traversed in opposite parameter directions.
// An earlier "continue the incoming direction" formula (a single-sided quadratic bezier, always
// straight on the first leg) was NOT symmetric this way — traversing the same physical road's two
// opposite-direction approaches produced two genuinely different curves, and Task 6's curved
// wall-chain test caught this directly: a vehicle following b_from_c's own centerline clipped
// c_from_b's independently-built (differently-shaped) wall chain for what should be the same road.
function chainedWaypointSegment(waypoints: Point[]): Segment {
  const n = waypoints.length;
  const tangentAt = (i: number): Point => {
    let dx: number, dy: number;
    if (i === 0) {
      dx = waypoints[1].x - waypoints[0].x;
      dy = waypoints[1].y - waypoints[0].y;
    } else if (i === n - 1) {
      dx = waypoints[i].x - waypoints[i - 1].x;
      dy = waypoints[i].y - waypoints[i - 1].y;
    } else {
      dx = waypoints[i + 1].x - waypoints[i - 1].x;
      dy = waypoints[i + 1].y - waypoints[i - 1].y;
    }
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };

  const segments: Segment[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = waypoints[i];
    const p3 = waypoints[i + 1];
    const segLen = Math.hypot(p3.x - p0.x, p3.y - p0.y) || 1;
    const scale = segLen / 3;
    const t0 = tangentAt(i);
    const t1 = tangentAt(i + 1);
    const p1: Point = { x: p0.x + t0.x * scale, y: p0.y + t0.y * scale };
    const p2: Point = { x: p3.x - t1.x * scale, y: p3.y - t1.y * scale };
    segments.push(cubicBezierSegment(p0, p1, p2, p3));
  }
  // composePath returns a VehiclePath (pointAt/headingAt/totalLength), not a bare Segment
  // (pointAtDistance/headingAtDistance/length) — wrap it rather than returning it directly. The
  // approachId tag is irrelevant here (this inner composePath call only exists to chain bezier
  // pieces into one Segment; the outer buildMultiHopVehiclePath call is what tags real approaches).
  const composed = composePath(
    segments.map((segment) => ({ segment, approachId: "" })),
    segments[0].length
  );
  return { length: composed.totalLength, pointAtDistance: composed.pointAt, headingAtDistance: composed.headingAt };
}

export function buildApproachCenterline(approach: ApproachDef): Segment {
  const from: Point = { x: approach.laneStartX, y: approach.laneStartY };
  const to: Point = { x: approach.laneEndX, y: approach.laneEndY };
  if (!approach.waypoints || approach.waypoints.length < 3) {
    return straightSegment(from, to);
  }
  return chainedWaypointSegment(approach.waypoints);
}

// Generalizes the original single-hop path builder to an arbitrary-length chain of approaches:
// approachIds[0] is always used forward (drive from its far laneStart up to its own stop line —
// exactly today's "entry" treatment), approachIds[last] is always used reversed (a terminal exit:
// drive backward from near its own laneEnd/intersection down to its far laneStart — exactly
// today's "exit" treatment), and everything in between is a *connector* used forward (drive from
// near its own laneStart, at the intersection just crossed, up to its own stop line, near the
// NEXT intersection). Every hop-to-hop transition gets its own turn-crossing bezier, built with
// the exact same turnControlPoint construction Stage 1 validated for the single-hop case — this
// function doesn't introduce new turn geometry, only chains more of the same crossings together.
export function buildMultiHopVehiclePath(mapDef: MapDefinition, approachIds: string[]): VehiclePath {
  const approaches = approachIds.map((id) => mapDef.approaches.find((a) => a.id === id)!);
  const centerlines = approaches.map((a) => buildApproachCenterline(a));

  const segments: TaggedSegment[] = [];
  const stopLines: { distance: number; approachId: string }[] = [];

  // LANE_OFFSET applied to the entry hop's own forward-facing heading — centerlines[0] is already
  // oriented in the entry's direction of travel, so no reversal is needed here (see offsetSegment
  // and the connector/exit hops below, which build their own forward-oriented segment first for
  // the same reason).
  const entryOffsetCenterline = offsetSegment(centerlines[0], LANE_OFFSET);
  const entryStopOffset = Math.min(STOP_LINE_OFFSET, centerlines[0].length / 2);
  const entryStopDistance = centerlines[0].length - entryStopOffset;
  segments.push({
    approachId: approachIds[0],
    segment: {
      length: entryStopDistance,
      pointAtDistance: (d) => entryOffsetCenterline.pointAtDistance(d),
      headingAtDistance: (d) => entryOffsetCenterline.headingAtDistance(d)
    }
  });
  stopLines.push({ distance: entryStopDistance, approachId: approachIds[0] });

  let prevStopPoint = entryOffsetCenterline.pointAtDistance(entryStopDistance);
  let prevHeading = headingIntoIntersection(approaches[0]);
  let cumulative = entryStopDistance;

  for (let hop = 1; hop < approachIds.length; hop++) {
    const isLast = hop === approachIds.length - 1;
    const centerline = centerlines[hop];
    const approach = approaches[hop];

    let startDistance: number;
    let hopLength: number;
    let forward: boolean;
    let exitHeadingForCrossing: number;

    if (isLast) {
      // Terminal exit: reversed, from near its own laneEnd down to 0 (its far laneStart). No stop
      // line — the vehicle is leaving the network, nothing left ahead to check.
      const stopOffset = Math.min(STOP_LINE_OFFSET, centerline.length / 2);
      startDistance = centerline.length - stopOffset;
      hopLength = startDistance; // traversed down to 0
      forward = false;
      exitHeadingForCrossing = headingOutOfIntersection(approach);
    } else {
      // Connector: forward, from near its own laneStart (the intersection just crossed) up to
      // near its own laneEnd (its own stop line, at the NEXT intersection).
      const startOffset = Math.min(STOP_LINE_OFFSET, centerline.length / 2);
      const stopOffset = Math.min(STOP_LINE_OFFSET, centerline.length / 2);
      startDistance = startOffset;
      hopLength = Math.max(centerline.length - stopOffset - startOffset, 0);
      forward = true;
      // The crossing bezier's "exit heading" is always the heading a vehicle actually departs
      // along — for a forward connector that's headingIntoIntersection's reverse (the same
      // relationship headingOutOfIntersection already encodes for a terminal exit).
      exitHeadingForCrossing = Math.atan2(Math.sin(headingIntoIntersection(approach) + Math.PI), Math.cos(headingIntoIntersection(approach) + Math.PI));
    }

    // Built oriented-first (matching this hop's actual direction of travel — forward or reversed),
    // then offset perpendicular to that direction — see offsetSegment and LANE_OFFSET's comment for
    // why offsetting the already-direction-corrected heading is what lands opposite-direction
    // traffic on opposite sides of the road automatically.
    const orientedHop: Segment = {
      length: hopLength,
      pointAtDistance: (d) => centerline.pointAtDistance(forward ? startDistance + d : startDistance - d),
      headingAtDistance: (d) => {
        const raw = centerline.headingAtDistance(forward ? startDistance + d : startDistance - d);
        return forward ? raw : Math.atan2(Math.sin(raw + Math.PI), Math.cos(raw + Math.PI));
      }
    };
    const hopSegment = offsetSegment(orientedHop, LANE_OFFSET);
    const startPoint = hopSegment.pointAtDistance(0);

    const isStraight = isRoughlyOpposite(prevHeading, exitHeadingForCrossing);
    const crossing: Segment = isStraight
      ? straightSegment(prevStopPoint, startPoint)
      : bezierSegment(prevStopPoint, turnControlPoint(prevStopPoint, prevHeading, startPoint, exitHeadingForCrossing, TURN_CONTROL_FRACTION), startPoint);
    segments.push({ approachId: approachIds[hop - 1], segment: crossing });
    cumulative += crossing.length;

    segments.push({ approachId: approachIds[hop], segment: hopSegment });

    if (!isLast) {
      stopLines.push({ distance: cumulative + hopLength, approachId: approachIds[hop] });
    }
    cumulative += hopLength;

    prevStopPoint = hopSegment.pointAtDistance(hopLength);
    prevHeading = forward
      ? Math.atan2(Math.sin(headingIntoIntersection(approach) + Math.PI), Math.cos(headingIntoIntersection(approach) + Math.PI))
      : exitHeadingForCrossing;
  }

  return composePath(segments, stopLines[0]?.distance ?? cumulative, stopLines);
}

export function buildVehiclePath(mapDef: MapDefinition, entryApproachId: string, exitApproachId: string): VehiclePath {
  return buildMultiHopVehiclePath(mapDef, [entryApproachId, exitApproachId]);
}
