import Phaser from "phaser";
import { MainScene } from "./scenes/MainScene";

// The game fills the whole browser window rather than rendering into a fixed-size box (a fixed
// 800x800 canvas under Phaser.Scale.FIT letterboxes inside any non-square window, reading as "a
// small square floating in the middle of the screen" — real feedback from actually looking at it).
// Phaser.Scale.RESIZE keeps the canvas's own pixel size in sync with the window instead, and
// MainScene's own camera auto-fit (computeCameraFit, keyed off this.scale.width/height) already
// recomputes correctly for any canvas size — including on a live window resize, which MainScene
// listens for directly.
new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app",
  backgroundColor: "#222222",
  scene: [MainScene],
  fps: { target: 30 },
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight
  }
});
