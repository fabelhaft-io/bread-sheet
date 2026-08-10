import { defineConfig, devices } from '@playwright/test';

/**
 * E2E specs run against Expo web (`npm run web`, i.e. `expo start --web`), not a native
 * emulator — see docs/architecture/agent-dev-team.md for why (no Android SDK on this
 * machine yet; Maestro/Android is a documented follow-up, not built). Needs the same
 * `bread-sheet-app/.env` Supabase config the app normally needs to run — see README.md.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run web',
        url: 'http://localhost:8081',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
