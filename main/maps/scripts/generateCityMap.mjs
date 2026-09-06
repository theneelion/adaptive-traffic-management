// Generates maps/city_v1.json from a hand-designed topology (9 intersections, 10 connecting
// roads, 9 terminal spurs — see docs/superpowers/plans/2026-08-17-city-network-stage3-map-content.md
// for how these specific coordinates/roads were chosen and distance-validated). Computing every
// approach's exact coordinates, phase split, and pedestrian graph via this script (rather than
// hand-typing ~30 approaches' worth of numbers) matches this session's established practice of
// deriving geometry programmatically to avoid arithmetic mistakes. Re-running this script produces
// a byte-identical file — no timestamps, no nondeterministic ordering.

import { writeFileSync } from "node:fs";
import path from "node:path";

const ROAD_WIDTH = 40;
const TERMINAL_DISTANCE = 270;
const CORNER_RADIUS = 30;
const TERMINAL_PED_OFFSET = 20; // how far past the approach's own far point the pedestrian far node sits
// How far a sidewalk sits from a road's own centerline, on one consistent side — half the road
// width (a vehicle's lane extends to ROAD_WIDTH/2 from center) plus a clear margin, so pedestrians
// walking between two intersections' corners trace a path clearly alongside the road instead of a
// single straight corner-to-corner line that can run directly through the vehicle lane for roads
// that aren't short and dead straight (found directly: a vehicle stuck motionless for 280+ real
// seconds turned out to be physically blocked by a pedestrian standing in its lane, because the
// only pedestrian path between two distant intersections was exactly this kind of naive direct
// line).
const SIDEWALK_ROAD_OFFSET = ROAD_WIDTH / 2 + 15;

const INTERSECTIONS = {
  I1: { x: 0, y: 0 },
  I2: { x: 320, y: -60 },
  I3: { x: 260, y: 300 },
  I4: { x: -280, y: 210 },
  I5: { x: 620, y: 170 },
  I6: { x: 600, y: -260 },
  I7: { x: -300, y: -240 },
  I8: { x: 930, y: -40 },
  I9: { x: 260, y: -360 }
};

const ROADS = [
  { from: "I1", to: "I2", style: "straight" },
  { from: "I1", to: "I3", style: "straight" },
  { from: "I1", to: "I4", style: "straight" },
  { from: "I1", to: "I7", style: "straight" },
  { from: "I2", to: "I3", style: "straight" },
  { from: "I2", to: "I5", style: "curved" },
  { from: "I2", to: "I6", style: "straight" },
  { from: "I5", to: "I8", style: "straight" },
  { from: "I6", to: "I8", style: "straight" },
  { from: "I6", to: "I9", style: "curved" }
];

const TERMINAL_COUNTS = { I3: 1, I4: 2, I5: 1, I7: 2, I8: 1, I9: 2 };

function lower(id) {
  return id.toLowerCase();
}

