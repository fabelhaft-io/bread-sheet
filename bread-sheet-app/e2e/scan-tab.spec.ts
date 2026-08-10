import { test, expect } from '@playwright/test';

/**
 * The Scan tab must render usefully without camera access (headless Chromium has none,
 * and CLAUDE.md's camera-free-path principle applies here too) — it should prompt for
 * permission rather than crash or hang. See app/(tabs)/scan.tsx.
 */
test('Scan tab renders a camera-permission prompt when no camera is available', async ({ page }) => {
  // The app intentionally uses the real Supabase guest session here. Without a
  // configured project, Expo's web bundle cannot initialise and the test cannot
  // reach the scan tab.
  test.skip(
    !process.env.EXPO_PUBLIC_SUPABASE_URL ||
      !process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    'Supabase E2E credentials are not configured'
  );

  await page.goto('/');
  await page.getByText('Continue as Guest').click();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15_000 });

  await page.getByText('Scan', { exact: true }).click();

  await expect(page.getByText('Camera access is needed to scan barcodes.')).toBeVisible();
  await expect(page.getByText('Allow Camera')).toBeVisible();
});
