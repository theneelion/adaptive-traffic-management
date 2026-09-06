import { createCanvas } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Task 1 (plans/phases/09-art-pass.md) as written assumes a human drives an external
// image-generation tool + Aseprite outside this repo. Neither is available to run this
// automatically, so every sprite in ASSET_BRIEF.md's table is instead drawn procedurally here
// with @napi-rs/canvas — deterministic, no network calls, re-runnable any number of times with
// identical output (TR-15: nothing generated at runtime, this is a one-time production step).

const OUT_DIR = path.join(process.cwd(), "assets", "source");
mkdirSync(OUT_DIR, { recursive: true });

// One shared palette across every asset so the set reads as one style pass rather than a
// mismatched grab-bag — the concern the plan's Aseprite "palette-snap" cleanup step exists for.
const PALETTE = {
  asphalt: "#3b3f42",
  asphaltEdge: "#2f3235",
  laneMarking: "#f2c14e",
  concrete: "#9a9d9f",
  concreteJoint: "#86898b",
  crosswalkStripe: "#e8e8e0",
  carUser: "#29c5e6",
  carIdm: "#b8bcc0",
  carEv: "#f2f2ef",
  carEvAccent: "#d33a2c",
  carWindow: "#1b1f22",
  carShadow: "#00000055",
  skin: "#e0a878",
  shirt: "#3b6ea5",
  legs: "#2b2f33",
  signalHousing: "#2b2f33",
  signalHousingEdge: "#1a1d20",
  greenLit: "#2ecc71",
  greenDim: "#234a30",
  yellowLit: "#f1c40f",
  yellowDim: "#4a3f1a",
  redLit: "#e74c3c",
  redDim: "#4a2320"
};

function save(name, canvas) {
  const buffer = canvas.toBuffer("image/png");
  writeFileSync(path.join(OUT_DIR, `${name}.png`), buffer);
  console.log(`wrote ${name}.png (${canvas.width}x${canvas.height})`);
}

// Cars are drawn 36x18 — matching VehicleBody's real Matter.js rectangle (36 long x 18 wide,
// sim-server/src/vehicles/VehicleBody.ts) exactly, nose pointing along local +x (east), so the
// atlas frame lines up 1:1 with the physics footprint at heading=0 with no scale correction.
const CAR_W = 36;
const CAR_H = 18;

function drawCar(bodyColor, { isEv = false } = {}) {
  const canvas = createCanvas(CAR_W, CAR_H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = PALETTE.carShadow;
  ctx.beginPath();
  ctx.roundRect(2, 2, CAR_W - 2, CAR_H - 2, 4);
  ctx.fill();

  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.roundRect(1, 1, CAR_W - 4, CAR_H - 2, 5);
  ctx.fill();

  // Windshield + rear window read as a top-down cabin, offset toward the nose (+x) so heading is
  // visually unambiguous even before any accent color is applied.
  ctx.fillStyle = PALETTE.carWindow;
  ctx.beginPath();
  ctx.roundRect(CAR_W * 0.32, 3, CAR_W * 0.4, CAR_H - 6, 2);
  ctx.fill();

  if (isEv) {
    // Light bar: small red/blue-ish alternating blocks along the roofline.
    const barY = 1;
    const barH = 3;
    const blockW = 4;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i % 2 === 0 ? PALETTE.carEvAccent : "#3a6fd8";
      ctx.fillRect(CAR_W / 2 - 6 + i * blockW, barY, blockW - 1, barH);
    }
    // Red cross on the cabin roof.
    ctx.fillStyle = PALETTE.carEvAccent;
    const cx = CAR_W * 0.6;
    const cy = CAR_H / 2;
    ctx.fillRect(cx - 3, cy - 1, 6, 2);
    ctx.fillRect(cx - 1, cy - 3, 2, 6);
  } else {
    // Nose/tail accent stripes so left/right (front/back) read clearly at a glance.
    ctx.fillStyle = "#00000030";
    ctx.fillRect(1, 1, 3, CAR_H - 2);
    ctx.fillRect(CAR_W - 5, 1, 3, CAR_H - 2);
  }

  return canvas;
}

// Pedestrians are 16x16, top-down, two-frame walk cycle (legs together / legs apart).
const PED_SIZE = 16;

