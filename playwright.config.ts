import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.test.ts',
  workers: 1,
  timeout: 30_000,
  outputDir: 'test-results',
  use: { channel: process.env.PLAYWRIGHT_CHANNEL, headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'bun run dev',
    url: 'http://127.0.0.1:5373',
    reuseExistingServer: false,
    env: { ADMIN_PASSWORD: 'browser-test-password', DATABASE_PATH: ':memory:', PORT: '3300', PUBLIC_PORT: '5373', ADMIN_PORT: '5374' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