function normalizeAngle(a) {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

// --- Pass A: build road approaches (both directions) -----------------------------------------

const approachesByIntersection = new Map(Object.keys(INTERSECTIONS).map((id) => [id, []]));
const allApproaches = [];
const roadPairs = []; // { forward: approach, backward: approach } for connector sidewalk pairing

for (const road of ROADS) {
  const a = INTERSECTIONS[road.from];
  const b = INTERSECTIONS[road.to];
  const forwardId = `${lower(road.to)}_from_${lower(road.from)}`;
  const backwardId = `${lower(road.from)}_from_${lower(road.to)}`;

  let mid;
  if (road.style === "curved") {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const perpX = -dy / len;
    const perpY = dx / len;
    const bulge = len * 0.15;
    mid = { x: Math.round(mx + perpX * bulge), y: Math.round(my + perpY * bulge) };
  }

  const forward = {
    id: forwardId,
    intersectionId: road.to,
    laneStartX: a.x,
    laneStartY: a.y,
    laneEndX: b.x,
    laneEndY: b.y,
    width: ROAD_WIDTH,
    ...(road.style === "curved" ? { waypoints: [{ x: a.x, y: a.y }, mid, { x: b.x, y: b.y }] } : {})
  };
  const backward = {
    id: backwardId,
    intersectionId: road.from,
    laneStartX: b.x,
    laneStartY: b.y,
    laneEndX: a.x,
    laneEndY: a.y,
    width: ROAD_WIDTH,
    ...(road.style === "curved" ? { waypoints: [{ x: b.x, y: b.y }, mid, { x: a.x, y: a.y }] } : {})
  };

  approachesByIntersection.get(road.to).push(forward);
  approachesByIntersection.get(road.from).push(backward);
  allApproaches.push(forward, backward);
  roadPairs.push({ forward, backward, from: road.from, to: road.to });
}

// --- Pass B: terminal spurs, placed in the largest remaining angular gap around each intersection

function headingIntoIntersection(approach) {
  if (approach.waypoints && approach.waypoints.length >= 3) {
    const pts = approach.waypoints;
    const last = pts[pts.length - 1];
    const secondToLast = pts[pts.length - 2];
    return Math.atan2(last.y - secondToLast.y, last.x - secondToLast.x);
  }
  return Math.atan2(approach.laneEndY - approach.laneStartY, approach.laneEndX - approach.laneStartX);
}

function findAngularGaps(angles) {
  const sorted = [...angles].sort((a, b) => a - b);
  const n = sorted.length;
  const gaps = [];
  for (let i = 0; i < n; i++) {
    const a0 = sorted[i];
    const a1 = i === n - 1 ? sorted[0] + 2 * Math.PI : sorted[i + 1];
    gaps.push({ start: a0, end: a1, size: a1 - a0 });
  }
  return gaps.sort((a, b) => b.size - a.size);
}

for (const [intersectionId, count] of Object.entries(TERMINAL_COUNTS)) {
  const existing = approachesByIntersection.get(intersectionId);
  const angles = existing.map((a) => normalizeAngle(headingIntoIntersection(a) + Math.PI)); // direction pointing OUT toward where a spur could go
  const gaps = findAngularGaps(angles);
  const center = INTERSECTIONS[intersectionId];

  for (let i = 0; i < count; i++) {
    const gap = gaps[i % gaps.length];
    // Split a gap in two if it needs to host 2 terminals (only happens for count=2 with 1 network
    // road, i.e. exactly one gap covering the full circle minus that one road).
    const fraction = count === 1 ? 0.5 : (i + 1) / (count + 1);
    const angle = normalizeAngle(gap.start + gap.size * fraction);
    const farX = Math.round(center.x + Math.cos(angle) * TERMINAL_DISTANCE);
    const farY = Math.round(center.y + Math.sin(angle) * TERMINAL_DISTANCE);
    const id = `far_${lower(intersectionId)}${count > 1 ? String.fromCharCode(97 + i) : ""}`;

    const approach = {
      id,
      intersectionId,
      laneStartX: farX,
      laneStartY: farY,
      laneEndX: center.x,
      laneEndY: center.y,
      width: ROAD_WIDTH
    };
    existing.push(approach);
    allApproaches.push(approach);
  }
}

// --- Pass C: per-intersection phase split + pedestrian corners/crosswalks ----------------------

const intersections = [];
const pedestrianNodes = [];
const pedestrianEdges = [];
// approachId -> { intersectionId, beforeCorner, afterCorner } — corner immediately counter-
// clockwise ("before") and clockwise ("after") of that approach in its own intersection's sorted
// angular order. Used by Pass D to wire connector sidewalk continuity between intersections.
const approachCornerInfo = new Map();

for (const [intersectionId, approaches] of approachesByIntersection) {
  const center = INTERSECTIONS[intersectionId];
  const sorted = [...approaches].sort((a, b) => headingIntoIntersection(a) - headingIntoIntersection(b));
  const n = sorted.length;

  // Pedestrian corners: one per angular gap between consecutive (cyclic) approaches.
  const cornerIds = sorted.map((_, i) => `corner_${lower(intersectionId)}_${i}`);
  for (let i = 0; i < n; i++) {
    const a0 = headingIntoIntersection(sorted[i]);
    const a1raw = headingIntoIntersection(sorted[(i + 1) % n]);
    const a1 = a1raw < a0 ? a1raw + 2 * Math.PI : a1raw;
    const bisector = (a0 + a1) / 2;
    pedestrianNodes.push({
      id: cornerIds[i],
      x: Math.round(center.x + Math.cos(bisector) * CORNER_RADIUS),
      y: Math.round(center.y + Math.sin(bisector) * CORNER_RADIUS)
    });
  }
  for (let i = 0; i < n; i++) {
    // A direct corner-to-corner line can cut across the road that sits between them (found
    // directly at a narrow-angle 3-way — see SIDEWALK_ROAD_OFFSET's own comment for how this was
    // caught). Bow the path out along that intervening road's own heading, past its half-width,
    // instead of cutting straight across it.
    const between = sorted[(i + 1) % n];
    const outward = headingIntoIntersection(between) + Math.PI;
    const bulgeRadius = CORNER_RADIUS + ROAD_WIDTH / 2 + 30;
    const bulgeId = `corner_${lower(intersectionId)}_${i}_bulge`;
    pedestrianNodes.push({
      id: bulgeId,
      x: Math.round(center.x + Math.cos(outward) * bulgeRadius),
      y: Math.round(center.y + Math.sin(outward) * bulgeRadius)
    });
    pedestrianEdges.push({ from: cornerIds[i], to: bulgeId, kind: "sidewalk" });
    pedestrianEdges.push({ from: bulgeId, to: cornerIds[(i + 1) % n], kind: "sidewalk" });
  }

  // Crosswalk for approach sorted[i] spans the gap-corner before it and after it.
  for (let i = 0; i < n; i++) {
    const approach = sorted[i];
    const beforeCorner = cornerIds[(i - 1 + n) % n];
    const afterCorner = cornerIds[i];
    pedestrianEdges.push({
      from: beforeCorner,
      to: afterCorner,
      kind: "crosswalk",
      crossingId: `cross_${approach.id}`,
      approachId: approach.id
    });
    approachCornerInfo.set(approach.id, { intersectionId, beforeCorner, afterCorner });
  }

  // Phase split: exactly 2 phases (spec §5.1). 4-way splits into the two "every other" pairs;
  // 3-way groups its two angularly-closest approaches together, the isolated one alone. Mechanical
  // split, reviewed by hand below (see the plan's Task 2 note) before treating this as final.
  let phase1Ids, phase2Ids;
  if (n === 4) {
    phase1Ids = [sorted[0].id, sorted[2].id];
    phase2Ids = [sorted[1].id, sorted[3].id];
  } else if (n === 3) {
    const gapSizes = [0, 1, 2].map((i) => {
      const a0 = headingIntoIntersection(sorted[i]);
      const a1raw = headingIntoIntersection(sorted[(i + 1) % 3]);
      const a1 = a1raw < a0 ? a1raw + 2 * Math.PI : a1raw;
      return a1 - a0;
    });
    const minGapIdx = gapSizes.indexOf(Math.min(...gapSizes));
    const pairA = sorted[minGapIdx].id;
    const pairB = sorted[(minGapIdx + 1) % 3].id;
    const aloneIdx = [0, 1, 2].find((i) => sorted[i].id !== pairA && sorted[i].id !== pairB);
    phase1Ids = [sorted[aloneIdx].id];
    phase2Ids = [pairA, pairB];
  } else {
    throw new Error(`Unexpected approach count ${n} at ${intersectionId} — only 3-way/4-way handled`);
  }

  intersections.push({
    id: intersectionId,
    x: center.x,
    y: center.y,
    phases: [
      { id: "p1", allowedApproachIds: phase1Ids, durationMs: 8000 },
      { id: "p2", allowedApproachIds: phase2Ids, durationMs: 8000 }
    ]
  });
}

// --- Pass D: terminal pedestrian far nodes + connector sidewalk continuity ---------------------

// Offsets a chain of centerline points perpendicular to their own local tangent, by a fixed
// margin, all to the same consistent side — the general "sidewalk running alongside a road"
// construction, used for both terminal spurs and inter-intersection connectors below. A single
// direct edge between two nodes that are far apart (a corner and a distant terminal, or two
// corners at different intersections) can run straight through the vehicle lane for roads that
// aren't short and dead straight — found directly: a vehicle stuck motionless for 280+ real
// seconds turned out to be physically blocked by a pedestrian standing in its lane, because the
// only pedestrian path along that road was exactly this kind of naive direct line.
function offsetAlongside(points, margin) {
  const n = points.length;
  return points.map((p, i) => {
    let dx, dy;
    if (i === 0) {
      dx = points[1].x - points[0].x;
      dy = points[1].y - points[0].y;
    } else if (i === n - 1) {
      dx = points[i].x - points[i - 1].x;
      dy = points[i].y - points[i - 1].y;
    } else {
      dx = points[i + 1].x - points[i - 1].x;
      dy = points[i + 1].y - points[i - 1].y;
    }
    const len = Math.hypot(dx, dy) || 1;
    const perpX = -dy / len;
    const perpY = dx / len;
    return { x: Math.round(p.x + perpX * margin), y: Math.round(p.y + perpY * margin) };
  });
}

for (const approach of allApproaches) {
  const isTerminal = !Object.keys(INTERSECTIONS).some(
    (id) => Math.hypot(INTERSECTIONS[id].x - approach.laneStartX, INTERSECTIONS[id].y - approach.laneStartY) < 1
  );
  const info = approachCornerInfo.get(approach.id);
  if (isTerminal) {
    const dx = approach.laneStartX - approach.laneEndX;
    const dy = approach.laneStartY - approach.laneEndY;
    const len = Math.hypot(dx, dy) || 1;
    const farNodeId = `far_${approach.id}`;
    const farPoint = {
      x: Math.round(approach.laneStartX + (dx / len) * TERMINAL_PED_OFFSET),
      y: Math.round(approach.laneStartY + (dy / len) * TERMINAL_PED_OFFSET)
    };
    pedestrianNodes.push({ id: farNodeId, x: farPoint.x, y: farPoint.y });

    // The spur's own centerline, from the intersection (this approach's laneEnd) out to the far
    // point — offset alongside it rather than a single line straight down the middle of the road.
    // Both ends of the offset pair matter: using only the far-end offset (an earlier version of
    // this code) connected the *unoffset* corner directly to a point offset near the far end — a
    // diagonal that isn't parallel to the road at all, and can still cross it. Using both offset
    // points as a genuinely parallel two-point chain (near-intersection offset -> near-far offset)
    // is what actually keeps the whole spur's sidewalk clear of the road.
    const spurCenterline = [
      { x: approach.laneEndX, y: approach.laneEndY },
      { x: approach.laneStartX, y: approach.laneStartY }
    ];
    const spurOffset = offsetAlongside(spurCenterline, SIDEWALK_ROAD_OFFSET);
    const nearId = `sidewalk_${approach.id}_spur_near`;
    const farMidId = `sidewalk_${approach.id}_spur_far`;
    pedestrianNodes.push({ id: nearId, x: spurOffset[0].x, y: spurOffset[0].y });
    pedestrianNodes.push({ id: farMidId, x: spurOffset[1].x, y: spurOffset[1].y });
    pedestrianEdges.push({ from: info.afterCorner, to: nearId, kind: "sidewalk" });
    pedestrianEdges.push({ from: nearId, to: farMidId, kind: "sidewalk" });
    pedestrianEdges.push({ from: farMidId, to: farNodeId, kind: "sidewalk" });
  }
}

for (const { forward, backward } of roadPairs) {
  const forwardInfo = approachCornerInfo.get(forward.id);
  const backwardInfo = approachCornerInfo.get(backward.id);

  // forward's own centerline, ordered from the "from" intersection to the "to" intersection
  // (forward.laneStartX/Y is "from", forward.laneEndX/Y is "to") — reuse its waypoints if curved,
  // otherwise just its two endpoints.
  const centerline = forward.waypoints
    ? forward.waypoints.map((w) => ({ x: w.x, y: w.y }))
    : [
        { x: forward.laneStartX, y: forward.laneStartY },
        { x: forward.laneEndX, y: forward.laneEndY }
      ];
  const offsetPoints = offsetAlongside(centerline, SIDEWALK_ROAD_OFFSET);

  // Every offset point becomes a new node, including the two ends — using only the *interior*
  // points (an earlier version of this code) meant a straight 2-point road (centerline.length===2)
  // contributed zero offset nodes at all, since slicing off both ends of a 2-element array leaves
  // nothing: the sidewalk fell back to a direct, unoffset corner-to-corner edge, identical to the
  // original bug. Walked from the "to" end back to the "from" end, so it chains onto forward's own
  // corner (at "to") first and backward's own corner (at "from") last.
  const reversed = [...offsetPoints].reverse();
  const chainNodeIds = reversed.map((p, i) => {
    const id = `sidewalk_${forward.id}_${i}`;
    pedestrianNodes.push({ id, x: p.x, y: p.y });
    return id;
  });

  const chain = [forwardInfo.afterCorner, ...chainNodeIds, backwardInfo.afterCorner];
  for (let i = 0; i < chain.length - 1; i++) {
    pedestrianEdges.push({ from: chain[i], to: chain[i + 1], kind: "sidewalk" });
  }
}

const map = {
  id: "city_v1",
  intersections,
  approaches: allApproaches,
  pedestrianNodes,
  pedestrianEdges
};

const outPath = path.resolve(import.meta.dirname, "..", "city_v1.json");
writeFileSync(outPath, JSON.stringify(map, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
