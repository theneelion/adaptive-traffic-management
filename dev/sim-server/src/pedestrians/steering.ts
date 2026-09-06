export interface SteeringParams {
  walkSpeed: number;
  arrivalRadius: number;
  separationRadius: number;
  separationStrength: number;
  // Despite the name (kept for interface stability), this is a real acceleration cap in u/s^2,
  // not a Matter.js force — PedestrianController.applySteering integrates computeSteeringForce's
  // output directly into velocity (Matter.Body.setVelocity), not via Matter.Body.applyForce. An
  // earlier force-based version was unstable at this sim's 50ms control cadence: a stationary
  // pedestrian steering toward a distant target would oscillate in place (velocity magnitude
  // pegged near 37 u/s while net displacement stayed ~0) instead of ever making progress. Verified
  // empirically (bare-engine sweep) that this value converges cleanly to walkSpeed with zero
  // oscillation, same as vehicles' MAX_ACCEL_REAL/MAX_BRAKE_REAL choice.
  maxForce: number;
}

// walkSpeed is in the same "units/sec" scale as vehicle speeds (IDM's v0=15 crosses a 300-unit
// approach in ~20s). A real-world car:pedestrian speed ratio (~15:1.4) would put walkSpeed at
// ~1.3, but at this map's scale that means several *minutes* to cross the whole intersection —
// fine for physical realism, unusable for an interactive demo (and it starves the population cap
// on any sustained pedestrian-heavy scenario, since arrivals outpace departures). Calibrated
// instead for this map's actual scale: fast enough that a full crossing takes well under a
// minute, still clearly slower than vehicle traffic.
export const DEFAULT_STEERING_PARAMS: SteeringParams = {
  walkSpeed: 8,
  arrivalRadius: 20,
  separationRadius: 12,
  separationStrength: 1.5,
  maxForce: 1.5
};

export function computeSteeringForce(
  self: { x: number; y: number; vx: number; vy: number },
  target: { x: number; y: number },
  neighbors: { x: number; y: number }[],
  params: SteeringParams
): { fx: number; fy: number } {
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  const dist = Math.hypot(dx, dy);
  const desiredSpeed = dist < params.arrivalRadius ? params.walkSpeed * (dist / params.arrivalRadius) : params.walkSpeed;

  let desiredVx = dist > 0 ? (dx / dist) * desiredSpeed : 0;
  let desiredVy = dist > 0 ? (dy / dist) * desiredSpeed : 0;

  for (const other of neighbors) {
    const ox = self.x - other.x;
    const oy = self.y - other.y;
    const d = Math.hypot(ox, oy);
    if (d > 0 && d < params.separationRadius) {
      const strength = params.separationStrength * ((params.separationRadius - d) / params.separationRadius);
      desiredVx += (ox / d) * strength;
      desiredVy += (oy / d) * strength;
    }
  }

  let fx = desiredVx - self.vx;
  let fy = desiredVy - self.vy;
  const mag = Math.hypot(fx, fy);
  if (mag > params.maxForce) {
    fx = (fx / mag) * params.maxForce;
    fy = (fy / mag) * params.maxForce;
  }

  return { fx, fy };
}
