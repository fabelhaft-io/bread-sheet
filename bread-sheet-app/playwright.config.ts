import { defineConfig, devices } from '@playwright/test';

/**
 * E2E specs run against Expo web (`npm run web`, i.e. `expo start --web`). Native-only
 * camera/barcode coverage lives in `e2e/maestro` and runs through `npm run test:maestro`.
 * Web auth specs use the same Supabase config as the app; they skip locally when those
 * credentials are absent and execute in configured CI/reviewer environments.
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
