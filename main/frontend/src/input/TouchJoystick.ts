import Phaser from "phaser";
import { computeJoystickOutput, type JoystickOutput } from "./joystickMath";

const MAX_RADIUS = 60;

export class TouchJoystick {
  private active = false;
  private originX = 0;
  private originY = 0;
  private currentDX = 0;
  private currentDY = 0;
  readonly knob: Phaser.GameObjects.Arc;
  readonly base: Phaser.GameObjects.Arc;

  constructor(scene: Phaser.Scene, zoneX: number, zoneY: number, zoneRadius: number) {
    this.base = scene.add.circle(zoneX, zoneY, zoneRadius, 0xffffff, 0.15).setScrollFactor(0);
    this.knob = scene.add.circle(zoneX, zoneY, zoneRadius / 3, 0xffffff, 0.4).setScrollFactor(0);

    const zone = scene.add.zone(zoneX, zoneY, zoneRadius * 2, zoneRadius * 2).setInteractive().setScrollFactor(0);

    zone.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.active = true;
      this.originX = pointer.x;
      this.originY = pointer.y;
    });
    scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.active) return;
      this.currentDX = pointer.x - this.originX;
      this.currentDY = pointer.y - this.originY;
      this.knob.setPosition(zoneX + this.getOutput().steer * MAX_RADIUS, zoneY);
    });
    scene.input.on("pointerup", () => {
      this.active = false;
      this.currentDX = 0;
      this.currentDY = 0;
      this.knob.setPosition(zoneX, zoneY);
    });
  }

  isActive(): boolean {
    return this.active;
  }

  getOutput(): JoystickOutput {
    return computeJoystickOutput(this.currentDX, this.currentDY, MAX_RADIUS);
  }
}
