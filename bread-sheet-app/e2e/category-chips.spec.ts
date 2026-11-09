import { test, expect } from '@playwright/test';

/**
 * TICKET-P6-003 — the Home tab's category chip row. Purely client-side
 * (derived from the already-cached `/api/users/me/ratings` list, same as
 * `home-search.spec.ts`'s Mine-scope assertions), so only that one endpoint
 * needs mocking — no `/api/users/me/categories` call is involved in
 * filtering or persisting the selection.
 */

const RATINGS = [
  {
    id: 'r1',
    score: 8,
    taste: 8,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: 'p1', kind: 'PACKAGED', name: 'Pinot Noir', brand: null, image: null },
    category: { id: 'cat-wine', name: 'Wine' },
  },
  {
    id: 'r2',
    score: 7,
    taste: 7,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: 'p2', kind: 'PACKAGED', name: 'Chardonnay', brand: null, image: null },
    category: { id: 'cat-wine', name: 'Wine' },
  },
  {
    id: 'r3',
    score: 9,
    taste: 9,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: 'p3', kind: 'CUSTOM', name: 'Negroni', brand: null, image: null },
    category: { id: 'cat-cocktails', name: 'Cocktails' },
  },
  {
    id: 'r4',
    score: 6,
    taste: 6,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: 'p4', kind: 'PACKAGED', name: 'Sourdough Loaf', brand: 'Artisan Bakery', image: null },
    category: null,
  },
];

async function signInAsGuest(page: import('@playwright/test').Page) {
  await page.route('**/api/users/me/ratings', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RATINGS) });
  });

  await page.goto('/');
  await page.getByText('Continue as Guest').click();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15_000 });
}

test('shows one chip per category with a count, plus Uncategorised', async ({ page }) => {
  await signInAsGuest(page);

  await expect(page.getByTestId('category-chip-row')).toBeVisible();
  await expect(page.getByTestId('category-chip-all')).toBeVisible();
  await expect(page.getByTestId('category-chip-cat-wine')).toHaveText('Wine (2)');
  await expect(page.getByTestId('category-chip-cat-cocktails')).toHaveText('Cocktails (1)');
  await expect(page.getByTestId('category-chip-uncategorized')).toHaveText('Uncategorised (1)');
});

test('selecting a chip filters the list with no extra network request', async ({ page }) => {
  await signInAsGuest(page);

  let extraRequests = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/') && !req.url().includes('/api/users/me/ratings')) extraRequests += 1;
  });

  await page.getByTestId('category-chip-cat-wine').click();

  await expect(page.getByText('Pinot Noir')).toBeVisible();
  await expect(page.getByText('Chardonnay')).toBeVisible();
  await expect(page.getByText('Negroni')).not.toBeVisible();
  await expect(page.getByText('Sourdough Loaf')).not.toBeVisible();
  expect(extraRequests).toBe(0);
});

test('composes the category chip with the search query (AND)', async ({ page }) => {
  await signInAsGuest(page);

  await page.getByTestId('category-chip-cat-wine').click();
  await page.getByTestId('home-search-input').fill('pinot');

  await expect(page.getByText('Pinot Noir')).toBeVisible();
  await expect(page.getByText('Chardonnay')).not.toBeVisible();
});

test('persists the selected chip across a reload', async ({ page }) => {
  await signInAsGuest(page);

  await page.getByTestId('category-chip-cat-wine').click();
  await expect(page.getByText('Negroni')).not.toBeVisible();

  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15_000 });
  // Still scoped to "Wine" with no further tap — the selection survived the
  // reload (persisted on disk, re-hydrated on mount), and still excludes
  // whatever the chip excluded before.
  await expect(page.getByText('Pinot Noir')).toBeVisible();
  await expect(page.getByText('Negroni')).not.toBeVisible();
});
