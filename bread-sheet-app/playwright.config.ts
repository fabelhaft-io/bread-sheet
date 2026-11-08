import { defineConfig, devices } from '@playwright/test';

/**
 * E2E specs run against Expo web (`npm run web`, i.e. `expo start --web`), not a native
 * emulator: headless Chromium has no camera, so the scan flows are unreachable here. Those
 * are covered by the Maestro suite instead (`npm run test:maestro`, TICKET-P9-003) — see
 * docs/architecture/frontend.md.
 *
 * The specs sign in as a guest, so they need a Supabase auth server with anonymous sign-ins
 * enabled. Run them against a local stack (`supabase start` from the repo root, using
 * `supabase/config.toml`) with EXPO_PUBLIC_SUPABASE_URL and
 * EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY taken from `supabase status` and exported
 * *before* this runs: Expo inlines EXPO_PUBLIC_* when the webServer below starts, and an
 * exported value wins over `bread-sheet-app/.env`. CI does exactly that (the `e2e` job in
 * .github/workflows/test.yml); README.md has the local commands.
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
