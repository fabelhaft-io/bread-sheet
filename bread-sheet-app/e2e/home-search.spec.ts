import { test, expect } from '@playwright/test';

/**
 * TICKET-P6-008 — Home tab search. The real `/api/products/search` endpoint is built in
 * parallel on the backend and isn't necessarily up when this runs against a local stack
 * (see README.md § Web E2E — only Supabase auth is started, not the API server), so the
 * ratings list and the global-search endpoint are both mocked at the network layer here.
 * That keeps the assertions about the client's own behaviour (in-memory filtering, the
 * scope toggle, rendering a mocked global result) deterministic and independent of
 * whichever backend happens to be reachable.
 */

const RATINGS = [
  {
    id: 'r1',
    score: 8,
    taste: 8,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: 'p1', kind: 'PACKAGED', name: 'Coca-Cola', brand: 'Coca-Cola Company', image: null },
  },
  {
    id: 'r2',
    score: 6,
    taste: 6,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: 'p2', kind: 'PACKAGED', name: 'Sourdough Loaf', brand: 'Artisan Bakery', image: null },
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

test('Mine scope filters ratings by name as you type, with no match left over', async ({ page }) => {
  await signInAsGuest(page);

  // The fixture's brand is "Coca-Cola Company", which also contains the
  // substring "Coca-Cola" — match the product name exactly so this doesn't
  // become a strict-mode violation against the brand text rendered alongside it.
  await expect(page.getByText('Coca-Cola', { exact: true })).toBeVisible();
  await expect(page.getByText('Sourdough Loaf')).toBeVisible();

  await page.getByTestId('home-search-input').fill('cola');

  await expect(page.getByText('Coca-Cola', { exact: true })).toBeVisible();
  await expect(page.getByText('Sourdough Loaf')).not.toBeVisible();

  // Case/diacritic-insensitive, substring, not prefix-only.
  await page.getByTestId('home-search-input').fill('COLA');
  await expect(page.getByText('Coca-Cola', { exact: true })).toBeVisible();
});

test('a query with no match in Mine offers a way into All products', async ({ page }) => {
  await signInAsGuest(page);

  await page.route('**/api/products/search**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [], nextCursor: null }),
    });
  });

  await page.getByTestId('home-search-input').fill('pepsi');
  await expect(page.getByTestId('home-search-no-match')).toBeVisible();

  await page.getByTestId('home-search-switch-to-all').click();
  // The query carried over ("pepsi") and the mocked endpoint returns no
  // results — confirms the switch actually happened, not just that the
  // button exists.
  await expect(page.getByTestId('home-search-empty')).toBeVisible({ timeout: 10_000 });
});

test('the scope toggle switches to All products and renders a global result', async ({ page }) => {
  await signInAsGuest(page);

  await page.route('**/api/products/search**', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('q')).toBe('pepsi');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          { id: 'p3', kind: 'PACKAGED', name: 'Pepsi', brand: 'PepsiCo', image: null, unverified: false, similarity: 0.95 },
        ],
        nextCursor: null,
      }),
    });
  });

  await page.getByTestId('home-search-scope-all').click();
  // Below the 2-character minimum: no request, just the hint — also proves
  // the scope actually switched (this hint never renders in Mine scope).
  await expect(page.getByTestId('home-search-hint')).toBeVisible();

  await page.getByTestId('home-search-input').fill('pepsi');
  await expect(page.getByText('Pepsi')).toBeVisible({ timeout: 10_000 });

  // One bar, two scopes: the query ("pepsi") survives the switch back to Mine,
  // and neither of Mine's ratings matches it — so Mine's own no-match empty
  // state shows, not the unfiltered list.
  await page.getByTestId('home-search-scope-mine').click();
  await expect(page.getByTestId('home-search-no-match')).toBeVisible();
});
