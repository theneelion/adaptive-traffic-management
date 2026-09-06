import type { VehicleBody } from "../vehicles/VehicleBody.js";

interface Claim {
  clientId: string;
  car: VehicleBody;
  pendingRevertMs: number | null;
}

export class RoomManager {
  private readonly claimsByCarId = new Map<string, Claim>();
  private readonly carIdByClientId = new Map<string, string>();

  constructor(
    private readonly getClaimableVehicle: () => VehicleBody | null,
    private readonly maxHumanCars: number,
    private readonly disconnectGraceMs: number
  ) {}

  join(clientId: string): { carId: string } | { error: "capacity_reached" } {
    if (this.claimsByCarId.size >= this.maxHumanCars) return { error: "capacity_reached" };

    const car = this.getClaimableVehicle();
    if (!car) return { error: "capacity_reached" };

    car.controller = "user";
    this.claimsByCarId.set(car.id, { clientId, car, pendingRevertMs: null });
    this.carIdByClientId.set(clientId, car.id);
    return { carId: car.id };
  }

  leave(clientId: string): void {
    const carId = this.carIdByClientId.get(clientId);
    if (!carId) return;
    const claim = this.claimsByCarId.get(carId);
    if (claim) claim.pendingRevertMs = 0;
  }

  step(dtMs: number): void {
    for (const [carId, claim] of [...this.claimsByCarId.entries()]) {
      if (claim.pendingRevertMs === null) continue;
      claim.pendingRevertMs += dtMs;
      if (claim.pendingRevertMs >= this.disconnectGraceMs) {
        claim.car.controller = "idm";
        this.claimsByCarId.delete(carId);
        this.carIdByClientId.delete(claim.clientId);
      }
    }
  }

  ownerOf(carId: string): string | null {
    return this.claimsByCarId.get(carId)?.clientId ?? null;
  }
}
