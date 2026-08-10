import { test, expect } from '@playwright/test';

/**
 * Golden path: guest sign-in lands on the tab navigator. Requires a working
 * bread-sheet-app/.env (Supabase project reachable) — this hits real auth, same as the
 * manual testing flow documented in README.md.
 */
test('guest can sign in and reach the Home tab', async ({ page }) => {
  await page.goto('/');

  await page.getByText('Continue as Guest').click();

  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15_000 });
});
