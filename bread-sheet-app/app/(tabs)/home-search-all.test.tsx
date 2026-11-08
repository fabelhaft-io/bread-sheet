import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { ApiError, NetworkError } from '@/lib/api';
import { __resetOfflineStoreForTests, setActiveCacheUser } from '@/lib/offline/store';
import { searchProducts } from '@/features/search/api';

import HomeScreen from './index';

/**
 * TICKET-P6-008 Slice B — the Home tab's "All products" scope: debounced,
 * cancellable global search, pagination, the unverified badge, and the
 * offline-points-back-to-Mine affordance. Also covers the scan tab's
 * `?focusSearch=all` hand-off.
 *
 * Kept in its own file (fake timers only here) so Slice A's tests — which
 * don't need them — aren't run under a faked clock.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() };
const mockUseSession = jest.fn();
const mockUseOutbox = jest.fn();
let mockParams: Record<string, string | undefined> = {};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
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

function searchResult(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    kind: 'PACKAGED',
    name: `Product ${id}`,
    brand: null,
    image: null,
    unverified: false,
    similarity: 0.9,
    ...overrides,
  };
}

describe('HomeScreen — All products scope search (TICKET-P6-008 Slice B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    files.clear();
    mockParams = {};
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');
    mockUseOutbox.mockReturnValue(outbox());
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    mockApiGet.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('makes no request below 2 characters, and debounces 300ms before searching at 2+', async () => {
    const { getByTestId } = await render(<HomeScreen />);
    await fireEvent.press(getByTestId('home-search-scope-all'));
    await fireEvent.changeText(getByTestId('home-search-input'), 'c');

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(mockSearch).not.toHaveBeenCalled();

    mockSearch.mockResolvedValue({ results: [searchResult('x1')], nextCursor: null });
    await fireEvent.changeText(getByTestId('home-search-input'), 'co');

    await act(async () => {
      jest.advanceTimersByTime(299);
    });
    expect(mockSearch).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('renders results, flagging unverified ones as "Needs review"', async () => {
    mockSearch.mockResolvedValue({
      results: [
        searchResult('x1', { name: 'Pepsi' }),
        searchResult('x2', { name: 'Homebrew Cola', unverified: true }),
      ],
      nextCursor: null,
    });
    const { getByTestId, findByText } = await render(<HomeScreen />);
    await fireEvent.press(getByTestId('home-search-scope-all'));
    await fireEvent.changeText(getByTestId('home-search-input'), 'cola');

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await findByText('Pepsi');
    await findByText('Homebrew Cola');
    expect(getByTestId('search-result-unverified-x2')).toBeTruthy();
    expect(() => getByTestId('search-result-unverified-x1')).toThrow();
  });

  it('tapping a result navigates to the product screen', async () => {
    mockSearch.mockResolvedValue({ results: [searchResult('x1', { name: 'Pepsi' })], nextCursor: null });
    const { getByTestId, findByText } = await render(<HomeScreen />);
    await fireEvent.press(getByTestId('home-search-scope-all'));
    await fireEvent.changeText(getByTestId('home-search-input'), 'pepsi');
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await findByText('Pepsi');

    await fireEvent.press(getByTestId('search-result-x1'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/x1');
  });

  it('loads the next page (cursor pagination) when the end is reached', async () => {
    mockSearch.mockResolvedValueOnce({ results: [searchResult('x1')], nextCursor: 'cursor-1' });
    const { getByTestId, findByText } = await render(<HomeScreen />);
    await fireEvent.press(getByTestId('home-search-scope-all'));
    await fireEvent.changeText(getByTestId('home-search-input'), 'cola');
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await findByText('Product x1');

    mockSearch.mockResolvedValueOnce({ results: [searchResult('x2')], nextCursor: null });
    await act(async () => {
      fireEvent.scroll(getByTestId('home-screen'), {
        nativeEvent: {
          contentOffset: { y: 1000 },
          contentSize: { height: 1200, width: 0 },
          layoutMeasurement: { height: 300, width: 0 },
        },
      });
    });

    await findByText('Product x2');
    expect(mockSearch).toHaveBeenLastCalledWith('cola', 'cursor-1', expect.anything());
  });

  it('reports being offline and offers switching back to Mine', async () => {
    mockSearch.mockRejectedValue(new NetworkError());
    const { getByTestId, findByTestId } = await render(<HomeScreen />);
    await fireEvent.press(getByTestId('home-search-scope-all'));
    await fireEvent.changeText(getByTestId('home-search-input'), 'cola');
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await findByTestId('home-search-offline');
    await fireEvent.press(getByTestId('home-search-switch-to-mine'));
    expect(getByTestId('home-search-scope-mine').props.accessibilityState?.selected).toBe(true);
  });

  it('surfaces a non-network failure through formatApiError, never the raw server message', async () => {
    mockSearch.mockRejectedValue(new ApiError(500, 'Prisma P2002 unique_violation on product_name', {}));
    const { getByTestId, findByTestId, queryByText } = await render(<HomeScreen />);
    await fireEvent.press(getByTestId('home-search-scope-all'));
    await fireEvent.changeText(getByTestId('home-search-input'), 'cola');
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await findByTestId('home-search-error');
    expect(queryByText(/Prisma/)).toBeNull();
  });

  describe('scan tab hand-off', () => {
    it('switches to the All-products scope when arriving with ?focusSearch=all', async () => {
      mockParams = { focusSearch: 'all' };
      const { getByTestId } = await render(<HomeScreen />);

      await waitFor(() =>
        expect(getByTestId('home-search-scope-all').props.accessibilityState?.selected).toBe(true),
      );
      expect(mockRouter.setParams).toHaveBeenCalledWith({ focusSearch: undefined });
    });
  });
});
