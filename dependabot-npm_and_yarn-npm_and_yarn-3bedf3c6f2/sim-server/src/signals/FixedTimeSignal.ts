import type { SignalPhaseDef } from "../maps/MapDefinition.js";

export class FixedTimeSignal {
  private index = 0;
  private elapsedMs = 0;

  constructor(private readonly phases: SignalPhaseDef[]) {}

  step(dtMs: number): void {
    this.elapsedMs += dtMs;
    while (this.elapsedMs >= this.phases[this.index].durationMs) {
      this.elapsedMs -= this.phases[this.index].durationMs;
      this.index = (this.index + 1) % this.phases.length;
    }
  }

  get currentPhase(): SignalPhaseDef {
    return this.phases[this.index];
  }

  get msRemaining(): number {
    return this.phases[this.index].durationMs - this.elapsedMs;
  }
}
