// Generic "is there an obstacle directly in my lane, ahead of me" check, shared by
// TrafficController and EvRouter for detecting pedestrians in a vehicle's path. Neither system had
// any pedestrian-awareness at all before this — pedestrians and vehicles were simulated as
// independent, physically-colliding systems with no avoidance logic on the vehicle side, so a
// pedestrian standing (e.g. waiting at a crosswalk, or mid-jaywalk) anywhere that overlapped a
// vehicle's physical path could permanently wedge it — found directly: an EV stuck motionless for
// minutes turned out to have an active, ongoing Matter.js collision with a pedestrian standing in
// its lane, not just another vehicle.
export interface ObstaclePoint {
  x: number;
  y: number;
}

// Uses a straight lane-corridor (forward distance + lateral offset from the direct centerline),
// not a wide angle cone — an angle-only check widens dramatically with distance (at 60 units and a
// ~28-degree cone, the lateral spread is ~28 units, easily wide enough to include a pedestrian
// legitimately standing at a crosswalk corner off to the side, never actually in the lane). A
// pedestrian only counts as blocking if they're within `lateralTolerance` of dead-ahead, roughly
// matching how wide a real lane actually is — a real regression found directly: an earlier
// angle-only version of this check made ordinary waiting pedestrians permanently stop traffic on
// the plain single-intersection map, not just the new city map.
export function findObstacleAhead(
  position: { x: number; y: number },
  heading: number,
  points: ObstaclePoint[],
  scanDistance: number,
  lateralTolerance: number
): { distance: number } | null {
  const forwardX = Math.cos(heading);
  const forwardY = Math.sin(heading);
  const perpX = -forwardY;
  const perpY = forwardX;
  let best: { distance: number } | null = null;
  for (const p of points) {
    const dx = p.x - position.x;
    const dy = p.y - position.y;
    const forwardDistance = dx * forwardX + dy * forwardY;
    if (forwardDistance <= 0 || forwardDistance > scanDistance) continue;
    const lateralDistance = Math.abs(dx * perpX + dy * perpY);
    if (lateralDistance > lateralTolerance) continue;
    if (!best || forwardDistance < best.distance) best = { distance: forwardDistance };
  }
  return best;
}
