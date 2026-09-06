import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/*.spec.ts are Playwright specs, run via `pnpm test:e2e` — vitest's default include glob
    // also matches `*.spec.ts`, and collecting a Playwright test() call outside its own runner
    // throws ("Playwright Test did not expect test() to be called here").
    exclude: ["**/node_modules/**", "e2e/**"]
  }
});
