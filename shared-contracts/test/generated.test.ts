import { describe, it, expect } from "vitest";
import type { ClientInputMessage } from "../generated/ts/client-input.schema";

describe("generated contract types", () => {
  it("accepts a well-formed ClientInputMessage", () => {
    const msg: ClientInputMessage = {
      type: "input",
      ts: 123,
      payload: { carId: "car_1", throttle: 0.5, brake: 0, steer: 0.1, inputMethod: "keyboard" }
    };
    expect(msg.payload.carId).toBe("car_1");
  });
});
