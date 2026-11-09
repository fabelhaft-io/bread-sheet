import { useCallback, useEffect, useRef, useState } from 'react';

import { isSearchableQuery, searchProducts, type ProductSearchResult } from '@/features/search/api';
import { NetworkError } from '@/lib/api';

/** TICKET-P6-008 Slice B — debounce window before a keystroke becomes a request. */
const DEBOUNCE_MS = 300;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export interface ProductSearchState {
  results: ProductSearchResult[];
  /** True only for the initial page of a query (no results painted yet). */
  isLoading: boolean;
  /** A "load more" page is in flight over an already-painted first page. */
  isLoadingMore: boolean;
  /** The last request never reached the server. */
  isOffline: boolean;
  /** Non-network failure (e.g. an `ApiError`) from the last request. */
  error: unknown;
  hasMore: boolean;
  loadMore: () => void;
  /**
   * True only once the **current** `query`'s first page has itself
   * successfully resolved — not merely once `isLoading` has gone back to
   * `false`. `isLoading` is set inside `fetchPage`, which only runs *after*
   * the `DEBOUNCE_MS` timer fires, so for the whole debounce window after
   * every keystroke `isLoading` is `false` while `results` is still stale
   * (the previous query's, or `[]`). A caller gating a "create new" action
   * on "the results have loaded" must use this instead (TICKET-P6-007 /
   * review finding F1) — a failed or offline search never counts as
   * settled, by design: `results` for a query that failed to load is not a
   * basis for deciding anything, soft-duplicate-gate included.
   */
  hasSettled: boolean;
}

/**
 * Debounced, cancellable global product search (TICKET-P6-008 Slice B).
 *
 * `active` gates the whole hook — the Home tab only wants this to do
 * anything in the "All products" scope, and it must make *zero* requests
 * while scoped to "Mine" (Slice A's in-memory filter is the only thing
 * running there).
 *
 * Cancellation: the debounce effect's cleanup runs on every keystroke
 * (`query` change) *before* the next one is scheduled, aborting whatever
 * controller is currently tracked — "in-flight requests cancelled on the
 * next keystroke", per the ticket, not merely superseded by a later one that
 * happens to resolve first. A controller that resolves after being aborted
 * is still checked for `.aborted` inside the `.then`/`.catch`, because
 * `AbortController.abort()` only *requests* cancellation — whatever promise
 * `searchProducts` returned may still settle on its own.
 */
export function useProductSearch(query: string, active: boolean): ProductSearchState {
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hasMore, setHasMore] = useState(false);
  // The query a successful first-page response actually came back for — see
  // `hasSettled` below. Deliberately a *value*, not a boolean: comparing it
  // against the live `query` is what makes a new keystroke immediately
  // un-settle the previous query's "yes, loaded" state, with no extra
  // bookkeeping needed when a fetch starts.
  const [settledQuery, setSettledQuery] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const cursorRef = useRef<string | null>(null);

  const fetchPage = useCallback((q: string, cursor: string | null, append: boolean) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    if (append) setIsLoadingMore(true);
    else setIsLoading(true);
    setError(null);

    searchProducts(q, cursor, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setResults((prev) => (append ? [...prev, ...res.results] : res.results));
        cursorRef.current = res.nextCursor;
        setHasMore(res.nextCursor !== null);
        setIsOffline(false);
        // Only the first page settles the query — a `loadMore` page is an
        // extension of an already-settled query, not a new one.
        if (!append) setSettledQuery(q);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        if (err instanceof NetworkError) {
          setIsOffline(true);
          if (!append) {
            setResults([]);
            setHasMore(false);
          }
        } else {
          setError(err);
        }
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setIsLoading(false);
        setIsLoadingMore(false);
      });
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- resetting to idle when
     the scope deactivates or the query drops below the searchable length;
     mirrors the reset in app/(app)/product/gtin/[gtin].tsx */
  useEffect(() => {
    if (!active || !isSearchableQuery(query)) {
      setResults([]);
      setIsLoading(false);
      setIsLoadingMore(false);
      setIsOffline(false);
      setError(null);
      setHasMore(false);
      setSettledQuery(null);
      cursorRef.current = null;
      return;
    }

    const timer = setTimeout(() => {
      fetchPage(query, null, false);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Cancel whatever the previous keystroke's debounce already sent —
      // this cleanup runs on every `query` change, which is "the next
      // keystroke" from the in-flight request's point of view.
      controllerRef.current?.abort();
    };
  }, [query, active, fetchPage]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadMore = useCallback(() => {
    if (!hasMore || isLoading || isLoadingMore) return;
    fetchPage(query, cursorRef.current, true);
  }, [hasMore, isLoading, isLoadingMore, fetchPage, query]);

  // Settled for THIS query, not merely "a request for some earlier query
  // once resolved" — a keystroke that changes `query` un-settles immediately,
  // before the new debounce timer has even been scheduled.
  const hasSettled = settledQuery === query;

  return { results, isLoading, isLoadingMore, isOffline, error, hasMore, loadMore, hasSettled };
}
