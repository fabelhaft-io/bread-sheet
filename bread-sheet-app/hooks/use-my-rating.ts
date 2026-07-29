import { useCallback, useEffect, useState } from 'react';

import type { RatingEntry } from '@/features/ratings/types';
import { api } from '@/lib/api';
import { findCachedRating, ratingsCache } from '@/lib/offline/caches';
import { getActiveCacheUser } from '@/lib/offline/store';

/**
 * The caller's own rating for one product, read out of the cached
 * `/api/users/me/ratings` payload (P8-002).
 *
 * This replaces the `GET /api/ratings/me/:barcode` round trip the product
 * screen used to make — one fewer request per product open, online as well as
 * off. The list is only fetched when this device has never cached it (a cold
 * install, or a deep link straight into a product): that is still a single
 * request, and it primes the Home tab at the same time.
 */
export function useMyRating(userId: string | null, barcode: string) {
  const [rating, setRating] = useState<RatingEntry | null>(() =>
    findCachedRating(ratingsCache.peek(), barcode),
  );
  const [isResolved, setIsResolved] = useState(() => ratingsCache.peek() !== null);

  // Reads the on-disk cache — an external system React cannot consult during
  // render — so the synchronous clear-on-sign-out is the intended pattern here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!userId) {
      setRating(null);
      setIsResolved(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const cached = await ratingsCache.read();
      if (cancelled) return;
      if (cached) {
        setRating(findCachedRating(cached, barcode));
        setIsResolved(true);
        return;
      }
      try {
        const fresh = await api.get<RatingEntry[]>('/api/users/me/ratings');
        if (cancelled) return;
        // The account may have changed while the request was in flight; these
        // are one user's private ratings and must not land in another's cache.
        if (getActiveCacheUser() === userId) await ratingsCache.write(fresh);
        setRating(findCachedRating(fresh, barcode));
      } catch {
        // Offline or an API failure — the user simply gets no pre-filled score.
      } finally {
        if (!cancelled) setIsResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, barcode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /** Reflect a just-submitted (or just-queued) rating without a refetch. */
  const applyLocalRating = useCallback((entry: RatingEntry) => {
    setRating(entry);
  }, []);

  return { rating, isResolved, applyLocalRating };
}
