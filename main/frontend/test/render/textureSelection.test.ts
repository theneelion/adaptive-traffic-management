import { describe, it, expect } from "vitest";
import { carTextureFor, signalTextureFor, pedestrianTextureFor } from "../../src/render/textureSelection";

describe("textureSelection", () => {
  it("maps each vehicle controller to a distinct texture", () => {
    expect(carTextureFor("user")).toBe("car_user");
    expect(carTextureFor("idm")).toBe("car_idm");
    expect(carTextureFor("ev")).toBe("car_ev");
  });

  it("maps each light state to its own texture, including yellow", () => {
    expect(signalTextureFor("green")).toBe("signal_green");
    expect(signalTextureFor("yellow")).toBe("signal_yellow");
    expect(signalTextureFor("red")).toBe("signal_red");
  });

  it("alternates pedestrian walk frames based on frame index parity", () => {
    expect(pedestrianTextureFor(0)).toBe("pedestrian_walk_0");
    expect(pedestrianTextureFor(1)).toBe("pedestrian_walk_1");
    expect(pedestrianTextureFor(2)).toBe("pedestrian_walk_0");
  });
});
