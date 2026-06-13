import { defineConfig } from '@playwright/test';

/**
 * E2E smoke (CI starts Vite via webServer). Manual perf: npm run perf:test / perf:report
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 300_000,
  use: {
    baseURL: 'http://localhost:1420',
    viewport: { width: 1920, height: 1080 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});