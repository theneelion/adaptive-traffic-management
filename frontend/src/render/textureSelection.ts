export function carTextureFor(controller: "idm" | "user" | "ev"): string {
  return `car_${controller}`;
}

export function signalTextureFor(light: "green" | "yellow" | "red"): string {
  return `signal_${light}`;
}

export function pedestrianTextureFor(walkFrameIndex: number): string {
  return walkFrameIndex % 2 === 0 ? "pedestrian_walk_0" : "pedestrian_walk_1";
}
