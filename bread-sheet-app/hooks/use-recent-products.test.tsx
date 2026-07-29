import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { recentsCache } from '@/lib/offline/caches';
import { __resetOfflineStoreForTests, setActiveCacheUser } from '@/lib/offline/store';

import { RecentProductsProvider, useRecentProducts } from './use-recent-products';

/**
 * "Recently Opened" persistence (P8-002). The list used to live in plain
 * `useState`, so it was empty on every cold start.
 */

const mockUseSession = jest.fn();

jest.mock('./use-session', () => ({
  useSession: () => mockUseSession(),
}));

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

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecentProductsProvider>{children}</RecentProductsProvider>
);

const LOAF = { barcode: '111', name: 'Sourdough Loaf', brand: 'Artisan', image: null };

function signedInAs(userId: string | null) {
  mockUseSession.mockReturnValue({
    session: userId ? { user: { id: userId, is_anonymous: false } } : null,
    isAnonymous: false,
    isLoading: false,
  });
}

describe('RecentProductsProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    files.clear();
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');
    signedInAs('u1');
  });

  it('persists an opened product and restores it after a cold start', async () => {
    const first = renderHook(() => useRecentProducts(), { wrapper });
    await act(async () => {
      first.result.current.addRecentProduct(LOAF);
    });
    await waitFor(() => expect(recentsCache.peek()).toHaveLength(1));

    // Simulate a fresh process: memory mirror gone, disk intact.
    first.unmount();
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');

    const second = renderHook(() => useRecentProducts(), { wrapper });
    await waitFor(() => expect(second.result.current.recentProducts).toHaveLength(1));
    expect(second.result.current.recentProducts[0].name).toBe('Sourdough Loaf');
    expect(second.result.current.recentProducts[0].viewedAt).toBeInstanceOf(Date);
  });

  it('moves an already-listed product back to the top instead of duplicating it', async () => {
    const { result } = renderHook(() => useRecentProducts(), { wrapper });
    await act(async () => {
      result.current.addRecentProduct(LOAF);
      result.current.addRecentProduct({ ...LOAF, barcode: '222', name: 'Rye' });
      result.current.addRecentProduct(LOAF);
    });

    expect(result.current.recentProducts.map((item) => item.barcode)).toEqual(['111', '222']);
  });

  // Both effects re-run in the same commit when the account changes, at which
  // point state still holds the previous user's list.
  it('never writes one account’s recents into another account’s namespace', async () => {
    const { result, rerender } = renderHook(() => useRecentProducts(), { wrapper });
    await act(async () => {
      result.current.addRecentProduct(LOAF);
    });
    await waitFor(() => expect(recentsCache.peek()).toHaveLength(1));

    setActiveCacheUser('u2');
    signedInAs('u2');
    rerender(undefined);

    await waitFor(() => expect(result.current.recentProducts).toHaveLength(0));
    expect(await recentsCache.read()).toBeNull();
  });
});
