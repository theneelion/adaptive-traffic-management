import Matter from "matter-js";
import type { PhysicsWorld } from "./PhysicsWorld.js";

export type CollisionKind = "vehicle_vehicle" | "vehicle_pedestrian";

export class CollisionLogger {
  constructor(world: PhysicsWorld, onCollision: (entities: [string, string], kind: CollisionKind) => void) {
    Matter.Events.on(world.engine, "collisionStart", (event) => {
      for (const pair of event.pairs) {
        const [a, b] = [pair.bodyA, pair.bodyB];
        if (a.isSensor || b.isSensor) continue;

        const aIsVehicle = a.label.startsWith("vehicle_");
        const bIsVehicle = b.label.startsWith("vehicle_");
        const aIsPed = a.label.startsWith("pedestrian_");
        const bIsPed = b.label.startsWith("pedestrian_");

        if (aIsVehicle && bIsVehicle) {
          onCollision([a.label.replace("vehicle_", ""), b.label.replace("vehicle_", "")], "vehicle_vehicle");
        } else if ((aIsVehicle && bIsPed) || (aIsPed && bIsVehicle)) {
          const vehicleLabel = aIsVehicle ? a.label : b.label;
          const pedLabel = aIsPed ? a.label : b.label;
          onCollision([vehicleLabel.replace("vehicle_", ""), pedLabel.replace("pedestrian_", "")], "vehicle_pedestrian");
        }
      }
    });
  }
}
