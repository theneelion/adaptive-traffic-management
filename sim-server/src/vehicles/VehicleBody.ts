import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld.js";
import { MATTER_VELOCITY_SCALE } from "../physics/realSpeed.js";

// Vehicle acceleration/braking is a direct kinematic velocity update, not an applied Matter force.
// A force-based approach was tried first (a MAX_FORCE constant scaling throttle-brake into
// Matter.Body.applyForce) but is fundamentally unstable at this sim's control cadence: IDM
// recomputes throttle/brake once per 50ms tick, and applying that as a constant force for the
// whole tick — while Matter's own force/friction dynamics integrate it across 3 physics substeps —
// creates a feedback loop once a vehicle is braking toward a near-stationary leader (e.g. a red
// light). Each tick's overshoot inflates the next tick's braking demand (via IDM's speed-dependent
// sStar term), and within ~20 ticks it locks into permanent full-reverse-thrust, converging to a
// force-vs-friction terminal reverse speed (~57 u/s) — a car that appears to "explode" backwards
// out of a queue. No single force constant resolves this: values strong enough for a realistic
// free-road cruise (~15 u/s) are also strong enough to trigger the instability; values weak enough
// to avoid it cap free-road cruise at ~3-5 u/s. Setting velocity directly from the IDM-derived
// acceleration each tick (exact one-step Euler integration, matching how the steering angle is
// already set directly via setAngularVelocity rather than torque) sidesteps the feedback loop
// entirely: there is no multi-substep force integration for linear motion to overshoot.
// This is the vehicle chassis's own physical capability ceiling, at least as large as the most
// demanding caller's IDM aMax/b (EvRouter's EV_IDM_PARAMS: aMax=2.5, b=3.0 — faster/harder-braking
// than a regular car's aMax=1.5, b=2.0). throttle/brake are normalized fractions of *each caller's
// own* aMax/b, so a caller with a lower aMax can never request more than its own share of this
// ceiling; only IDM's steady-state cruise speed (governed solely by v0, not aMax) matters for a
// regular car's eventual behavior, so sharing this higher ceiling only affects transient
// responsiveness, never the resulting cruise/following speeds.
const MAX_ACCEL_REAL = 2.5; // u/s^2
const MAX_BRAKE_REAL = 3.0; // u/s^2
const DEFAULT_DT_S = 0.05; // this sim's fixed external tick duration (20Hz, TR-2)
const MAX_STEER_TORQUE = 0.002;
// Hard physical ceiling on a vehicle's real speed — generously above the fastest legitimate
// controller (EvRouter's EV_IDM_PARAMS.v0 = 22) but far below what a Matter.js collision-resolution
// impulse can inject into a densely-packed queue (observed directly: a stationary queued vehicle
// jumping to 57-78 u/s in a single 50ms tick after another vehicle overlapped it — physically
// impossible via this function's own accel/brake limits, which cap a one-tick change at
// MAX_ACCEL_REAL*0.05 = 0.125 u/s). Without this clamp, applyInput's `currentSpeed` read below
// treats whatever velocity Matter's own solver just left on the body as legitimate and continues
// incrementing from there — meaning an injected spike doesn't get overridden, it persists and only
// slowly decays via braking, reading as a car suddenly rocketing away from a queue (a real user
// report, reproduced directly by long-running the city map under real traffic).
const MAX_REALISTIC_SPEED = 30;

export class VehicleBody {
  readonly body: Matter.Body;
  public controller: "idm" | "user" | "ev" = "idm";

  constructor(
    world: PhysicsWorld,
    public readonly id: string,
    spawn: { x: number; y: number; heading: number }
  ) {
    // Matter.Bodies.rectangle's width/height are local-X/Y extents *before* the `angle` rotation is
    // applied. heading=0 means "facing +x" everywhere else in this codebase (TurnPaths, steering,
    // IDM's vehicleLength=36), so the LENGTH (36, along travel direction) must be the width
    // parameter and the WIDTH (18, perpendicular) must be the height parameter. Passing (18, 36)
    // here put the long axis perpendicular to travel instead — a car's true half-width became 18
    // instead of 9, which is enough to physically reach the intentionally-shortened perpendicular
    // N/S walls near the intersection (sized for a 9-unit half-width — see PhysicsWorld.ts) and get
    // permanently wedged there once real (non-buggy-fast) speeds gave Matter's overlap-resolution
    // solver time to act, producing a freeze-then-launch "runaway" collision.
    // frictionAir: 0 is deliberate — braking/deceleration is fully modeled by applyInput's own
    // kinematic update (via the `brake` input), so Matter's own per-substep air-friction decay would
    // otherwise silently fight the once-per-tick velocity we set, settling into a much lower
    // equilibrium speed than commanded (found by tracing a "constant full throttle" vehicle that
    // should accelerate linearly but instead plateaued at ~0.5 u/s).
    this.body = Matter.Bodies.rectangle(spawn.x, spawn.y, 36, 18, {
      angle: spawn.heading,
      frictionAir: 0,
      label: `vehicle_${id}`
    });
    Matter.Composite.add(world.engine.world, this.body);
  }

  applyInput(throttle: number, brake: number, steer: number, dtMs: number = DEFAULT_DT_S * 1000): void {
    const t = Math.max(0, Math.min(1, throttle));
    const b = Math.max(0, Math.min(1, brake));
    const accel = t * MAX_ACCEL_REAL - b * MAX_BRAKE_REAL;
    const dtS = dtMs / 1000;

    const currentSpeed = Math.min(Math.hypot(this.body.velocity.x, this.body.velocity.y) * MATTER_VELOCITY_SCALE, MAX_REALISTIC_SPEED);
    const newSpeed = Math.min(Math.max(0, currentSpeed + accel * dtS), MAX_REALISTIC_SPEED);
    const heading = this.body.angle;
    Matter.Body.setVelocity(this.body, {
      x: (Math.cos(heading) * newSpeed) / MATTER_VELOCITY_SCALE,
      y: (Math.sin(heading) * newSpeed) / MATTER_VELOCITY_SCALE
    });
    Matter.Body.setAngularVelocity(this.body, steer * MAX_STEER_TORQUE * 50);
  }
}
