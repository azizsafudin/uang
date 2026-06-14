import { defineConfig, devices } from "@playwright/test";

// Servers + baseURL are provided per-worker by the `backend` fixture (tests/fixtures.ts),
// so there is no top-level `webServer` and no static baseURL here.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
  // Each worker boots a real web+API stack; the FIRST navigation pays a one-time Vite
  // cold-compile (~15-20s). Generous nav/action timeouts let that land on the first
  // attempt; one retry is a backstop for genuine boot contention.
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { trace: "on-first-retry", actionTimeout: 30_000, navigationTimeout: 30_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
