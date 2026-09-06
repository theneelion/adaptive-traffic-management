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

## Deviation from the above: this repo generates these assets procedurally

This checklist describes the human-driven workflow (external image-generation tool + Aseprite)
the plan was originally written for. This repo's automation can't drive an external image
generator or a GUI pixel editor, so instead `frontend/scripts/generateSpriteSources.mjs` draws
every sprite in the table above directly with `@napi-rs/canvas`, deterministically, and writes
the PNGs straight into this directory with the exact filenames the table specifies. That gets the
same "cleanup checklist" properties for free by construction: exact pixel dimensions, transparent
background, a single limited palette shared across assets, and pixel-grid-aligned (no
anti-aliasing) edges — there's nothing to alpha-punch or crop because nothing is generated with
that noise in the first place.

Run `node scripts/generateSpriteSources.mjs` (or `pnpm assets:generate`) from `frontend/` to
(re)produce every source PNG. It's idempotent — re-running overwrites the same deterministic
output, so it's safe to run again after editing the script or before `pnpm assets:pack` (Task 2).

Car sprites are drawn 36x18 (not the general 32x32 tile size above) — that exactly matches
`VehicleBody`'s real Matter.js body dimensions (`sim-server/src/vehicles/VehicleBody.ts`,
`Matter.Bodies.rectangle(..., 36, 18, ...)`), nose pointing along local +x/east (heading=0), so a
sprite dropped in at native size lines up with its own physics footprint with no scale correction
needed in `MainScene`.
