import { test, expect } from '@playwright/test';

/**
 * TICKET-P6-007 — the Home tab's "＋" offers a choice (barcode vs. "something
 * with no barcode"), and the add-custom-product screen opens as a search box
 * before anything else. Search and browse stay open to a guest; only the
 * create action is gated behind the P5-001 sign-up prompt. The real
 * `GET /api/products/search` endpoint is built in parallel on the backend and
 * isn't necessarily up when this runs (see README.md § Web E2E), so it's
 * mocked at the network layer here — this spec is about the client's own
 * behaviour, not the search ranking.
 */

async function signInAsGuest(page: import('@playwright/test').Page) {
  await page.route('**/api/users/me/ratings', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.goto('/');
  await page.getByText('Continue as Guest').click();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15_000 });
}

test('the "＋" offers a choice between a barcode and something with no barcode', async ({ page }) => {
  await signInAsGuest(page);

  await page.getByTestId('home-add-product').click();
  await expect(page.getByTestId('add-choice-sheet')).toBeVisible();
  await expect(page.getByTestId('add-choice-barcode')).toBeVisible();
  await expect(page.getByTestId('add-choice-custom')).toBeVisible();

  await page.getByTestId('add-choice-custom').click();
  await expect(page.getByTestId('add-custom-product-screen')).toBeVisible();
});

test('a guest can search for a custom product, but creating one shows the sign-up gate', async ({
  page,
}) => {
  await signInAsGuest(page);

  await page.route('**/api/products/search**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [], nextCursor: null }),
    });
  });

  await page.getByTestId('home-add-product').click();
  await page.getByTestId('add-choice-custom').click();
  await expect(page.getByTestId('add-custom-product-screen')).toBeVisible();

  await page.getByTestId('custom-product-search-input').fill('negroni');
  await expect(page.getByTestId('custom-product-create')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('custom-product-create').click();
  await expect(page.getByTestId('add-custom-product-signup-gate')).toBeVisible();

  await page.getByTestId('add-custom-product-signup').click();
  await expect(page.getByText('Create account')).toBeVisible();
});
