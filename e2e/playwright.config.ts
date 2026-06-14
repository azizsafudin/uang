import { defineConfig, devices } from "@playwright/test";

// Servers + baseURL are provided per-worker by the `backend` fixture (tests/fixtures.ts),
// so there is no top-level `webServer` and no static baseURL here.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
  // Each worker boots a real web+API stack; a cold first navigation under concurrent
  // boot can occasionally time out. One retry absorbs that without masking real failures.
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: "on-first-retry", actionTimeout: 15_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
