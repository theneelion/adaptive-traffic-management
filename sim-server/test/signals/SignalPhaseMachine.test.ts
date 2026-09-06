import { describe, it, expect } from "vitest";
import { SignalPhaseMachine } from "../../src/signals/SignalPhaseMachine";

describe("SignalPhaseMachine", () => {
  it("starts on the initial phase, green; the other phase reads red", () => {
    const machine = new SignalPhaseMachine("NS_through");
    expect(machine.currentPhaseId).toBe("NS_through");
    expect(machine.lightStateFor("NS_through")).toBe("green");
    expect(machine.lightStateFor("EW_through")).toBe("red");
  });

  it("ignores a request for the phase that's already active", () => {
    const machine = new SignalPhaseMachine("NS_through");
    machine.requestPhase("NS_through");
    machine.step(100);
    expect(machine.lightStateFor("NS_through")).toBe("green");
  });

  it("goes yellow immediately on a request for a different phase, then all-red, then commits to the new phase", () => {
    const machine = new SignalPhaseMachine("NS_through", 3000, 1500);

    machine.requestPhase("EW_through");
    expect(machine.lightStateFor("NS_through")).toBe("yellow");
    expect(machine.lightStateFor("EW_through")).toBe("red");

    machine.step(3000); // yellow fully elapses -> all-red begins
    expect(machine.lightStateFor("NS_through")).toBe("red");
    expect(machine.lightStateFor("EW_through")).toBe("red");
    expect(machine.currentPhaseId).toBe("NS_through"); // not committed yet

    machine.step(1500); // all-red fully elapses -> commits
    expect(machine.currentPhaseId).toBe("EW_through");
    expect(machine.lightStateFor("EW_through")).toBe("green");
    expect(machine.lightStateFor("NS_through")).toBe("red");
  });

  it("ignores further requests while mid-transition — the original transition completes regardless", () => {
    const machine = new SignalPhaseMachine("NS_through", 3000, 1500);
    machine.requestPhase("EW_through");
    machine.step(1000);
    machine.requestPhase("NS_through"); // ignored: already transitioning away from NS_through
    machine.step(2000); // yellow total: 3000ms elapsed
    machine.step(1500); // all-red elapses
    expect(machine.currentPhaseId).toBe("EW_through");
  });

  it("tracks green-elapsed time separately from the transition clock, resetting only once a transition commits", () => {
    const machine = new SignalPhaseMachine("NS_through", 3000, 1500);
    machine.step(2000);
    expect(machine.greenElapsedMsValue).toBe(2000);

    machine.requestPhase("EW_through");
    machine.step(3000); // yellow
    machine.step(1500); // all-red -> commits
    expect(machine.greenElapsedMsValue).toBe(0);
  });
});
