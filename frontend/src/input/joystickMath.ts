export interface JoystickOutput {
  throttle: number;
  brake: number;
  steer: number;
}

export function computeJoystickOutput(dx: number, dy: number, maxRadius: number): JoystickOutput {
  const clampedDX = Math.max(-maxRadius, Math.min(maxRadius, dx));
  const clampedDY = Math.max(-maxRadius, Math.min(maxRadius, dy));

  const steer = maxRadius === 0 ? 0 : clampedDX / maxRadius;
  const throttle = clampedDY < 0 ? Math.min(1, -clampedDY / maxRadius) : 0;
  const brake = clampedDY > 0 ? Math.min(1, clampedDY / maxRadius) : 0;

  return { throttle, brake, steer };
}