function drawPedestrian(legsApart) {
  const canvas = createCanvas(PED_SIZE, PED_SIZE);
  const ctx = canvas.getContext("2d");
  const cx = PED_SIZE / 2;

  ctx.fillStyle = PALETTE.legs;
  if (legsApart) {
    ctx.fillRect(cx - 3, 9, 2, 6);
    ctx.fillRect(cx + 1, 9, 2, 6);
  } else {
    ctx.fillRect(cx - 1.5, 9, 3, 6);
  }

  ctx.fillStyle = PALETTE.shirt;
  ctx.beginPath();
  ctx.roundRect(cx - 4, 4, 8, 7, 2);
  ctx.fill();

  ctx.fillStyle = PALETTE.skin;
  ctx.beginPath();
  ctx.arc(cx, 3, 3, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

const TILE = 32;

function drawRoadStraight() {
  const canvas = createCanvas(TILE, TILE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PALETTE.asphalt;
  ctx.fillRect(0, 0, TILE, TILE);
  ctx.strokeStyle = PALETTE.asphaltEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);

  // Default orientation: a vertical (N/S) road, dashed centerline running top-to-bottom.
  // MainScene rotates this 90 degrees for E/W approaches (Task 4).
  ctx.fillStyle = PALETTE.laneMarking;
  const dashH = 6;
  const gap = 4;
  for (let y = 1; y < TILE; y += dashH + gap) {
    ctx.fillRect(TILE / 2 - 1, y, 2, dashH);
  }

  return canvas;
}

function drawRoadIntersection() {
  const canvas = createCanvas(TILE, TILE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PALETTE.asphalt;
  ctx.fillRect(0, 0, TILE, TILE);
  ctx.strokeStyle = PALETTE.asphaltEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);

  // Stop-line markings inset from all four sides, one per approach direction.
  ctx.fillStyle = PALETTE.laneMarking;
  const inset = 5;
  const thickness = 2;
  ctx.fillRect(inset, inset - thickness, TILE - inset * 2, thickness); // N edge
  ctx.fillRect(inset, TILE - inset, TILE - inset * 2, thickness); // S edge
  ctx.fillRect(inset - thickness, inset, thickness, TILE - inset * 2); // W edge
  ctx.fillRect(TILE - inset, inset, thickness, TILE - inset * 2); // E edge

  return canvas;
}

function drawSidewalk() {
  const canvas = createCanvas(TILE, TILE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PALETTE.concrete;
  ctx.fillRect(0, 0, TILE, TILE);

  // Expansion-joint lines, tileable (drawn only at the seam-aligned edges so adjacent tiles form
  // a continuous grid rather than doubled-up lines).
  ctx.strokeStyle = PALETTE.concreteJoint;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0.5);
  ctx.lineTo(TILE, 0.5);
  ctx.moveTo(0.5, 0);
  ctx.lineTo(0.5, TILE);
  ctx.stroke();

  return canvas;
}

function drawCrosswalk() {
  const canvas = createCanvas(TILE, TILE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PALETTE.asphalt;
  ctx.fillRect(0, 0, TILE, TILE);

  // Zebra bars oriented for a horizontal crossing: each bar is elongated top-to-bottom (parallel
  // to travel direction on the vertical road it defaults onto) and the bars are spaced left-to-
  // right across the crossing width. MainScene rotates 90 degrees for a vertical crossing
  // (Task 4), matching the same convention road_straight uses.
  ctx.fillStyle = PALETTE.crosswalkStripe;
  const barW = 4;
  const gap = 3;
  for (let x = 2; x < TILE; x += barW + gap) {
    ctx.fillRect(x, 2, barW, TILE - 4);
  }

  return canvas;
}

const SIGNAL_W = 16;
const SIGNAL_H = 34;

function drawSignal(litLens) {
  const canvas = createCanvas(SIGNAL_W, SIGNAL_H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = PALETTE.signalHousing;
  ctx.beginPath();
  ctx.roundRect(1, 1, SIGNAL_W - 2, SIGNAL_H - 2, 3);
  ctx.fill();
  ctx.strokeStyle = PALETTE.signalHousingEdge;
  ctx.lineWidth = 1;
  ctx.stroke();

  const lensRadius = (SIGNAL_W - 6) / 2;
  const centers = [SIGNAL_H * 0.22, SIGNAL_H * 0.5, SIGNAL_H * 0.78];
  const lensOrder = ["red", "yellow", "green"];
  const litColors = { red: PALETTE.redLit, yellow: PALETTE.yellowLit, green: PALETTE.greenLit };
  const dimColors = { red: PALETTE.redDim, yellow: PALETTE.yellowDim, green: PALETTE.greenDim };

  lensOrder.forEach((color, i) => {
    ctx.fillStyle = color === litLens ? litColors[color] : dimColors[color];
    ctx.beginPath();
    ctx.arc(SIGNAL_W / 2, centers[i], lensRadius, 0, Math.PI * 2);
    ctx.fill();
  });

  return canvas;
}

save("car_user", drawCar(PALETTE.carUser));
save("car_idm", drawCar(PALETTE.carIdm));
save("car_ev", drawCar(PALETTE.carEv, { isEv: true }));
save("pedestrian_walk_0", drawPedestrian(false));
save("pedestrian_walk_1", drawPedestrian(true));
save("road_straight", drawRoadStraight());
save("road_intersection", drawRoadIntersection());
save("sidewalk", drawSidewalk());
save("crosswalk", drawCrosswalk());
save("signal_green", drawSignal("green"));
save("signal_yellow", drawSignal("yellow"));
save("signal_red", drawSignal("red"));

console.log(`Generated ${12} sprite sources into ${OUT_DIR}`);
