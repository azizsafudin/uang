import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Repo root = two levels up from e2e/tests/.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const TEST_SECRET = "e2e-test-secret-0123456789-abcdefghij"; // >= 32 chars
const portOffset = Number(process.env.E2E_PORT_OFFSET ?? 0);

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label}`);
}

export class Backend {
  apiPort: number;
  webPort: number;
  apiURL: string;
  webURL: string;
  private web?: ChildProcess;
  private api?: ChildProcess;

  constructor(workerIndex: number) {
    this.apiPort = 3100 + portOffset + workerIndex;
    this.webPort = 5300 + portOffset + workerIndex;
    this.apiURL = `http://localhost:${this.apiPort}`;
    this.webURL = `http://localhost:${this.webPort}`;
  }

  async startWeb() {
    this.web = spawn(
      "bun",
      ["run", "dev", "--", "--port", String(this.webPort), "--strictPort"],
      {
        cwd: path.join(repoRoot, "apps/web"),
        env: { ...process.env, VITE_API_URL: this.apiURL },
        stdio: "ignore",
      },
    );
    await waitFor(async () => (await fetch(this.webURL)).ok, 60_000, "web dev server");
  }

  // Restart the API on a brand-new in-memory DB. Each test calls this for a clean slate:
  // killing the process discards the `:memory:` database, and the new process migrates
  // a fresh one on boot. Nothing touches disk, so there are no files to track or clean up.
  async freshDb() {
    if (this.api) {
      this.api.kill("SIGKILL");
      this.api = undefined;
      await new Promise((r) => setTimeout(r, 200));
    }
    this.api = spawn("bun", ["apps/api/src/index.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: ":memory:",
        PORT: String(this.apiPort),
        BETTER_AUTH_SECRET: TEST_SECRET,
        WEB_ORIGIN: this.webURL,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });
    await waitFor(async () => (await fetch(`${this.apiURL}/health`)).ok, 30_000, "api /health");
  }

  dispose() {
    this.api?.kill("SIGKILL");
    this.web?.kill("SIGKILL");
  }
}

export const test = base.extend<{}, { backend: Backend }>({
  backend: [
    async ({}, use, workerInfo) => {
      const backend = new Backend(workerInfo.workerIndex);
      await backend.startWeb();
      await use(backend);
      backend.dispose();
    },
    { scope: "worker" },
  ],
  // Point every test's page at this worker's web server.
  baseURL: async ({ backend }, use) => {
    await use(backend.webURL);
  },
});

export { expect };
