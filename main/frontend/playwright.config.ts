import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  webServer: [
    {
      command: "cd ../ai-service && uv run uvicorn app.main:app --port 8000",
      port: 8000,
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    },
    {
      command: "cd ../sim-server && pnpm dev",
      port: 8080,
      env: { AI_SERVICE_URL: "http://localhost:8000", DEBUG_ENDPOINTS: "1" },
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    },
    {
      command: "pnpm exec vite",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    }
  ],
  use: {
    baseURL: "http://localhost:5173",
    hasTouch: true
  }
});
