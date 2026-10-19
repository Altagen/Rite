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
  /**
   * 60s rather than Playwright's 30s.
   *
   * That default assumes a browser test: a page, some DOM, an assertion. This suite drives
   * a real sshd in a container and waits for a terminal emulator to paint what came back
   * over the wire — seconds of genuine work before anything can be asserted. Measured: with
   * half this machine's cores busy, 7 of 23 failures were the per-test budget running out
   * while the test was still making progress, which fails naming an assertion that had not
   * timed out and teaches you to read red as noise.
   *
   * It does not hide a hang: a test that is truly stuck still fails, 30 seconds later than
   * it used to, and there are 114 of them so that costs nothing in practice.
   */
  timeout: 60_000,
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
        /screenshots\.spec\.ts/,
        /mock\.spec\.ts/,
        /instance-config\.spec\.ts/,
        /accounts\.spec\.ts/,
        /accounts-env\.spec\.ts/,
        /proxy\.spec\.ts/,
        /tls-proxy\.spec\.ts/,
      ],
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    // The README's images, taken by driving the real UI (`e2e/tests/screenshots.spec.ts`):
    //
    //   sh e2e/harness-up.sh
    //   RITE_SHOTS=1 npx playwright test --project=shots
    //
    // Behind a flag, and not part of a plain `playwright test`. They are a generator
    // rather than a guarantee: they seed a presentable library and drive it to a chosen
    // moment, which the state left by the rest of the suite (a locked vault, a signed-out
    // session) breaks — without saying anything about the product. A test that fails for
    // reasons outside what it asserts teaches you to ignore red.
    {
      name: 'shots',
      testMatch: process.env.RITE_SHOTS ? /screenshots\.spec\.ts/ : /$^/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    // The UX mock (design/mock) — plain pages opened from disk, so no server and no
    // vault setup. It runs here rather than on its own because the mock is the source
    // of truth for UI/UX and had nothing watching it (ADR 0019).
    {
      name: 'mock',
      testMatch: /mock\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Server mode (ADR 0010): its own rite-server on :1422, independent of the
    // local-vault suite.
    {
      name: 'accounts',
      testMatch: /accounts\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:1422' },
    },
    // An instance governed by a configuration file on :1427 (ADR 0020): the console has to
    // show what it cannot change, which is only observable against a configured server.
    {
      name: 'config',
      testMatch: /instance-config\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:1427' },
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
      // Anchor on a path separator so this doesn't also match tls-proxy.spec.ts.
      testMatch: /[\\/]proxy\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:1424' },
    },
    // Local multiplexer on :1426 proxying to the self-signed TLS remote :1425 —
    // cert TOFU pin then login over the TLS proxy (ADR 0012 phase 4).
    {
      name: 'tls-proxy',
      testMatch: /tls-proxy\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:1426' },
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
      command: 'sh e2e/serve-accounts-config.sh',
      url: 'http://127.0.0.1:1427/api/health',
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
    {
      // Self-signed TLS remote: wait on the TCP port (an https health check would
      // fail cert validation in Node — the mux validates it via the pinned rustls).
      command: 'sh e2e/serve-accounts-tls.sh',
      port: 1425,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'sh e2e/serve-proxy-tls.sh',
      url: 'http://127.0.0.1:1426/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
