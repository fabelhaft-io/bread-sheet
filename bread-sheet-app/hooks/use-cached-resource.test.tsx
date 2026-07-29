import { act, renderHook, waitFor } from '@testing-library/react-native';

import { ApiError, NetworkError } from '@/lib/api';
import type { ResourceCache } from '@/lib/offline/caches';

import { useCachedResource } from './use-cached-resource';

jest.mock('@/lib/api');

/** Minimal in-memory ResourceCache, with `peek` under the test's control. */
function makeCache<T>(initial: { memory?: T; disk?: T } = {}) {
  let memory: T | null = initial.memory ?? null;
  let disk: T | null = initial.disk ?? null;
  return {
    cache: {
      peek: () => memory,
      read: async () => disk,
      write: async (value: T) => {
        memory = value;
        disk = value;
      },
    } as ResourceCache<T>,
    get written() {
      return disk;
    },
  };
}

describe('useCachedResource', () => {
  it('paints a memory-cached value in the very first render — no loading state', () => {
    const { cache } = makeCache<string[]>({ memory: ['cached'] });
    const { result } = renderHook(() =>
      useCachedResource({ key: 'k', cache, fetcher: () => new Promise<string[]>(() => {}) }),
    );

    expect(result.current.data).toEqual(['cached']);
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to the disk copy when memory is cold', async () => {
    const { cache } = makeCache<string[]>({ disk: ['from disk'] });
    const { result } = renderHook(() =>
      useCachedResource({ key: 'k', cache, fetcher: () => new Promise<string[]>(() => {}) }),
    );

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(['from disk']));
    expect(result.current.isLoading).toBe(false);
  });

  it('swaps in fresh data and writes it back to the cache', async () => {
    const holder = makeCache<string[]>({ memory: ['stale'] });
    const { result } = renderHook(() =>
      useCachedResource({
        key: 'k',
        cache: holder.cache,
        fetcher: async () => ['fresh'],
      }),
    );

    await waitFor(() => expect(result.current.data).toEqual(['fresh']));
    expect(holder.written).toEqual(['fresh']);
    expect(result.current.isOffline).toBe(false);
  });

  it('keeps the cached value and reports offline when revalidation cannot reach the server', async () => {
    const { cache } = makeCache<string[]>({ memory: ['cached'] });
    const { result } = renderHook(() =>
      useCachedResource({
        key: 'k',
        cache,
        fetcher: async () => {
          throw new NetworkError();
        },
      }),
    );

    await waitFor(() => expect(result.current.isOffline).toBe(true));
    expect(result.current.data).toEqual(['cached']);
    expect(result.current.isStale).toBe(true);
    // A network failure is never an `error` — callers branch on those to show
    // "not found" and similar server-authored answers.
    expect(result.current.error).toBeNull();
  });

  it('surfaces an HTTP failure as an error, not as offline', async () => {
    const { cache } = makeCache<string[]>();
    const { result } = renderHook(() =>
      useCachedResource({
        key: 'k',
        cache,
        fetcher: async () => {
          throw new ApiError(404, 'Product not found', {});
        },
      }),
    );

    await waitFor(() => expect(result.current.error).toBeInstanceOf(ApiError));
    expect(result.current.isOffline).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it('clears the offline flag once a later revalidation succeeds', async () => {
    const { cache } = makeCache<string[]>({ memory: ['cached'] });
    let online = false;
    const { result } = renderHook(() =>
      useCachedResource({
        key: 'k',
        cache,
        fetcher: async () => {
          if (!online) throw new NetworkError();
          return ['fresh'];
        },
      }),
    );

    await waitFor(() => expect(result.current.isOffline).toBe(true));
    online = true;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.isOffline).toBe(false);
    expect(result.current.data).toEqual(['fresh']);
  });

  it('idles without fetching when the key is null (no signed-in user)', async () => {
    const { cache } = makeCache<string[]>({ memory: ['cached'] });
    const fetcher = jest.fn();
    const { result } = renderHook(() => useCachedResource({ key: null, cache, fetcher }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it('paints from cache without revalidating when revalidate is false', async () => {
    const { cache } = makeCache<string[]>({ disk: ['lookup table'] });
    const fetcher = jest.fn();
    const { result } = renderHook(() =>
      useCachedResource({ key: 'k', cache, fetcher, revalidate: false }),
    );

    await waitFor(() => expect(result.current.data).toEqual(['lookup table']));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
