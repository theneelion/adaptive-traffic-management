import type { SignalPhaseDef, ApproachDef } from "../maps/MapDefinition.js";
import type { AiSignalClient } from "./AiSignalClient.js";
import type { QueueDetector } from "./QueueDetector.js";
import { SignalPhaseMachine, type SignalLightState } from "./SignalPhaseMachine.js";

const DECISION_INTERVAL_MS = 1500;

export class SignalController {
  private readonly phaseMachine: SignalPhaseMachine;
  private sinceLastDecisionMs = 0;
  private lastController = "rule_based";
  private forcedPhaseId: string | null = null;

  constructor(
    private readonly phases: SignalPhaseDef[],
    private readonly approaches: ApproachDef[],
    private readonly client: AiSignalClient,
    private readonly detector: QueueDetector,
    private readonly intersectionId: string,
    private readonly getPedestrianCrossingState?: (crossingId: string) => { queueLength: number; waitS: number },
    private readonly crossingIdsByApproach: Record<string, string> = {},
    private requestedController: "rule_based" | "rl" = "rule_based",
    private readonly getEvContext?: () => { evId: string; etaS: number; requiredPhaseId: string } | null,
    private readonly getNeighborIntersections?: () => { intersectionId: string; currentPhaseId: string; timeInPhaseMs: number; totalPressure: number }[]
  ) {
    this.phaseMachine = new SignalPhaseMachine(phases[0].id);
  }

  setRequestedController(mode: "rule_based" | "rl"): void {
    this.requestedController = mode;
  }

  get id(): string {
    return this.intersectionId;
  }

  get currentPhaseId(): string {
    return this.phaseMachine.currentPhaseId;
  }

  get timeInPhaseMs(): number {
    return this.phaseMachine.greenElapsedMsValue;
  }

  // A hard, deterministic override (spec §7.3) — called directly by SimSession's EV green-wave
  // loop, bypassing the AI client entirely while active. Never something the adaptive
  // rule-based/RL decision is expected to "learn" to cooperate with.
  forcePhase(phaseId: string): void {
    this.forcedPhaseId = phaseId;
  }

  clearForcedPhase(): void {
    this.forcedPhaseId = null;
  }

  getApproachSignalStates(): Map<string, SignalLightState> {
    const states = new Map<string, SignalLightState>();
    for (const approach of this.approaches) {
      const phase = this.phases.find((p) => p.allowedApproachIds!.includes(approach.id))!;
      states.set(approach.id, this.phaseMachine.lightStateFor(phase.id));
    }
    return states;
  }

  async step(dtMs: number): Promise<{ phaseId: string; changed: boolean; controller: string }> {
    const previousPhaseId = this.phaseMachine.currentPhaseId;
    this.phaseMachine.step(dtMs);
    this.sinceLastDecisionMs += dtMs;

    if (this.sinceLastDecisionMs >= DECISION_INTERVAL_MS) {
      this.sinceLastDecisionMs = 0;

      if (this.forcedPhaseId !== null) {
        this.phaseMachine.requestPhase(this.forcedPhaseId);
        this.lastController = "forced";
      } else {
        const phaseCandidates = this.phases.map((phase) => {
          let queueLength = 0;
          let waitS = 0;
          for (const approachId of phase.allowedApproachIds!) {
            const state = this.detector.getApproachState(approachId);
            queueLength += state.queueLength;
            waitS = Math.max(waitS, state.waitS);
          }
          return { phaseId: phase.id, queueLength, waitS };
        });

        const approachStates = this.approaches.map((a) => ({
          approachId: a.id,
          ...this.detector.getApproachState(a.id)
        }));

        // ai-service being unreachable (a transient network blip, a restart, or — as found
        // directly in CI — a startup race where sim-server's tick loop starts before ai-service
        // finishes booting) must never crash the whole session for every connected user. Before
        // this try/catch, an unhandled rejection here propagated all the way up through
        // SimSession.step into server.ts's setInterval tick callback (which has no catch of its
        // own), and Node terminates the process on an unhandled rejection — one flaky HTTP call
        // took down the entire server. Falling back to "keep the current phase" on any failure is
        // also the actively safe choice, not just a crash-avoidance shim: it never surprises
        // waiting traffic with an unrequested switch, which is exactly what a real traffic
        // controller's own hardware failsafe does when it loses contact with a central system.
        try {
          const decision = await this.client.decide({
            intersectionId: this.intersectionId,
            currentPhaseId: this.phaseMachine.currentPhaseId,
            timeInPhaseMs: this.phaseMachine.greenElapsedMsValue,
            phaseCandidates,
            pedestrianCrossings: this.getPedestrianCrossingState
              ? Object.entries(this.crossingIdsByApproach).map(([, crossingId]) => ({
                  crossingId,
                  ...this.getPedestrianCrossingState!(crossingId)
                }))
              : [],
            approachStates,
            neighborIntersections: this.getNeighborIntersections ? this.getNeighborIntersections() : [],
            requestedController: this.requestedController,
            evContext: this.getEvContext ? this.getEvContext() : null
          });

          this.phaseMachine.requestPhase(decision.phaseId);
          this.lastController = decision.controller;
        } catch (err) {
          console.error(`[SignalController ${this.intersectionId}] ai-service decision failed, holding current phase:`, err);
          this.lastController = "fallback_hold";
        }
      }
    }

    const changed = this.phaseMachine.currentPhaseId !== previousPhaseId;
    return { phaseId: this.phaseMachine.currentPhaseId, changed, controller: this.lastController };
  }
}
