import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { NetworkError } from '@/lib/api';
import { __resetOfflineStoreForTests, setActiveCacheUser } from '@/lib/offline/store';
import { categoryFilterCache, ratingsCache } from '@/lib/offline/caches';
import type { RatingEntry } from '@/features/ratings/types';

import HomeScreen from './index';

/**
 * Home tab behaviour introduced by Phase 8: the ratings list is served from the
 * offline cache, anonymous users see their own ratings rather than a sign-in
 * wall, and queued (not-yet-synced) ratings are marked as such.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockUseSession = jest.fn();
const mockUseOutbox = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/hooks/use-outbox', () => ({
  useOutbox: () => mockUseOutbox(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Must be stable across renders — a fresh object would restart the effects.
jest.mock('@/hooks/use-recent-products', () => {
  const value = { addRecentProduct: jest.fn(), recentProducts: [] as unknown[] };
  return { useRecentProducts: () => value };
});

jest.mock('@/lib/api');

// In-memory document directory so the cache behaves like the real thing.
jest.mock('expo-file-system/legacy', () => {
  const files = new Map<string, string>();
  return {
    __files: files,
    documentDirectory: 'file:///documents/',
    getInfoAsync: jest.fn(async (uri: string) => ({ exists: files.has(uri) })),
    readAsStringAsync: jest.fn(async (uri: string) => {
      const value = files.get(uri);
      if (value === undefined) throw new Error(`ENOENT: ${uri}`);
      return value;
    }),
    writeAsStringAsync: jest.fn(async (uri: string, contents: string) => {
      files.set(uri, contents);
    }),
    deleteAsync: jest.fn(async (uri: string) => {
      for (const key of [...files.keys()]) if (key.startsWith(uri)) files.delete(key);
    }),
    makeDirectoryAsync: jest.fn(async () => {}),
    readDirectoryAsync: jest.fn(async () => []),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const files = (require('expo-file-system/legacy') as { __files: Map<string, string> }).__files;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { api } = require('@/lib/api');
const mockApiGet = api.get as jest.Mock;

function rating(
  id: string,
  name: string,
  taste: number,
  category: RatingEntry['category'] = null,
): RatingEntry {
  return {
    id: `r-${id}`,
    score: taste,
    taste,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id, kind: 'PACKAGED', name, brand: 'Artisan', image: null },
    category,
  };
}

function outbox(queuedIds: string[] = [], failures: { productId: string; message: string }[] = []) {
  return {
    queued: queuedIds.map((productId) => ({ productId })),
    failures,
    isQueued: (productId: string) => queuedIds.includes(productId),
    enqueue: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    dismissFailures: jest.fn(),
  };
}

describe('HomeScreen — offline ratings list (P8-002/P8-003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    files.clear();
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');
    mockUseOutbox.mockReturnValue(outbox());
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
  });

  it('renders the fetched ratings', async () => {
    mockApiGet.mockResolvedValue([rating('111', 'Sourdough Loaf', 8)]);
    const { findByText } = await render(<HomeScreen />);
    await findByText('Sourdough Loaf');
  });

  it('renders the cached list with an offline indicator when the fetch cannot reach the server', async () => {
    await ratingsCache.write([rating('111', 'Sourdough Loaf', 8)]);
    mockApiGet.mockRejectedValue(new NetworkError());

    const { findByText, findByTestId } = await render(<HomeScreen />);

    await findByText('Sourdough Loaf');
    await findByTestId('offline-indicator');
  });

  it('does not empty the list when a refresh fails offline', async () => {
    await ratingsCache.write([rating('111', 'Sourdough Loaf', 8)]);
    mockApiGet.mockRejectedValue(new NetworkError());

    const { findByTestId, getByText } = await render(<HomeScreen />);
    await findByTestId('offline-indicator');
    expect(getByText('Sourdough Loaf')).toBeTruthy();
  });

  it('shows an offline empty state, not "you haven’t rated anything", with no cache', async () => {
    mockApiGet.mockRejectedValue(new NetworkError());
    const { findByText, queryByText } = await render(<HomeScreen />);
    await findByText(/offline and haven't opened this list/i);
    expect(queryByText(/haven't rated anything yet/i)).toBeNull();
  });

  it('lists an anonymous user’s own ratings instead of a sign-in wall', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockApiGet.mockResolvedValue([rating('111', 'Sourdough Loaf', 8)]);

    const { findByText, queryByText } = await render(<HomeScreen />);

    await findByText('Sourdough Loaf');
    expect(queryByText(/Sign in or create an account to see your rating history/i)).toBeNull();
  });

  it('still prompts an anonymous user to register, alongside the list', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockApiGet.mockResolvedValue([rating('111', 'Sourdough Loaf', 8)]);

    const { findByText, getByTestId } = await render(<HomeScreen />);

    await findByText('Sourdough Loaf');
    expect(getByTestId('guest-upgrade-banner')).toBeTruthy();
  });

  it('marks a queued rating as not yet synced (P8-004)', async () => {
    mockUseOutbox.mockReturnValue(outbox(['111']));
    mockApiGet.mockResolvedValue([rating('111', 'Sourdough Loaf', 8), rating('222', 'Rye', 5)]);

    const { findByTestId, queryByTestId } = await render(<HomeScreen />);

    await findByTestId('rating-pending-sync-111');
    expect(queryByTestId('rating-pending-sync-222')).toBeNull();
  });

  it('reports ratings the server refused outright', async () => {
    mockUseOutbox.mockReturnValue(outbox([], [{ productId: '111', message: 'taste must be 0–10' }]));
    mockApiGet.mockResolvedValue([]);

    const { findByTestId, getByText } = await render(<HomeScreen />);

    await findByTestId('outbox-failures');
    expect(getByText(/taste must be 0–10/)).toBeTruthy();
  });

  it('does not fetch ratings when there is no session', async () => {
    mockUseSession.mockReturnValue({ session: null, isAnonymous: false, isLoading: false });
    await render(<HomeScreen />);
    await waitFor(() => expect(mockApiGet).not.toHaveBeenCalled());
  });

  // P6-006: adding a product must not require the camera tab.
  it('offers a manual add entry point that routes to the product screen', async () => {
    mockApiGet.mockResolvedValue([]);
    const { findByTestId, getByTestId } = await render(<HomeScreen />);

    // TICKET-P6-007: "＋" now opens a choice sheet first.
    await fireEvent.press(await findByTestId('home-add-product'));
    await fireEvent.press(await findByTestId('add-choice-barcode'));
    await fireEvent.changeText(getByTestId('manual-barcode-input'), '4006381333931');
    await fireEvent.press(getByTestId('manual-barcode-submit'));

    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/gtin/4006381333931');
  });

  // TICKET-P6-007: the other half of the choice sheet.
  it('offers a "something with no barcode" entry point that routes to the custom-product screen', async () => {
    mockApiGet.mockResolvedValue([]);
    const { findByTestId } = await render(<HomeScreen />);

    await fireEvent.press(await findByTestId('home-add-product'));
    await fireEvent.press(await findByTestId('add-choice-custom'));

    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/add-custom-product');
  });
});

describe('HomeScreen — category chip row (TICKET-P6-003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    files.clear();
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');
    mockUseOutbox.mockReturnValue(outbox());
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
  });

  it('shows no chip row when there are no ratings at all', async () => {
    mockApiGet.mockResolvedValue([]);
    const { findByTestId, queryByTestId } = await render(<HomeScreen />);
    await findByTestId('home-search-nothing-rated');
    expect(queryByTestId('category-chip-row')).toBeNull();
  });

  it('shows one chip per category with a count, plus Uncategorised, plus All', async () => {
    mockApiGet.mockResolvedValue([
      rating('p1', 'Pinot Noir', 8, { id: 'cat-wine', name: 'Wine' }),
      rating('p2', 'Chardonnay', 7, { id: 'cat-wine', name: 'Wine' }),
      rating('p3', 'Sourdough Loaf', 6, null),
    ]);
    const { findByTestId, getByTestId, getByText } = await render(<HomeScreen />);
    await findByTestId('category-chip-row');

    expect(getByText('Wine (2)')).toBeTruthy();
    expect(getByText('Uncategorised (1)')).toBeTruthy();
    expect(getByTestId('category-chip-all').props.accessibilityState?.selected).toBe(true);
  });

  it('does not show an Uncategorised chip when every rating has a category', async () => {
    mockApiGet.mockResolvedValue([rating('p1', 'Pinot Noir', 8, { id: 'cat-wine', name: 'Wine' })]);
    const { findByTestId, queryByTestId } = await render(<HomeScreen />);
    await findByTestId('category-chip-row');
    expect(queryByTestId('category-chip-uncategorized')).toBeNull();
  });

  it('filters the list to the selected category, with no network request', async () => {
    mockApiGet.mockResolvedValue([
      rating('p1', 'Pinot Noir', 8, { id: 'cat-wine', name: 'Wine' }),
      rating('p2', 'Negroni', 9, { id: 'cat-cocktails', name: 'Cocktails' }),
    ]);
    const { findByTestId, queryByText, getByText } = await render(<HomeScreen />);
    await findByTestId('category-chip-cat-wine');

    await fireEvent.press(getByText('Wine (1)'));

    expect(queryByText('Pinot Noir')).toBeTruthy();
    expect(queryByText('Negroni')).toBeNull();
    expect(mockApiGet.mock.calls.filter((args) => args[0] !== '/api/users/me/ratings')).toHaveLength(0);
  });

  it('filters to Uncategorised', async () => {
    mockApiGet.mockResolvedValue([
      rating('p1', 'Pinot Noir', 8, { id: 'cat-wine', name: 'Wine' }),
      rating('p2', 'Sourdough Loaf', 6, null),
    ]);
    const { findByTestId, queryByText } = await render(<HomeScreen />);
    await findByTestId('category-chip-uncategorized');

    await fireEvent.press(await findByTestId('category-chip-uncategorized'));

    expect(queryByText('Sourdough Loaf')).toBeTruthy();
    expect(queryByText('Pinot Noir')).toBeNull();
  });

  it('persists the selected chip across a restart', async () => {
    mockApiGet.mockResolvedValue([
      rating('p1', 'Pinot Noir', 8, { id: 'cat-wine', name: 'Wine' }),
      rating('p2', 'Negroni', 9, { id: 'cat-cocktails', name: 'Cocktails' }),
    ]);
    const { findByTestId, getByTestId, unmount } = await render(<HomeScreen />);
    await fireEvent.press(await findByTestId('category-chip-cat-wine'));
    await waitFor(() =>
      expect(getByTestId('category-chip-cat-wine').props.accessibilityState?.selected).toBe(true),
    );
    await unmount();

    const rendered = await render(<HomeScreen />);
    await rendered.findByTestId('category-chip-cat-wine');
    await waitFor(() =>
      expect(rendered.getByTestId('category-chip-cat-wine').props.accessibilityState?.selected).toBe(
        true,
      ),
    );
  });

  it('falls back to All when the persisted selection no longer corresponds to a chip', async () => {
    // Simulates returning to a selection whose category has since been
    // deleted/merged away server-side (or simply has no ratings left) —
    // the persisted preference still points at it, but the fetched list no
    // longer carries that category at all.
    await categoryFilterCache.write({ kind: 'category', id: 'cat-wine', name: 'Wine' });
    mockApiGet.mockResolvedValue([rating('p2', 'Negroni', 9, { id: 'cat-cocktails', name: 'Cocktails' })]);

    const { findByTestId, getByTestId } = await render(<HomeScreen />);
    await findByTestId('category-chip-row');

    await waitFor(() =>
      expect(getByTestId('category-chip-all').props.accessibilityState?.selected).toBe(true),
    );
  });
});
