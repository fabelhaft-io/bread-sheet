import { test, expect } from '@playwright/test';

/**
 * Golden path: guest sign-in lands on the tab navigator. Requires a working
 * bread-sheet-app/.env (Supabase project reachable) — this hits real auth, same as the
 * manual testing flow documented in README.md.
 */
test('guest can sign in and reach the Home tab', async ({ page }) => {
  // A configured Supabase project is required for the real guest-auth flow. Keep the
  // local baseline green for contributors who are only running the native/unit suite;
  // CI and reviewer runs execute this when the documented E2E credentials are present.
  test.skip(
    !process.env.EXPO_PUBLIC_SUPABASE_URL ||
      !process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    'Supabase E2E credentials are not configured'
  );

  await page.goto('/');

  await page.getByText('Continue as Guest').click();

  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15_000 });
});
