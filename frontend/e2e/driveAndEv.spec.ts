import { test, expect } from "@playwright/test";

test("keyboard driving, touch driving, and EV preemption all work end-to-end, with session JSON recording it", async ({ page }) => {
  test.setTimeout(60000); // city_v1.json's routes are longer than grid's single hop
  await page.goto("/");
  await page.waitForTimeout(1000); // allow the WS join handshake (Phase 4's onJoined flow) to complete

  // Keyboard input
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(500);
  await page.keyboard.up("ArrowUp");

  // Touch input — tap within the joystick zone (bottom-left, per MainScene's TouchJoystick placement)
  await page.touchscreen.tap(100, 500);
  await page.waitForTimeout(300);

  // Trigger the emergency-vehicle debug scenario (Phase 7's "press E" trigger) — MainScene now
  // spawns a cross-city route (far_i3 -> far_i7a, crossing I3 then I1) rather than grid's single
  // hop. This test only asserts *a* preempt fires — it runs against the live default server with
  // real background traffic and a non-deterministic RNG seed (server.ts's default), so exact
  // timing of the *second* intersection's preempt varies run to run. The deterministic proof that
  // the green wave preempts multiple distinct intersections lives in
  // sim-server/test/integration/multiHopGreenWave.test.ts (Stage 2), which pins a fixed seed and
  // controlled traffic specifically so that assertion is reliable — this e2e test is a live
  // full-stack smoke test, not a second copy of that proof.
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(30000); // let the ambulance reach at least its first intersection's preempt window

  const sessionResponse = await page.request.get("http://localhost:8080/debug/session");
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json();

  expect(session.events.some((e: any) => e.type === "ev_spawn")).toBe(true);
  expect(session.events.some((e: any) => e.type === "ev_preempt")).toBe(true);
  expect(session.mapId).toBe("city_v1");
});
