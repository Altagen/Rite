import { defineConfig, devices } from '@playwright/test';

/**
 * E2E harness for the client/server model: Playwright drives the real frontend
 * served by a real rite-server (embedded frontend replaced by RITE_WEB_DIR so
 * the UI can be rebuilt without recompiling the server). This is how we verify
 * feature parity with the old 0.1.x desktop app on the new HTTP/WS transport.
 */

const PORT = Number(process.env.RITE_E2E_PORT ?? 1421);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // smoke.spec.ts performs the first-run master-password setup through the UI,
    // establishing the vault the rest of the suite runs against.
    {
      name: 'setup',
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: /smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'sh e2e/serve.sh',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
