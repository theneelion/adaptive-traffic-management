// free-tex-packer-core's CJS module does `module.exports = pack; module.exports.packAsync = ...`
// — the function itself is the export, not a named `{ pack }` — so under Node's ESM interop the
// default import IS the callable pack function directly.
import pack from "free-tex-packer-core";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SOURCE_DIR = "assets/source";
const OUT_DIR = "assets/atlas";

const images = readdirSync(SOURCE_DIR)
  .filter((f) => f.endsWith(".png"))
  .map((f) => ({ path: f, contents: readFileSync(path.join(SOURCE_DIR, f)) }));

if (images.length === 0) {
  console.error(`No PNGs found in ${SOURCE_DIR} — run Task 1 (asset generation) first.`);
  process.exit(1);
}

// removeFileExtension: true is required — textureSelection.ts's carTextureFor/pedestrianTextureFor
// /signalTextureFor return bare names ("car_ev", not "car_ev.png"), and Phaser looks a frame up by
// exactly the name registered from the packed JSON's `filename` field, so a mismatched ".png" here
// would make every this.add.sprite(..., "game-atlas", carTextureFor(...)) call silently fail to
// find its frame at runtime.
pack(images, { textureName: "game-atlas", exporter: "Phaser3", removeFileExtension: true }, (files, error) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(OUT_DIR, file.name), file.buffer);
  }
  console.log(`Packed ${images.length} sprites into ${OUT_DIR}/game-atlas.{png,json}`);
});
