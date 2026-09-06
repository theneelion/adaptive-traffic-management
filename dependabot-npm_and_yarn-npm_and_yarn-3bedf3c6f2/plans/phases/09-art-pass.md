# Phase 9: Art Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every placeholder rectangle/circle in the frontend with AI-generated, cleaned-up pixel-art/vector sprites packed into a Phaser texture atlas — pure visual polish, zero changes to simulation, AI, or networking logic.

**Architecture:** This phase is deliberately light on new testable logic — it's an asset-production pass followed by a rendering swap. The one piece of real logic (which texture frame a given entity/state should use) is factored into small pure functions, same pattern as `joystickMath.ts` (Phase 4) and `steering.ts` (Phase 5), so at least the *selection* logic is unit-tested even though the *rendering* itself is manual/visual-only verification. Atlas packing is scripted (not done by hand in a GUI) so it's reproducible and re-runnable whenever an asset changes. A texture-existence fallback keeps the placeholder shapes working if the atlas fails to load — this is not defensive-programming-for-its-own-sake, it's what lets every prior phase's manual smoke tests keep working verbatim if this phase is done partially or out of order.

**Tech Stack:** An external image-generation tool for initial sprite generation (human-driven, outside this repo's automation), Aseprite (or equivalent) for pixel-level cleanup, `free-tex-packer-core` (scripted atlas packing, Phaser-compatible JSON output).

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §9 (art pipeline), §14 step 9. Also read [`00-overview.md`](00-overview.md) — no new Interface ledger entries from this phase (see Task 4). Also read [`01-core-loop.md`](01-core-loop.md) Task 7 (`MainScene`'s placeholder rendering) — this phase's rendering changes all land there.

## Global Constraints

- All Phase 1-8 Global Constraints still apply.
- No sim-server, ai-service, or shared-contracts changes in this phase — everything here is `frontend`-only plus a one-time asset-production step outside the app's runtime.
- No image-gen API calls happen at runtime — asset generation is a one-time offline production step; anything committed to the repo is a static asset (TR-15).
- Every test suite passing before this phase (unit, integration, determinism, load, E2E) must still pass unmodified after it — a regression here is a sign this phase touched something it shouldn't have.

---

### Task 1: Asset list and generation prompts

**Files:**
- Create: `frontend/assets/source/ASSET_BRIEF.md`

**Interfaces:** none — this is a production brief, not code.

- [ ] **Step 1: Write the asset brief**

`frontend/assets/source/ASSET_BRIEF.md`:
```markdown
# Sprite asset brief

Style target: polished pixel-art (32x32 base tile grid), top-down orientation, muted asphalt/concrete palette with saturated accent colors for vehicles so they read clearly against the road.

## Required sprites

| Asset | Frames | Notes |
|---|---|---|
| `car_user` | 1 | Top-down car, distinct accent color (e.g. cyan) — the human-driven car |
| `car_idm` | 1 | Top-down car, neutral color (e.g. silver/grey) — ordinary AI traffic |
| `car_ev` | 1 | Ambulance — white body, red accent, small light-bar detail |
| `pedestrian_walk_0` / `pedestrian_walk_1` | 2 | Simple top-down pedestrian, two-frame walk cycle (legs together / legs apart) |
| `road_straight` | 1 | Asphalt tile with a single dashed lane-marking down the middle, tileable |
| `road_intersection` | 1 | 4-way intersection tile with stop-line markings on all four sides |
| `sidewalk` | 1 | Concrete tile, tileable |
| `crosswalk` | 1 | Zebra-crossing marking tile, oriented for a horizontal crossing (rotate in code for vertical) |
| `signal_green` / `signal_yellow` / `signal_red` | 3 | Small traffic-light icon, all three states — the simulation runs a real yellow/all-red clearance (Phase 2), so yellow needs its own frame, not just green/red |

## Generation prompts (starting point — iterate as needed)

- Cars: "top-down 2D pixel art sprite of a compact sedan, 32x32, [color] body, transparent background, arcade racing game style"
- Ambulance: "top-down 2D pixel art sprite of an ambulance, 32x32, white body with red cross and light bar, transparent background"
- Pedestrian: "top-down 2D pixel art sprite of a walking person, 16x16, simple silhouette, transparent background, two-frame walk cycle"
- Road tiles: "seamless tileable top-down pixel art asphalt road texture, 32x32, dashed yellow center line, transparent background where not asphalt"

## Cleanup checklist (per asset, in Aseprite or equivalent)

- [ ] Crop to exact intended tile size (32x32 or 16x16, per table above)
- [ ] Transparent background (alpha-punch any generation artifacts)
- [ ] Palette-snap to a consistent, limited palette across all assets (avoid a mismatched-generation look)
- [ ] Pixel-grid-align edges (no anti-aliased fuzz at tile boundaries for tileable assets)
- [ ] Export as individual PNGs into `frontend/assets/source/`, named exactly as the table's `Asset` column
```

- [ ] **Step 2: Produce the assets (manual, outside version-controlled automation)**

Generate each sprite per the brief, clean it up per the checklist, and place the final PNGs at `frontend/assets/source/<name>.png`. This step has no automated verification — Task 2's packer script is what first confirms the files exist and are well-formed.

- [ ] **Step 3: Commit the brief and raw source assets**

```bash
git add frontend/assets/source
git commit -m "docs+assets: add sprite asset brief and generated/cleaned source PNGs"
```

---

### Task 2: Scripted atlas packing

**Files:**
- Create: `frontend/scripts/packAtlas.mjs`
- Modify: `frontend/package.json` (add `assets:pack` script and `free-tex-packer-core` dev dependency)
- Test: `frontend/test/scripts/packAtlas.test.ts`

**Interfaces:**
- Produces: `frontend/assets/atlas/game-atlas.png` + `frontend/assets/atlas/game-atlas.json` (Phaser-compatible texture atlas).

- [ ] **Step 1: Add the packer dependency and script entry**

Modify `frontend/package.json`:
```json
"scripts": {
  "assets:pack": "node scripts/packAtlas.mjs"
},
"devDependencies": {
  "free-tex-packer-core": "^0.3.1"
}
```

- [ ] **Step 2: Write the packing script**

`frontend/scripts/packAtlas.mjs`:
```js
import { pack } from "free-tex-packer-core";
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

pack(images, { textureName: "game-atlas", exporter: "Phaser3" }, (files) => {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(OUT_DIR, file.name), file.buffer);
  }
  console.log(`Packed ${images.length} sprites into ${OUT_DIR}/game-atlas.{png,json}`);
});
```

- [ ] **Step 3: Write the failing test (validates the packer's output, given a small fixture set of source images)**

`frontend/test/scripts/packAtlas.test.ts`:
```ts
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
    const frameNames = Object.keys(atlas.frames);
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
      expect(frameNames.some((f) => f.startsWith(name))).toBe(true);
    }
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter frontend test -- packAtlas`
Expected: FAIL — either the script doesn't exist yet, or (if Task 1's assets aren't produced yet) it exits with the "no PNGs found" error. Both are valid failure states at this point in the plan; don't proceed to Step 5 until Task 1's real assets exist.

- [ ] **Step 5: Run `pnpm assets:pack` with real assets in place, then re-run the test**

Run: `cd frontend && pnpm assets:pack && pnpm test -- packAtlas`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/scripts/packAtlas.mjs frontend/package.json frontend/assets/atlas frontend/test/scripts/packAtlas.test.ts
git commit -m "feat(frontend): scripted, Phaser-compatible texture atlas packing"
```

---

### Task 3: Texture-selection pure functions (unit tested)

**Files:**
- Create: `frontend/src/render/textureSelection.ts`
- Test: `frontend/test/render/textureSelection.test.ts`

**Interfaces:**
- Produces: `function carTextureFor(controller: "idm" | "user" | "ev"): string`, `function signalTextureFor(light: "green" | "yellow" | "red"): string`, `function pedestrianTextureFor(walkFrameIndex: number): string`.

Note: `signalTextureFor` takes the light state directly, not a phase id — `ServerStateSnapshot.payload.signals[].light` (Phase 2, Task 6) already carries `"green" | "yellow" | "red"` over the wire, so there's no phase-name-to-color guessing to do client-side; the server is the single source of truth for what color is actually showing, including during the yellow/all-red clearance.

- [ ] **Step 1: Write the failing test**

`frontend/test/render/textureSelection.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { carTextureFor, signalTextureFor, pedestrianTextureFor } from "../../src/render/textureSelection";

describe("textureSelection", () => {
  it("maps each vehicle controller to a distinct texture", () => {
    expect(carTextureFor("user")).toBe("car_user");
    expect(carTextureFor("idm")).toBe("car_idm");
    expect(carTextureFor("ev")).toBe("car_ev");
  });

  it("maps each light state to its own texture, including yellow", () => {
    expect(signalTextureFor("green")).toBe("signal_green");
    expect(signalTextureFor("yellow")).toBe("signal_yellow");
    expect(signalTextureFor("red")).toBe("signal_red");
  });

  it("alternates pedestrian walk frames based on frame index parity", () => {
    expect(pedestrianTextureFor(0)).toBe("pedestrian_walk_0");
    expect(pedestrianTextureFor(1)).toBe("pedestrian_walk_1");
    expect(pedestrianTextureFor(2)).toBe("pedestrian_walk_0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend test -- textureSelection`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `textureSelection.ts`**

`frontend/src/render/textureSelection.ts`:
```ts
export function carTextureFor(controller: "idm" | "user" | "ev"): string {
  return `car_${controller}`;
}

export function signalTextureFor(light: "green" | "yellow" | "red"): string {
  return `signal_${light}`;
}

export function pedestrianTextureFor(walkFrameIndex: number): string {
  return walkFrameIndex % 2 === 0 ? "pedestrian_walk_0" : "pedestrian_walk_1";
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `pnpm --filter frontend test -- textureSelection`
Expected: PASS (3 tests).

```bash
git add frontend/src/render/textureSelection.ts frontend/test/render/textureSelection.test.ts
git commit -m "feat(frontend): pure texture-selection functions for vehicles, signals, and pedestrians"
```

---

### Task 4: Wire the atlas into `MainScene`, replacing placeholders

**Files:**
- Modify: `frontend/src/scenes/MainScene.ts`

**Interfaces:** none new (Interface ledger unaffected by this phase — purely a rendering change inside a file every prior phase already modifies).

- [ ] **Step 1: Load the atlas in `preload()`, with a fallback flag**

Modify `frontend/src/scenes/MainScene.ts` — add:
```ts
preload() {
  this.load.atlas("game-atlas", "assets/atlas/game-atlas.png", "assets/atlas/game-atlas.json");
}
```
Add a private getter used everywhere sprites are created: `private get hasAtlas(): boolean { return this.textures.exists("game-atlas"); }`. If the atlas failed to load (e.g. Task 1/2 haven't produced it yet in a partial checkout), every creation site below falls back to the pre-existing placeholder shape — nothing crashes.

- [ ] **Step 2: Replace vehicle rendering**

Modify the `onState` callback's vehicle loop — replace the `add.rectangle` placeholder creation with:
```ts
if (!sprite) {
  sprite = this.hasAtlas
    ? this.add.sprite(v.x, v.y, "game-atlas", carTextureFor(v.controller))
    : this.add.rectangle(v.x, v.y, 18, 36, v.controller === "ev" ? 0xff2222 : 0x3388ff);
  this.carSprites.set(v.id, sprite);
}
```
(`carSprites`'s type widens from `Map<string, Phaser.GameObjects.Rectangle>` to `Map<string, Phaser.GameObjects.Rectangle | Phaser.GameObjects.Sprite>` — both share `.setPosition`/`.setRotation`, so the rest of the update loop is unchanged.)

Import `carTextureFor` from `../render/textureSelection`.

- [ ] **Step 3: Replace pedestrian rendering with a walk-cycle**

Modify the pedestrian loop (Phase 5 Task 3) — track a per-pedestrian frame toggle based on movement, alternating roughly twice per second:
```ts
if (!sprite) {
  sprite = this.hasAtlas
    ? this.add.sprite(p.x, p.y, "game-atlas", pedestrianTextureFor(0))
    : this.add.circle(p.x, p.y, 5, 0xffcc00);
  this.pedestrianSprites.set(p.id, sprite);
  this.pedestrianWalkTick.set(p.id, 0);
}
sprite.setPosition(p.x, p.y);
if (this.hasAtlas && "setTexture" in sprite) {
  const tick = (this.pedestrianWalkTick.get(p.id) ?? 0) + 1;
  this.pedestrianWalkTick.set(p.id, tick);
  if (tick % 15 === 0) (sprite as Phaser.GameObjects.Sprite).setTexture("game-atlas", pedestrianTextureFor(Math.floor(tick / 15)));
}
```
Add `private pedestrianWalkTick = new Map<string, number>();` alongside the existing pedestrian fields.

- [ ] **Step 4: Replace the signal indicator and road tiles**

Replace the `signalDot` circle with an atlas sprite (fallback to the existing circle if no atlas), swapped via `signalTextureFor(snapshot.payload.signals[0].light)` on every state update — reading the `light` field directly (Phase 2, Task 6) rather than inferring color from the phase id, so yellow renders correctly during the clearance sequence instead of jumping straight from green to red. Add a one-time (in `create()`, before any dynamic sprites) tiling background using `road_straight`/`road_intersection`/`sidewalk`/`crosswalk` frames laid out to match `grid_1x1_v1`'s geometry — a static background, built once from the map's own `approaches`/`intersections`/`pedestrianNodes` data (already available client-side via the same map JSON, fetched once at startup rather than duplicated by hand) rather than hardcoded pixel positions, so it doesn't silently drift from the map if `grid_1x1_v1.json` ever changes.

- [ ] **Step 5: Run the full frontend suite and the Phase 8 E2E suite to confirm nothing regressed**

Run: `pnpm --filter frontend test && pnpm --filter frontend test:e2e`
Expected: PASS — this phase should not change any test's outcome, only what's visually rendered.

- [ ] **Step 6: Manual visual smoke test**

Run: `docker compose -f infra/docker-compose.yml up --build`
Expected: cars, pedestrians, signals, and road tiles all render as sprites (not placeholder shapes); pedestrians visibly alternate walk frames; the EV renders distinctly from regular traffic.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/scenes/MainScene.ts
git commit -m "feat(frontend): swap placeholder shapes for atlas sprites across vehicles, pedestrians, signals, and road tiles"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes (new, narrow) | `textureSelection.ts`'s three pure functions; atlas-packing output validation |
| Integration | Unaffected | No Node↔Python or WS message shape changed |
| Physics/determinism | Unaffected | Rendering-only phase |
| Load | Unaffected | Sprite rendering is client-side only; doesn't touch server tick budget |
| RL regression | N/A | Unaffected |
| E2E | Re-run, unmodified | Phase 8's `driveAndEv.spec.ts` must still pass verbatim — the strongest signal this phase didn't touch logic |

## Definition of Done

- [ ] All required sprites exist, cleaned up, atlas-packed, and validated by `packAtlas.test.ts`.
- [ ] `MainScene` renders sprites instead of placeholder shapes when the atlas is present, and gracefully falls back to placeholders when it isn't.
- [ ] Every test suite from Phases 1-8 (`pnpm -r test`, `pnpm --filter sim-server test -- collisionDeterminism pedestrianDeterminism`, `pnpm --filter frontend test:e2e`) passes unmodified.
- [ ] Manual visual smoke test (Task 4 Step 6) confirms the demo reads as "polished pixel-art," not placeholder shapes.

## Risks / open implementation notes

- The background-tile layout (Task 4 Step 4) deriving positions from the map JSON rather than hardcoding them is the one piece of this phase with any real logic — if it proves fiddly to get pixel-perfect, a hardcoded-but-clearly-commented fallback for `grid_1x1_v1` specifically is an acceptable fallback, since there's currently only one map to support (per spec's own map-count decision) and generalizing further has no current consumer.
- If image-generation output quality requires several iterations to reach a usable, consistent-palette set, that iteration time isn't estimated here — it's the one genuinely open-ended part of an otherwise mechanical phase.
