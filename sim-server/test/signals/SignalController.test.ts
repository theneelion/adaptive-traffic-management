import { describe, it, expect, vi } from "vitest";
import { SignalController } from "../../src/signals/SignalController";

const phases = [
  { id: "NS_through", allowedApproachIds: ["app_N", "app_S"], durationMs: 8000 },
  { id: "EW_through", allowedApproachIds: ["app_E", "app_W"], durationMs: 8000 }
];

const approaches = [
  { id: "app_N", intersectionId: "int_1", laneStartX: 0, laneStartY: -300, laneEndX: 0, laneEndY: 0, width: 40 },
  { id: "app_S", intersectionId: "int_1", laneStartX: 0, laneStartY: 300, laneEndX: 0, laneEndY: 0, width: 40 },
  { id: "app_E", intersectionId: "int_1", laneStartX: 300, laneStartY: 0, laneEndX: 0, laneEndY: 0, width: 40 },
  { id: "app_W", intersectionId: "int_1", laneStartX: -300, laneStartY: 0, laneEndX: 0, laneEndY: 0, width: 40 }
] as any;

function fakeDetector(states: Record<string, { queueLength: number; waitS: number }>) {
  return { getApproachState: (id: string) => states[id] ?? { queueLength: 0, waitS: 0 } } as any;
}

describe("SignalController", () => {
  it("stays on the current phase when the AI client returns the same phase", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, approaches, client as any, fakeDetector({}), "int_1");

    const result = await controller.step(1500);
    expect(result.phaseId).toBe("NS_through");
    expect(result.changed).toBe(false);
  });

  it("does not flip immediately when the AI client proposes a new phase — yellow and all-red must elapse first", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "EW_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, approaches, client as any, fakeDetector({}), "int_1");

    const result = await controller.step(1500); // decision made this tick; yellow begins
    expect(result.phaseId).toBe("NS_through"); // still NS_through — yellow hasn't cleared yet
    expect(result.changed).toBe(false);
    expect(controller.currentPhaseId).toBe("NS_through");
  });

  it("commits to the new phase only once yellow (3000ms) and all-red (1500ms) have both elapsed", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "EW_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, approaches, client as any, fakeDetector({}), "int_1");

    await controller.step(1500); // decision + yellow starts
    await controller.step(1500); // yellow: 0 -> 1500ms
    await controller.step(1500); // yellow: 1500 -> 3000ms, transitions to all-red
    expect(controller.currentPhaseId).toBe("NS_through"); // still not committed

    const result = await controller.step(1500); // all-red: 0 -> 1500ms, commits
    expect(result.phaseId).toBe("EW_through");
    expect(result.changed).toBe(true);
  });

  it("aggregates queue state by approach into phaseCandidates sent to the AI client", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const detector = fakeDetector({ app_N: { queueLength: 2, waitS: 3 }, app_S: { queueLength: 1, waitS: 1 } });
    const controller = new SignalController(phases, approaches, client as any, detector, "int_1");

    await controller.step(1500);

    const sentRequest = client.decide.mock.calls[0][0];
    const nsCandidate = sentRequest.phaseCandidates.find((c: any) => c.phaseId === "NS_through");
    expect(nsCandidate.queueLength).toBe(3); // app_N + app_S, both allowed by NS_through
  });

  it("includes pedestrian crossing state in the request when a provider is given", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const crossingMap = { app_N: "cross_N", app_S: "cross_S", app_E: "cross_E", app_W: "cross_W" };
    const controller = new SignalController(
      phases,
      approaches,
      client as any,
      fakeDetector({}),
      "int_1",
      (crossingId: string) => ({ queueLength: crossingId === "cross_N" ? 3 : 0, waitS: crossingId === "cross_N" ? 12 : 0 }),
      crossingMap
    );

    await controller.step(1500);

    const sent = client.decide.mock.calls[0][0];
    const crossN = sent.pedestrianCrossings.find((c: any) => c.crossingId === "cross_N");
    expect(crossN.queueLength).toBe(3);
  });

  it("includes per-approach state and the requested controller mode in the request", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const detector = fakeDetector({ app_N: { queueLength: 2, waitS: 5 } });
    const controller = new SignalController(phases, approaches, client as any, detector, "int_1", undefined, undefined, "rl");

    await controller.step(1500);

    const sent = client.decide.mock.calls[0][0];
    expect(sent.requestedController).toBe("rl");
    const appN = sent.approachStates.find((a: any) => a.approachId === "app_N");
    expect(appN.queueLength).toBe(2);
  });

  it("getApproachSignalStates keys states by this intersection's own approach IDs, not a hardcoded compass set", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, approaches, client as any, fakeDetector({}), "int_1");

    const states = controller.getApproachSignalStates();
    expect(new Set(states.keys())).toEqual(new Set(["app_N", "app_S", "app_E", "app_W"]));
  });

  it("forcePhase overrides the AI client entirely and drives the phase machine directly", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, approaches, client as any, fakeDetector({}), "int_1");

    controller.forcePhase("EW_through");
    await controller.step(1500); // decision tick: forced, yellow begins toward EW_through
    await controller.step(1500); // yellow: 0 -> 1500ms
    await controller.step(1500); // yellow: 1500 -> 3000ms, transitions to all-red
    const result = await controller.step(1500); // all-red: 0 -> 1500ms, commits

    expect(result.phaseId).toBe("EW_through");
    expect(result.controller).toBe("forced");
    expect(client.decide).not.toHaveBeenCalled();
  });

  it("clearForcedPhase resumes calling the AI client on the next decision interval", async () => {
    const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, approaches, client as any, fakeDetector({}), "int_1");

    controller.forcePhase("EW_through");
    await controller.step(1500);
    controller.clearForcedPhase();
    await controller.step(1500);

    expect(client.decide).toHaveBeenCalledTimes(1);
  });

  it("holds the current phase instead of throwing when the AI client rejects (e.g. ai-service unreachable)", async () => {
    const client = { decide: vi.fn().mockRejectedValue(new Error("fetch failed")) };
    const controller = new SignalController(phases, approaches, client as any, fakeDetector({}), "int_1");

    const result = await controller.step(1500);
    expect(result.phaseId).toBe("NS_through");
    expect(result.changed).toBe(false);
    expect(result.controller).toBe("fallback_hold");
  });

  it("recovers on the next decision interval once the AI client stops rejecting", async () => {
    const client = { decide: vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
    const controller = new SignalController(phases, approaches, client as any, fakeDetector({}), "int_1");

    await controller.step(1500);
    const result = await controller.step(1500);
    expect(result.controller).toBe("rule_based");
  });
});
