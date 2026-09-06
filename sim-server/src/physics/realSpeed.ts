import type Matter from "matter-js";

// Matter.js's body.velocity is NOT in real-world units/second — it's normalized to
// units-per-Body._baseDelta, where Body._baseDelta = 1000/60ms (see matter-js's own
// Body.updateVelocities, which documents velocity as "normalised in relation to
// Body._baseDelta"). Since PhysicsWorld.step() always calls Matter.Engine.update() with a
// step size of exactly 1000/60ms, Matter's internal timeScale is always 1, so body.velocity
// reads as "units per 1/60 second" here — a real bug found by actually instantiating the
// physics and comparing IDM/steering's computed "speed" against the vehicle's true rate of
// travel: a car under full IDM throttle (v0=15) was found to settle at a true speed of
// ~836 units/s while its own speed variable read ~13.9 (thinking it was near v0). Every
// consumer that wants a real-world units/second reading must multiply by this factor.
export const MATTER_VELOCITY_SCALE = 60;

export function realSpeed(body: Matter.Body): number {
  return Math.hypot(body.velocity.x, body.velocity.y) * MATTER_VELOCITY_SCALE;
}

export function realVelocity(body: Matter.Body): { x: number; y: number } {
  return { x: body.velocity.x * MATTER_VELOCITY_SCALE, y: body.velocity.y * MATTER_VELOCITY_SCALE };
}
