export class TrafficSpawner {
  private readonly nextArrivalMs = new Map<string, number>();

  constructor(
    private readonly approachIds: string[],
    private readonly rng: () => number,
    private readonly arrivalRatePerMinPerApproach: number
  ) {
    for (const id of approachIds) this.nextArrivalMs.set(id, this.sampleInterArrivalMs());
  }

  private sampleInterArrivalMs(): number {
    const meanMs = 60_000 / this.arrivalRatePerMinPerApproach;
    const u = Math.max(this.rng(), 1e-9);
    return -Math.log(u) * meanMs;
  }

  step(dtMs: number): string[] {
    const spawns: string[] = [];
    for (const id of this.approachIds) {
      const remaining = this.nextArrivalMs.get(id)! - dtMs;
      if (remaining <= 0) {
        spawns.push(id);
        this.nextArrivalMs.set(id, this.sampleInterArrivalMs());
      } else {
        this.nextArrivalMs.set(id, remaining);
      }
    }
    return spawns;
  }
}
