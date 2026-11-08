import { act, renderHook } from '@testing-library/react-native';

import { searchProducts } from '@/features/search/api';
import { ApiError, NetworkError } from '@/lib/api';

import { useProductSearch } from './use-product-search';

// `features/search/api` pulls in `lib/api` → `lib/supabase`, which throws at
// import time without env vars (same reason `features/products/api.test.ts`
// stubs it). `isSearchableQuery` is kept real; only `searchProducts` (the
// network boundary) is mocked.
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) } },
}));

jest.mock('@/features/search/api', () => {
  const actual = jest.requireActual('@/features/search/api');
  return { ...actual, searchProducts: jest.fn() };
});

const mockSearch = searchProducts as jest.Mock;

function page(ids: string[], nextCursor: string | null = null) {
  return {
    results: ids.map((id) => ({
      id,
      kind: 'PACKAGED' as const,
      name: `Product ${id}`,
      brand: null,
      image: null,
      unverified: false,
      similarity: 0.9,
    })),
    nextCursor,
  };
}

describe('useProductSearch (TICKET-P6-008 Slice B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('makes no request while inactive (Mine scope)', async () => {
    const { result } = await renderHook(({ query }) => useProductSearch(query, false), {
      initialProps: { query: 'cola' },
    });

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it('does not request below the 2-character minimum', async () => {
    await renderHook(({ query }) => useProductSearch(query, true), { initialProps: { query: 'c' } });

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('debounces 300ms before sending a request', async () => {
    mockSearch.mockResolvedValue(page(['1']));
    await renderHook(({ query }) => useProductSearch(query, true), { initialProps: { query: 'cola' } });

    await act(async () => {
      jest.advanceTimersByTime(299);
    });
    expect(mockSearch).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  /**
   * Guardrail-relevant: this is a REAL AbortController, not a mock that
   * freezes state — `searchProducts` is the only mocked boundary, and the
   * signal it receives is read back out after the keystroke that supersedes
   * it. A hook that forgot to abort would still pass a test that merely
   * checked call counts; this checks the actual cancellation signal and that
   * the stale result never reaches `results`.
   */
  it('cancels the in-flight request on the next keystroke and ignores its late result', async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveFirst!: (value: ReturnType<typeof page>) => void;
    mockSearch.mockImplementationOnce((_q: string, _cursor: string | null, signal?: AbortSignal) => {
      firstSignal = signal;
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });
    mockSearch.mockImplementationOnce(() => Promise.resolve(page(['2'])));

    const { result, rerender } = await renderHook(({ query }) => useProductSearch(query, true), {
      initialProps: { query: 'cola' },
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(false);

    // The next keystroke: a new query value supersedes the in-flight request.
    await rerender({ query: 'pepsi' });
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(mockSearch).toHaveBeenCalledTimes(2);

    // The superseded request finally resolves — its result must not land.
    await act(async () => {
      resolveFirst(page(['1']));
    });
    expect(result.current.results.map((r) => r.id)).toEqual(['2']);
  });

  it('reports offline and clears results on a NetworkError', async () => {
    mockSearch.mockRejectedValue(new NetworkError());
    const { result } = await renderHook(({ query }) => useProductSearch(query, true), {
      initialProps: { query: 'cola' },
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(result.current.isOffline).toBe(true);
    expect(result.current.results).toEqual([]);
  });

  it('surfaces a non-network failure as `error`', async () => {
    mockSearch.mockRejectedValue(new ApiError(500, 'boom', {}));
    const { result } = await renderHook(({ query }) => useProductSearch(query, true), {
      initialProps: { query: 'cola' },
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.isOffline).toBe(false);
  });

  it('paginates: loadMore appends the next page using the returned cursor', async () => {
    mockSearch.mockResolvedValueOnce(page(['1', '2'], 'cursor-1'));
    const { result } = await renderHook(({ query }) => useProductSearch(query, true), {
      initialProps: { query: 'cola' },
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current.results.map((r) => r.id)).toEqual(['1', '2']);
    expect(result.current.hasMore).toBe(true);

    mockSearch.mockResolvedValueOnce(page(['3'], null));
    await act(async () => {
      result.current.loadMore();
    });

    expect(mockSearch).toHaveBeenLastCalledWith('cola', 'cursor-1', expect.anything());
    expect(result.current.results.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(result.current.hasMore).toBe(false);
  });

  it('does not call loadMore again while a page is already loading', async () => {
    mockSearch.mockResolvedValueOnce(page(['1'], 'cursor-1'));
    const { result } = await renderHook(({ query }) => useProductSearch(query, true), {
      initialProps: { query: 'cola' },
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    let resolveSecond!: (value: ReturnType<typeof page>) => void;
    mockSearch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.loadMore();
    });
    expect(mockSearch).toHaveBeenCalledTimes(2); // initial page + exactly one loadMore

    await act(async () => {
      resolveSecond(page(['2'], null));
    });
  });
});
