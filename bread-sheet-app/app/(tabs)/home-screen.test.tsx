import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import { NetworkError } from '@/lib/api';
import { __resetOfflineStoreForTests, setActiveCacheUser } from '@/lib/offline/store';
import { ratingsCache } from '@/lib/offline/caches';
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

function rating(barcode: string, name: string, taste: number): RatingEntry {
  return {
    id: `r-${barcode}`,
    score: taste,
    taste,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: `p-${barcode}`, barcode, name, brand: 'Artisan', image: null },
  };
}

function outbox(queuedBarcodes: string[] = [], failures: { barcode: string; message: string }[] = []) {
  return {
    queued: queuedBarcodes.map((barcode) => ({ barcode })),
    failures,
    isQueued: (barcode: string) => queuedBarcodes.includes(barcode),
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
    const { findByText } = render(<HomeScreen />);
    await findByText('Sourdough Loaf');
  });

  it('renders the cached list with an offline indicator when the fetch cannot reach the server', async () => {
    await ratingsCache.write([rating('111', 'Sourdough Loaf', 8)]);
    mockApiGet.mockRejectedValue(new NetworkError());

    const { findByText, findByTestId } = render(<HomeScreen />);

    await findByText('Sourdough Loaf');
    await findByTestId('offline-indicator');
  });

  it('does not empty the list when a refresh fails offline', async () => {
    await ratingsCache.write([rating('111', 'Sourdough Loaf', 8)]);
    mockApiGet.mockRejectedValue(new NetworkError());

    const { findByTestId, getByText } = render(<HomeScreen />);
    await findByTestId('offline-indicator');
    expect(getByText('Sourdough Loaf')).toBeTruthy();
  });

  it('shows an offline empty state, not "you haven’t rated anything", with no cache', async () => {
    mockApiGet.mockRejectedValue(new NetworkError());
    const { findByText, queryByText } = render(<HomeScreen />);
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

    const { findByText, queryByText } = render(<HomeScreen />);

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

    const { findByText, getByTestId } = render(<HomeScreen />);

    await findByText('Sourdough Loaf');
    expect(getByTestId('guest-upgrade-banner')).toBeTruthy();
  });

  it('marks a queued rating as not yet synced (P8-004)', async () => {
    mockUseOutbox.mockReturnValue(outbox(['111']));
    mockApiGet.mockResolvedValue([rating('111', 'Sourdough Loaf', 8), rating('222', 'Rye', 5)]);

    const { findByTestId, queryByTestId } = render(<HomeScreen />);

    await findByTestId('rating-pending-sync-111');
    expect(queryByTestId('rating-pending-sync-222')).toBeNull();
  });

  it('reports ratings the server refused outright', async () => {
    mockUseOutbox.mockReturnValue(outbox([], [{ barcode: '111', message: 'taste must be 0–10' }]));
    mockApiGet.mockResolvedValue([]);

    const { findByTestId, getByText } = render(<HomeScreen />);

    await findByTestId('outbox-failures');
    expect(getByText(/taste must be 0–10/)).toBeTruthy();
  });

  it('does not fetch ratings when there is no session', async () => {
    mockUseSession.mockReturnValue({ session: null, isAnonymous: false, isLoading: false });
    render(<HomeScreen />);
    await waitFor(() => expect(mockApiGet).not.toHaveBeenCalled());
  });
});
