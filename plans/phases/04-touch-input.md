# Phase 4: Touch Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add on-screen virtual joystick touch controls alongside keyboard, mapping to the exact same server-side input message shape — the sim server does not know or care which input method sent a message (TR-2).

**Architecture:** This is the shortest phase in the build order (`00-overview.md` §1) — it's purely additive to the frontend's input pipeline; nothing in `sim-server` or `ai-service` changes except one additive, optional schema field. The joystick's coordinate math is factored into a pure function so it's unit-testable without a real Phaser canvas; the Phaser-side pointer-event wiring is thin and verified manually (browser touch emulation), since Playwright E2E doesn't arrive until Phase 8.

**Tech Stack:** Phaser 3's built-in pointer input (no new library — Phaser normalizes mouse/touch/pen into one pointer API already).

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §9, §14 step 4, FR-4, TR-2. Also read [`00-overview.md`](00-overview.md) §6 Phase-4 ledger entry. Also read [`01-core-loop.md`](01-core-loop.md) Task 7 (`SimClient`, `MainScene`) — this phase modifies both directly.

## Global Constraints

- All Phase 1-3 Global Constraints still apply.
- The schema change here is additive only (`00-overview.md` §4's drift check must still pass, and no existing consumer of `ClientInputMessage` breaks).

---

### Task 1: shared-contracts — additive `inputMethod` field

**Files:**
- Modify: `shared-contracts/schemas/client-input.schema.json`
- Modify: `shared-contracts/test/generated.test.ts`

**Interfaces:**
- Produces (Interface ledger, Phase 4): `ClientInputMessage.payload.inputMethod: "keyboard" | "touch"` (additive).

- [ ] **Step 1: Add the field**

Modify `shared-contracts/schemas/client-input.schema.json` — add to `payload.properties` and `payload.required`:
```json
"inputMethod": { "enum": ["keyboard", "touch"] }
```
Add `"inputMethod"` to the existing `"required"` array alongside `carId`, `throttle`, `brake`, `steer`.

- [ ] **Step 2: Regenerate**

Run: `pnpm --filter shared-contracts generate`
Expected: `ClientInputMessage` (TS and Py) now requires `inputMethod`.

- [ ] **Step 3: Update the existing generated-contracts test to include the new required field**

Modify `shared-contracts/test/generated.test.ts` — the `ClientInputMessage` object literal from Phase 1's test needs `inputMethod: "keyboard"` added or it will fail to typecheck:
```ts
const msg: ClientInputMessage = {
  type: "input",
  ts: 123,
  payload: { carId: "car_1", throttle: 0.5, brake: 0, steer: 0.1, inputMethod: "keyboard" }
};
```

- [ ] **Step 4: Update every other place a `ClientInputMessage` payload literal was constructed**

This field is now required, so every existing test/production call site that builds a `ClientInputMessage` payload needs `inputMethod` added:
- `frontend/src/scenes/MainScene.ts` `update()` (Phase 1 Task 7) — keyboard path sends `inputMethod: "keyboard"`.
- `frontend/test/net/SimClient.test.ts` (Phase 1 Task 7) — add `inputMethod: "keyboard"` to the test payload.
- `sim-server/test/server.integration.test.ts` was deleted in Phase 3 Task 6 — nothing to update there.
- `sim-server/test/room/SimSession.test.ts` (Phase 3 Task 6) doesn't construct `ClientInputMessage` payloads directly (it calls `session.applyInput` with positional args, which doesn't include `inputMethod` — that's fine, `applyInput`'s signature is unchanged; `inputMethod` is metadata carried on the wire message only, consumed by nothing server-side, not part of `SimSession.applyInput`'s parameters).

- [ ] **Step 5: Run the full test suite, verify everything still passes**

Run: `pnpm -r test`
Expected: PASS across `shared-contracts`, `sim-server`, `frontend`.

- [ ] **Step 6: Commit**

```bash
git add shared-contracts/schemas/client-input.schema.json shared-contracts/generated shared-contracts/test ai-service/app/contracts frontend/src/scenes/MainScene.ts frontend/test/net/SimClient.test.ts
git commit -m "feat(contracts): add inputMethod field to ClientInputMessage (additive)"
```

---

### Task 2: Joystick math (pure function, unit tested)

**Files:**
- Create: `frontend/src/input/joystickMath.ts`
- Test: `frontend/test/input/joystickMath.test.ts`

**Interfaces:**
- Produces: `function computeJoystickOutput(dx: number, dy: number, maxRadius: number): { throttle: number; brake: number; steer: number }`.

- [ ] **Step 1: Write the failing test**

`frontend/test/input/joystickMath.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeJoystickOutput } from "../../src/input/joystickMath";

describe("computeJoystickOutput", () => {
  it("returns all zeros at the origin", () => {
    expect(computeJoystickOutput(0, 0, 60)).toEqual({ throttle: 0, brake: 0, steer: 0 });
  });

  it("maps upward drag to throttle only", () => {
    const out = computeJoystickOutput(0, -30, 60);
    expect(out.throttle).toBeCloseTo(0.5, 5);
    expect(out.brake).toBe(0);
  });

  it("maps downward drag to brake only", () => {
    const out = computeJoystickOutput(0, 45, 60);
    expect(out.brake).toBeCloseTo(0.75, 5);
    expect(out.throttle).toBe(0);
  });

  it("maps rightward drag to positive steer, clamped to [-1, 1]", () => {
    expect(computeJoystickOutput(90, 0, 60).steer).toBe(1);
    expect(computeJoystickOutput(-90, 0, 60).steer).toBe(-1);
    expect(computeJoystickOutput(30, 0, 60).steer).toBeCloseTo(0.5, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend test -- joystickMath`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `computeJoystickOutput`**

`frontend/src/input/joystickMath.ts`:
```ts
export interface JoystickOutput {
  throttle: number;
  brake: number;
  steer: number;
}

export function computeJoystickOutput(dx: number, dy: number, maxRadius: number): JoystickOutput {
  const clampedDX = Math.max(-maxRadius, Math.min(maxRadius, dx));
  const clampedDY = Math.max(-maxRadius, Math.min(maxRadius, dy));

  const steer = maxRadius === 0 ? 0 : clampedDX / maxRadius;
  const throttle = clampedDY < 0 ? Math.min(1, -clampedDY / maxRadius) : 0;
  const brake = clampedDY > 0 ? Math.min(1, clampedDY / maxRadius) : 0;

  return { throttle, brake, steer };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend test -- joystickMath`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/input/joystickMath.ts frontend/test/input/joystickMath.test.ts
git commit -m "feat(frontend): pure joystick coordinate math"
```

---

### Task 3: `TouchJoystick` — Phaser pointer-event wiring

**Files:**
- Create: `frontend/src/input/TouchJoystick.ts`
- Modify: `frontend/src/scenes/MainScene.ts`

**Interfaces:**
- Consumes: `computeJoystickOutput` (Task 2).
- Produces: `class TouchJoystick` — `constructor(scene: Phaser.Scene, zoneX: number, zoneY: number, zoneRadius: number)`, `.isActive(): boolean`, `.getOutput(): JoystickOutput`.

- [ ] **Step 1: Implement `TouchJoystick`**

No red/green cycle here — this class only wires Phaser's `Phaser.Input.Pointer` events to the already-tested pure function from Task 2; a real assertion would require a live Phaser canvas, which is why Task 4 covers this with manual browser verification instead (see Testing summary).

`frontend/src/input/TouchJoystick.ts`:
```ts
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
```

- [ ] **Step 2: Wire into `MainScene`, merging with keyboard input**

Modify `frontend/src/scenes/MainScene.ts`:
```ts
import { TouchJoystick } from "../input/TouchJoystick";

// in the class, add:
private touchJoystick!: TouchJoystick;

// in create(), after existing cursor setup:
this.touchJoystick = new TouchJoystick(this, 100, this.scale.height - 100, 60);

// replace update()'s body with:
update() {
  let throttle: number;
  let brake: number;
  let steer: number;
  let inputMethod: "keyboard" | "touch";

  if (this.touchJoystick.isActive()) {
    const out = this.touchJoystick.getOutput();
    throttle = out.throttle;
    brake = out.brake;
    steer = out.steer;
    inputMethod = "touch";
  } else {
    throttle = this.cursors.up.isDown ? 1 : 0;
    brake = this.cursors.down.isDown ? 1 : 0;
    steer = this.cursors.left.isDown ? -1 : this.cursors.right.isDown ? 1 : 0;
    inputMethod = "keyboard";
  }

  this.client.sendInput({ carId: "car_1", throttle, brake, steer, inputMethod });
}
```

Note: `carId: "car_1"` here is still a Phase-1 leftover the frontend never updated for Phase 3's multi-car reality — `MainScene` needs to read the `carId` returned by the `"joined"` message (Phase 3 Task 6, `server.ts`) instead of hardcoding `"car_1"`. This was already a latent gap after Phase 3; fixing it belongs here since this task is already touching every line of `update()` — add a `private myCarId: string | null = null;` field, set it from a new `this.client.onJoined(cb)` handler (mirroring `onState`, added to `SimClient`), and guard `update()` to no-op until `myCarId` is set.

- [ ] **Step 3: Extend `SimClient` with the `onJoined` handler needed by Step 2**

Modify `frontend/src/net/SimClient.ts` — add:
```ts
private joinedHandler: ((carId: string) => void) | null = null;

onJoined(cb: (carId: string) => void): void {
  this.joinedHandler = cb;
}
```
and in the constructor's `onmessage`, add a branch: `if (msg.type === "joined" && "carId" in msg.payload && this.joinedHandler) this.joinedHandler(msg.payload.carId);`

Add a test to `frontend/test/net/SimClient.test.ts` mirroring the existing `onState` test, asserting `onJoined`'s callback fires with the right `carId` for a `{ type: "joined", payload: { carId: "car_x" } }` message.

Update `MainScene.create()` to call `this.client.onJoined((carId) => { this.myCarId = carId; });`, and `update()` to `if (!this.myCarId) return;` before building the input payload, using `this.myCarId` instead of the hardcoded `"car_1"`.

- [ ] **Step 4: Run the frontend test suite**

Run: `pnpm --filter frontend test`
Expected: PASS, including the new `onJoined` test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/input/TouchJoystick.ts frontend/src/scenes/MainScene.ts frontend/src/net/SimClient.ts frontend/test/net/SimClient.test.ts
git commit -m "feat(frontend): virtual touch joystick; fix hardcoded carId via onJoined handshake"
```

---

### Task 4: Manual touch verification + README update

**Files:**
- Modify: `README.md`

**Interfaces:** none — verification only.

- [ ] **Step 1: Add a touch-specific smoke test to the README**

Append to `README.md`'s smoke-test section:
```markdown
## Phase 4 manual smoke test (touch)
1. Open Chrome DevTools, toggle device toolbar (touch emulation) on the frontend tab.
2. Confirm the semi-transparent joystick circle renders in the bottom-left.
3. Press and drag within the joystick zone: dragging up accelerates, down brakes, left/right steers — same as arrow keys.
4. Release — the knob recenters and the car coasts (no stuck input).
5. Confirm keyboard input still works when not touching the joystick zone (both input methods coexist without conflict).
```

- [ ] **Step 2: Run the full local stack and perform the 5 steps above**

Run: `docker compose -f infra/docker-compose.yml up --build`
Expected: all 5 steps pass by direct observation.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add Phase 4 touch smoke test"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes | `computeJoystickOutput` (all four directions + clamping) |
| Integration | Unaffected | No Node↔Python surface changed |
| Physics/determinism | Unaffected | Input method is metadata only, doesn't change physics |
| Load | N/A | Phase 8 |
| RL regression | N/A | Phase 6 |
| E2E | Manual only | Touch-emulation walkthrough (Task 4); Playwright automation of both input methods arrives Phase 8 (spec §11's E2E row explicitly calls out "test both keyboard and a simulated touch event") |

## Definition of Done

- [ ] `pnpm -r test` passes with the new `inputMethod` field threaded everywhere it's required.
- [ ] Touch joystick visibly renders and controls the claimed car identically to keyboard.
- [ ] `MainScene` no longer hardcodes `"car_1"` — it drives whichever car the server assigned via the `"joined"` message.
- [ ] Every file in the Interface ledger's "From Phase 4" section (`00-overview.md` §6) exists with the exact signature listed.

## Risks / open implementation notes

- The `MainScene`/`SimClient` `myCarId` fix (Task 3) is scope that technically belongs to Phase 3 (multi-car reality) but was only caught here because Phase 4 is the first time `update()`'s body is touched again — flagged explicitly rather than silently smuggled in, since a future reader diffing "what did Phase 4 do" should know this wasn't strictly touch-input work.
- `inputMethod` is carried on the wire but not yet consumed anywhere server-side (no analytics, no per-method KPI split) — that's intentional (YAGNI): nothing in the spec through Phase 10 requires a keyboard-vs-touch breakdown, so it stays unconsumed metadata until something actually needs it.
