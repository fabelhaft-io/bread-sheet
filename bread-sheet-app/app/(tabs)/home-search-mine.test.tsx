import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { NetworkError } from '@/lib/api';
import { __resetOfflineStoreForTests, setActiveCacheUser } from '@/lib/offline/store';
import { ratingsCache } from '@/lib/offline/caches';
import type { RatingEntry } from '@/features/ratings/types';
import { searchProducts } from '@/features/search/api';

import HomeScreen from './index';

/**
 * TICKET-P6-008 Slice A — the Home tab's "Mine" scope filters the already-
 * cached `/api/users/me/ratings` list in memory: no endpoint, no request,
 * works offline.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() };
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

jest.mock('@/hooks/use-recent-products', () => {
  const value = { addRecentProduct: jest.fn(), recentProducts: [] as unknown[] };
  return { useRecentProducts: () => value };
});

jest.mock('@/lib/api');

// Slice A must never reach this — asserted directly in a test below.
jest.mock('@/features/search/api', () => {
  const actual = jest.requireActual('@/features/search/api');
  return { ...actual, searchProducts: jest.fn() };
});

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
const mockSearch = searchProducts as jest.Mock;

function rating(
  id: string,
  name: string,
  brand: string | null,
  kind: 'PACKAGED' | 'CUSTOM' = 'PACKAGED',
  category: RatingEntry['category'] = null,
): RatingEntry {
  return {
    id: `r-${id}`,
    score: 8,
    taste: 8,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id, kind, name, brand, image: null },
    category,
  };
}

function outbox() {
  return {
    queued: [],
    failures: [],
    isQueued: () => false,
    enqueue: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    dismissFailures: jest.fn(),
  };
}

describe('HomeScreen — Mine scope search (TICKET-P6-008 Slice A)', () => {
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

  it('filters ratings by name as I type, with no network request', async () => {
    mockApiGet.mockResolvedValue([
      rating('p1', 'Coca-Cola', 'Coca-Cola Company'),
      rating('p2', 'Sourdough Loaf', 'Artisan Bakery'),
    ]);

    const { findByText, queryByText, getByTestId } = await render(<HomeScreen />);
    await findByText('Coca-Cola');

    await fireEvent.changeText(getByTestId('home-search-input'), 'cola');

    await waitFor(() => expect(queryByText('Sourdough Loaf')).toBeNull());
    expect(queryByText('Coca-Cola')).toBeTruthy();
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('matches case- and diacritic-insensitively, on substrings', async () => {
    mockApiGet.mockResolvedValue([rating('p1', 'Café Latte', null)]);
    const { findByText, getByTestId } = await render(<HomeScreen />);
    await findByText('Café Latte');

    await fireEvent.changeText(getByTestId('home-search-input'), 'CAFE');
    await findByText('Café Latte');
  });

  it('matches on brand too, not just name', async () => {
    mockApiGet.mockResolvedValue([rating('p1', 'Sourdough Loaf', 'Artisan Bakery')]);
    const { findByText, getByTestId } = await render(<HomeScreen />);
    await findByText('Sourdough Loaf');

    await fireEvent.changeText(getByTestId('home-search-input'), 'artisan');
    await findByText('Sourdough Loaf');
  });

  it('works offline against cached ratings', async () => {
    await ratingsCache.write([rating('p1', 'Coca-Cola', null)]);
    mockApiGet.mockRejectedValue(new NetworkError());

    const { findByText, getByTestId, findByTestId } = await render(<HomeScreen />);
    await findByTestId('offline-indicator');

    await fireEvent.changeText(getByTestId('home-search-input'), 'cola');
    await findByText('Coca-Cola');
  });

  it('shows "nothing rated yet" regardless of the query when there are no ratings at all', async () => {
    mockApiGet.mockResolvedValue([]);
    const { findByTestId, getByTestId } = await render(<HomeScreen />);
    await findByTestId('home-search-nothing-rated');

    await fireEvent.changeText(getByTestId('home-search-input'), 'cola');
    await findByTestId('home-search-nothing-rated');
  });

  it('shows "no match" (distinct from "nothing rated") and offers Search all products', async () => {
    mockApiGet.mockResolvedValue([rating('p1', 'Coca-Cola', null)]);
    const { findByTestId, getByTestId, queryByTestId } = await render(<HomeScreen />);
    await findByTestId('home-search-scope-mine');

    await fireEvent.changeText(getByTestId('home-search-input'), 'pepsi');
    await findByTestId('home-search-no-match');
    expect(queryByTestId('home-search-nothing-rated')).toBeNull();

    await fireEvent.press(getByTestId('home-search-switch-to-all'));
    expect(getByTestId('home-search-scope-all').props.accessibilityState?.selected).toBe(true);
  });

  // The P6-007 item itself doesn't exist yet; a CUSTOM-kind rating with a
  // null brand is the closest fixture available and is what the AC asks for.
  it('finds a barcode-less CUSTOM item by name (brand null)', async () => {
    mockApiGet.mockResolvedValue([rating('p1', 'Negroni', null, 'CUSTOM')]);
    const { findByText, getByTestId } = await render(<HomeScreen />);
    await findByText('Negroni');

    await fireEvent.changeText(getByTestId('home-search-input'), 'negroni');
    await findByText('Negroni');
  });

  // TICKET-P6-003: the category chip row composes with the search query
  // (AND) via `categoryPredicateFor` passed into `filterRatingsByQuery` as
  // its `categoryPredicate`. The pure composition is also covered directly
  // in `features/search/match.test.ts` ("composes with an optional category
  // predicate"); this is the screen-level version, closing the P6-008 box.
  it('composes the category chip with the search query (AND)', async () => {
    mockApiGet.mockResolvedValue([
      rating('p1', 'Pinot Noir', null, 'PACKAGED', { id: 'cat-wine', name: 'Wine' }),
      rating('p2', 'Chardonnay', null, 'PACKAGED', { id: 'cat-wine', name: 'Wine' }),
      rating('p3', 'Negroni', null, 'CUSTOM', { id: 'cat-cocktails', name: 'Cocktails' }),
    ]);

    const { findByText, queryByText, getByTestId, findByTestId } = await render(<HomeScreen />);
    await findByText('Pinot Noir');

    // Selecting the "Wine" chip scopes the list to the two wine ratings only.
    const wineChip = await findByTestId('category-chip-cat-wine');
    await fireEvent.press(wineChip);
    await waitFor(() => expect(queryByText('Negroni')).toBeNull());
    expect(queryByText('Pinot Noir')).toBeTruthy();
    expect(queryByText('Chardonnay')).toBeTruthy();

    // AND with the search query narrows further, to just "Pinot Noir".
    await fireEvent.changeText(getByTestId('home-search-input'), 'pinot');
    await waitFor(() => expect(queryByText('Chardonnay')).toBeNull());
    expect(queryByText('Pinot Noir')).toBeTruthy();
  });

  it('does not persist the query across a remount (cold start)', async () => {
    mockApiGet.mockResolvedValue([rating('p1', 'Coca-Cola', null), rating('p2', 'Rye Bread', null)]);
    const { getByTestId, unmount } = await render(<HomeScreen />);
    await fireEvent.changeText(getByTestId('home-search-input'), 'cola');
    unmount();

    const rendered = await render(<HomeScreen />);
    await rendered.findByText('Rye Bread');
    expect(rendered.getByTestId('home-search-input').props.value).toBe('');
  });
});
