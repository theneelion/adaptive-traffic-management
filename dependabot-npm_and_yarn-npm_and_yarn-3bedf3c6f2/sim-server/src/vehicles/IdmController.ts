export interface IdmState {
  speed: number;
  position: number;
}

export interface IdmParams {
  v0: number;
  T: number;
  aMax: number;
  b: number;
  delta: number;
  s0: number;
  vehicleLength: number;
}

export function idmAcceleration(self: IdmState, leader: IdmState | null, params: IdmParams): number {
  const freeRoadTerm = 1 - Math.pow(self.speed / params.v0, params.delta);

  if (!leader) {
    return params.aMax * freeRoadTerm;
  }

  const gap = Math.max(leader.position - self.position - params.vehicleLength, 0.1);
  const deltaV = self.speed - leader.speed;
  const sStar =
    params.s0 +
    Math.max(self.speed * params.T + (self.speed * deltaV) / (2 * Math.sqrt(params.aMax * params.b)), 0);

  return params.aMax * (freeRoadTerm - Math.pow(sStar / gap, 2));
}
