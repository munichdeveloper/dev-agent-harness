// Default chromium project: Playwright's bundled headless shell, as the loopback prompt tells the worker.
// The test file avoids the *.spec.* name, which the repository's own vitest run would collect.
import { defineConfig } from '@playwright/test';
const url = 'http://127.0.0.1:41873';
export default defineConfig({ testDir: '.', testMatch: 'loopback.pw.mjs', reporter: 'line', retries: 0, workers: 1, use: { baseURL: url },
  webServer: { command: 'node server.mjs', env: { PORT: '41873' }, url, reuseExistingServer: false } });
