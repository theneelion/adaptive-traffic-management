export type SignalLightState = "green" | "yellow" | "red";

type SubState = "green" | "yellow" | "all_red";

export class SignalPhaseMachine {
  private activePhaseId: string;
  private subState: SubState = "green";
  private elapsedInSubStateMs = 0;
  private greenElapsedMs = 0;
  private pendingPhaseId: string | null = null;

  constructor(initialPhaseId: string, private readonly yellowMs = 3000, private readonly allRedMs = 1500) {
    this.activePhaseId = initialPhaseId;
  }

  requestPhase(phaseId: string): void {
    if (this.subState !== "green") return; // mid-transition: cannot be interrupted or redirected
    if (phaseId === this.activePhaseId) return; // already there
    this.pendingPhaseId = phaseId;
    this.subState = "yellow";
    this.elapsedInSubStateMs = 0;
  }

  step(dtMs: number): void {
    this.elapsedInSubStateMs += dtMs;

    if (this.subState === "green") {
      this.greenElapsedMs += dtMs;
      return;
    }
    if (this.subState === "yellow" && this.elapsedInSubStateMs >= this.yellowMs) {
      this.subState = "all_red";
      this.elapsedInSubStateMs = 0;
      return;
    }
    if (this.subState === "all_red" && this.elapsedInSubStateMs >= this.allRedMs) {
      this.activePhaseId = this.pendingPhaseId ?? this.activePhaseId;
      this.pendingPhaseId = null;
      this.subState = "green";
      this.elapsedInSubStateMs = 0;
      this.greenElapsedMs = 0;
    }
  }

  get currentPhaseId(): string {
    return this.activePhaseId;
  }

  get greenElapsedMsValue(): number {
    return this.greenElapsedMs;
  }

  lightStateFor(phaseId: string): SignalLightState {
    if (phaseId !== this.activePhaseId) return "red";
    if (this.subState === "green") return "green";
    if (this.subState === "yellow") return "yellow";
    return "red"; // all_red: even the "active" phase shows red during universal clearance
  }
}
