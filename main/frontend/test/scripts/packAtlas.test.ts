import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

describe("assets:pack", () => {
  beforeAll(() => {
    execSync("pnpm assets:pack", { cwd: process.cwd() });
  });

  it("produces an atlas PNG and JSON", () => {
    expect(existsSync("assets/atlas/game-atlas.png")).toBe(true);
    expect(existsSync("assets/atlas/game-atlas.json")).toBe(true);
  });

  it("the atlas JSON lists every required frame name", () => {
    const atlas = JSON.parse(readFileSync("assets/atlas/game-atlas.json", "utf-8"));
    // The installed free-tex-packer-core's "Phaser3" exporter emits the multi-atlas-shaped
    // `{ textures: [{ frames: [...] }] }` structure (still valid input for Phaser's
    // load.atlas()/JSONArray parser, which explicitly supports both shapes — see
    // Phaser.Textures.Parsers.JSONArray in node_modules/phaser/dist/phaser.js), not a flat
    // top-level `frames` object/array — so frame names are read from there.
    const frameNames = atlas.textures[0].frames.map((f: { filename: string }) => f.filename);
    const required = [
      "car_user",
      "car_idm",
      "car_ev",
      "pedestrian_walk_0",
      "pedestrian_walk_1",
      "road_straight",
      "road_intersection",
      "sidewalk",
      "crosswalk",
      "signal_green",
      "signal_yellow",
      "signal_red"
    ];
    for (const name of required) {
      expect(frameNames.some((f: string) => f.startsWith(name))).toBe(true);
    }
  });
});
