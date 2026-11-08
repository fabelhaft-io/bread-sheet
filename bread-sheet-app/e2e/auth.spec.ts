import { test, expect } from '@playwright/test';

/**
 * Golden path: guest sign-in lands on the tab navigator. This hits real Supabase auth —
 * the local `supabase start` stack in CI and in README.md's E2E instructions — so it
 * needs anonymous sign-ins enabled there (supabase/config.toml).
 */
test('guest can sign in and reach the Home tab', async ({ page }) => {
  await page.goto('/');

  await page.getByText('Continue as Guest').click();

  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15_000 });
});
