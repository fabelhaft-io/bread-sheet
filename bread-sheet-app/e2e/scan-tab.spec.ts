import { test, expect } from '@playwright/test';

/**
 * The Scan tab must render usefully without camera access (headless Chromium has none,
 * and CLAUDE.md's camera-free-path principle applies here too) — it should prompt for
 * permission rather than crash or hang. See app/(tabs)/scan.tsx.
 */
test('Scan tab renders a camera-permission prompt when no camera is available', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Continue as Guest').click();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15_000 });

  await page.getByText('Scan', { exact: true }).click();

  await expect(page.getByText('Camera access is needed to scan barcodes.')).toBeVisible();
  await expect(page.getByText('Allow Camera')).toBeVisible();
});
