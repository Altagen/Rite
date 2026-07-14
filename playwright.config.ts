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
      testIgnore: [
        /smoke\.spec\.ts/,
        /accounts\.spec\.ts/,
        /accounts-env\.spec\.ts/,
        /proxy\.spec\.ts/,
      ],
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    // Server mode (ADR 0010): its own rite-server on :1422, independent of the
    // local-vault suite.
    {
      name: 'accounts',
      testMatch: /accounts\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:1422' },
    },
    // Env-based admin bootstrap on :1423 (proves server Argon2 == browser Argon2).
    {
      name: 'accounts-env',
      testMatch: /accounts-env\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:1423' },
    },
    // Local multiplexer on :1424 proxying to the remote :1423 (ADR 0012 phase 2).
    {
      name: 'proxy',
      testMatch: /proxy\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:1424' },
    },
  ],
  webServer: [
    {
      command: 'sh e2e/serve.sh',
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'sh e2e/serve-accounts.sh',
      url: 'http://127.0.0.1:1422/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'sh e2e/serve-accounts-env.sh',
      url: 'http://127.0.0.1:1423/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'sh e2e/serve-proxy.sh',
      url: 'http://127.0.0.1:1424/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
