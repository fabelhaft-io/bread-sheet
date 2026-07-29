import { useCallback, useEffect, useRef, useState } from 'react';

import { NetworkError } from '@/lib/api';
import type { ResourceCache } from '@/lib/offline/caches';

/**
 * Stale-while-revalidate over the on-disk cache (P8-002).
 *
 * Order of operations, which is the whole point of the hook:
 *   1. Seed synchronously from the in-memory mirror so a warm resource paints
 *      in the first frame — no spinner, no flash of empty state.
 *   2. If that misses, read the disk copy and paint that.
 *   3. Revalidate over the network in the background and swap on success.
 *   4. On a network failure keep showing the cached copy and raise `isOffline`;
 *      on an HTTP failure surface the error so the caller can branch on it
 *      (404 → "not found", which is a real answer, unlike "no signal").
 */

export interface CachedResource<T> {
  /** Cached or fresh value; `null` until something resolves. */
  data: T | null;
  /** True only while there is nothing to paint yet. */
  isLoading: boolean;
  /** A revalidation is in flight over an already-painted value. */
  isRevalidating: boolean;
  /** The last revalidation failed because the request never reached the server. */
  isOffline: boolean;
  /** True when `data` came from cache and the newest revalidation failed. */
  isStale: boolean;
  /** Non-network failure from the last revalidation (e.g. an `ApiError`). */
  error: unknown;
  /** Re-run the fetcher; resolves when it settles. */
  refresh: () => Promise<void>;
}

export interface CachedResourceOptions<T> {
  /** Identity of the resource; changing it restarts the whole cycle. */
  key: string | null;
  cache: ResourceCache<T>;
  fetcher: () => Promise<T>;
  /** When false the hook idles — no cache read, no request. Default true. */
  enabled?: boolean;
  /**
   * When false the hook paints from cache and never revalidates. Used by the
   * product screen, which reads the ratings list purely as a lookup table.
   */
  revalidate?: boolean;
}

export function useCachedResource<T>({
  key,
  cache,
  fetcher,
  enabled = true,
  revalidate = true,
}: CachedResourceOptions<T>): CachedResource<T> {
  const active = enabled && key !== null;

  // Seeding from `peek` inside the initialiser (not an effect) is what buys the
  // first-frame paint: by the time React commits, the value is already there.
  const [data, setData] = useState<T | null>(() => (active ? cache.peek() : null));
  const [isLoading, setIsLoading] = useState(() => active && cache.peek() === null);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Kept in refs so `run` stays stable across renders — the caller's `fetcher`
  // and `cache` are usually built inline and would otherwise restart the cycle
  // on every render. Synced in an effect (not during render) so the refs are
  // only ever written after commit; this effect is declared before the one that
  // reads them, so it always runs first.
  const fetcherRef = useRef(fetcher);
  const cacheRef = useRef(cache);
  useEffect(() => {
    fetcherRef.current = fetcher;
    cacheRef.current = cache;
  });

  // Bumped whenever the key changes so responses from a previous key are dropped.
  const generation = useRef(0);

  const run = useCallback(async () => {
    if (!active) return;
    const gen = generation.current;
    setIsRevalidating(true);
    try {
      const fresh = await fetcherRef.current();
      if (gen !== generation.current) return;
      setData(fresh);
      setError(null);
      setIsOffline(false);
      setIsStale(false);
      void cacheRef.current.write(fresh);
    } catch (err) {
      if (gen !== generation.current) return;
      if (err instanceof NetworkError) {
        setIsOffline(true);
        setIsStale(true);
      } else {
        setError(err);
      }
    } finally {
      if (gen === generation.current) {
        setIsRevalidating(false);
        setIsLoading(false);
      }
    }
  }, [active]);

  // Seeding state from the cache *is* the "subscribe to an external system"
  // case the rule exists to permit — the external system here is the on-disk
  // store, which React cannot read during render.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    generation.current += 1;
    const gen = generation.current;

    if (!active) {
      setData(null);
      setIsLoading(false);
      setIsStale(false);
      setIsOffline(false);
      setError(null);
      return;
    }

    const seeded = cacheRef.current.peek();
    setData(seeded);
    setIsLoading(seeded === null);
    setError(null);
    setIsStale(false);

    let cancelled = false;

    (async () => {
      if (seeded === null) {
        const stored = await cacheRef.current.read();
        if (cancelled || gen !== generation.current) return;
        if (stored !== null) {
          setData(stored);
          setIsLoading(false);
        }
      }
      if (!revalidate) {
        if (!cancelled && gen === generation.current) setIsLoading(false);
        return;
      }
      if (cancelled || gen !== generation.current) return;
      await run();
    })();

    return () => {
      cancelled = true;
    };
    // `run` is stable for a given `active`; `key` is what restarts the cycle.
  }, [key, active, revalidate, run]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { data, isLoading, isRevalidating, isOffline, isStale, error, refresh: run };
}
