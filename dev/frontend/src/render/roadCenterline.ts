interface Point {
  x: number;
  y: number;
}

export interface CenterlineSample extends Point {
  heading: number;
}

// Catmull-Rom-derived cubic bezier through the waypoints — mirrors sim-server's
// TurnPaths.chainedWaypointSegment construction (same tangent/control-point formula), but
// reimplemented here since frontend and sim-server are separate packages with no shared runtime
// module beyond shared-contracts types. This is display-only tile placement, not physics, so
// exact numerical parity with sim-server isn't required — only a visually smooth curve through
// the same waypoints.
function catmullRomPoints(waypoints: Point[], samplesPerSegment: number): Point[] {
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

  const points: Point[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = waypoints[i];
    const p3 = waypoints[i + 1];
    const segLen = Math.hypot(p3.x - p0.x, p3.y - p0.y) || 1;
    const scale = segLen / 3;
    const t0 = tangentAt(i);
    const t1 = tangentAt(i + 1);
    const p1 = { x: p0.x + t0.x * scale, y: p0.y + t0.y * scale };
    const p2 = { x: p3.x - t1.x * scale, y: p3.y - t1.y * scale };
    for (let s = 0; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const mt = 1 - t;
      points.push({
        x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
        y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y
      });
    }
  }
  return points;
}

// Evenly-spaced samples along an approach's centerline — a straight line when no waypoints are
// given, or a smooth curve through them otherwise.
export function sampleCenterline(
  approach: { laneStartX: number; laneStartY: number; laneEndX: number; laneEndY: number; waypoints?: { x: number; y: number }[] },
  step: number
): CenterlineSample[] {
  const rawPoints =
    approach.waypoints && approach.waypoints.length >= 3
      ? catmullRomPoints(approach.waypoints, 12)
      : [
          { x: approach.laneStartX, y: approach.laneStartY },
          { x: approach.laneEndX, y: approach.laneEndY }
        ];

  const cum: number[] = [0];
  for (let i = 1; i < rawPoints.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(rawPoints[i].x - rawPoints[i - 1].x, rawPoints[i].y - rawPoints[i - 1].y));
  }
  const totalLength = cum[cum.length - 1] || 1;

  const pointAt = (d: number): Point => {
    const clamped = Math.max(0, Math.min(d, totalLength));
    let idx = cum.findIndex((c) => c >= clamped);
    if (idx <= 0) idx = 1;
    const segStart = cum[idx - 1];
    const segEnd = cum[idx];
    const t = segEnd > segStart ? (clamped - segStart) / (segEnd - segStart) : 0;
    const a = rawPoints[idx - 1];
    const b = rawPoints[idx];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const headingAt = (d: number): number => {
    const eps = Math.min(step / 4, totalLength / 4) || 0.01;
    const a = pointAt(Math.max(0, d - eps));
    const b = pointAt(Math.min(totalLength, d + eps));
    return Math.atan2(b.y - a.y, b.x - a.x);
  };

  const samples: CenterlineSample[] = [];
  const count = Math.max(1, Math.round(totalLength / step));
  for (let i = 0; i <= count; i++) {
    const d = (i / count) * totalLength;
    const p = pointAt(d);
    samples.push({ x: p.x, y: p.y, heading: headingAt(d) });
  }
  return samples;
}
