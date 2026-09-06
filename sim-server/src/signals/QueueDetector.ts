import Matter from "matter-js";
import type { PhysicsWorld } from "../physics/PhysicsWorld.js";
import type { ApproachDef } from "../maps/MapDefinition.js";
import type { VehicleBody } from "../vehicles/VehicleBody.js";
import { realSpeed } from "../physics/realSpeed.js";

const QUEUE_SPEED_THRESHOLD = 0.5;

export class QueueDetector {
  private readonly inZone = new Map<string, Set<string>>();
  private readonly waitStartMs = new Map<string, number>();
  private nowMs = 0;

  constructor(world: PhysicsWorld, approaches: ApproachDef[]) {
    for (const approach of approaches) this.inZone.set(approach.id, new Set());

    Matter.Events.on(world.engine, "collisionStart", (event) => this.handleCollision(event, true));
    Matter.Events.on(world.engine, "collisionEnd", (event) => this.handleCollision(event, false));
  }

  private handleCollision(event: Matter.IEventCollision<Matter.Engine>, entering: boolean): void {
    for (const pair of event.pairs) {
      const bodies = [pair.bodyA, pair.bodyB];
      const sensor = bodies.find((b) => b.label.endsWith("_queue_zone"));
      const vehicle = bodies.find((b) => b.label.startsWith("vehicle_"));
      if (!sensor || !vehicle) continue;

      const approachId = sensor.label.replace("_queue_zone", "");
      const vehicleId = vehicle.label.replace("vehicle_", "");
      const set = this.inZone.get(approachId);
      if (!set) continue;

      if (entering) {
        set.add(vehicleId);
      } else {
        set.delete(vehicleId);
        this.waitStartMs.delete(vehicleId);
      }
    }
  }

  step(dtMs: number, vehicles: VehicleBody[]): void {
    this.nowMs += dtMs;
    for (const ids of this.inZone.values()) {
      for (const vehicleId of ids) {
        const vehicle = vehicles.find((v) => v.id === vehicleId);
        if (!vehicle) continue;
        const speed = realSpeed(vehicle.body);
        if (speed < QUEUE_SPEED_THRESHOLD) {
          if (!this.waitStartMs.has(vehicleId)) this.waitStartMs.set(vehicleId, this.nowMs);
        } else {
          this.waitStartMs.delete(vehicleId);
        }
      }
    }
  }

  getApproachState(approachId: string): { queueLength: number; waitS: number } {
    const ids = this.inZone.get(approachId) ?? new Set<string>();
    const waits = [...ids].map((id) => {
      const start = this.waitStartMs.get(id);
      return start === undefined ? 0 : (this.nowMs - start) / 1000;
    });
    return { queueLength: ids.size, waitS: waits.length ? Math.max(...waits) : 0 };
  }
}
