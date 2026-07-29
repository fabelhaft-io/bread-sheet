import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from 'react';

import { type StoredRecentProduct, recentsCache } from '@/lib/offline/caches';

import { useSession } from './use-session';

export interface RecentProduct {
  barcode: string;
  name: string;
  brand: string | null;
  image: string | null;
  viewedAt: Date;
}

interface RecentProductsContextValue {
  recentProducts: RecentProduct[];
  addRecentProduct: (product: Omit<RecentProduct, 'viewedAt'>) => void;
}

const RecentProductsContext = createContext<RecentProductsContextValue>({
  recentProducts: [],
  addRecentProduct: () => {},
});

const MAX_RECENT = 20;

function toStored(item: RecentProduct): StoredRecentProduct {
  return { ...item, viewedAt: item.viewedAt.toISOString() };
}

function fromStored(item: StoredRecentProduct): RecentProduct {
  return { ...item, viewedAt: new Date(item.viewedAt) };
}

/**
 * "Recently Opened", persisted per user (P8-002).
 *
 * The list used to live in plain `useState`, so it was empty on every cold
 * start — the single biggest contributor to the app feeling unresponsive at
 * launch. It is now mirrored to the offline store: seeded synchronously from
 * the in-memory copy so it paints in the first frame, then hydrated from disk.
 */
export function RecentProductsProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  const [recentProducts, setRecentProducts] = useState<RecentProduct[]>(
    () => recentsCache.peek()?.map(fromStored) ?? [],
  );

  /**
   * Whose list has been read off disk. This gates the write effect and exists
   * to stop a cross-user leak: when `userId` changes, both effects re-run in
   * the same commit while `recentProducts` may still hold the previous user's
   * list — ungated, the write would persist account A's recents into account
   * B's namespace before hydration ever resolved.
   */
  const hydratedFor = useRef<string | null>(null);
  /** Who the list currently on screen belongs to. */
  const displayedFor = useRef<string | null>(userId);
  /** Only persist once the user has actually opened something. */
  const dirty = useRef(false);

  useEffect(() => {
    hydratedFor.current = null;
    dirty.current = false;
    if (displayedFor.current !== userId) {
      // The account changed: drop the previous user's list immediately rather
      // than waiting for the disk read. (On mount this is a no-op, so the
      // synchronous `peek` seed still paints in the first frame.)
      setRecentProducts([]);
      displayedFor.current = userId;
    }
    if (!userId) return;
    let cancelled = false;
    recentsCache
      .read()
      .then((stored) => {
        if (cancelled) return;
        const restored = stored?.map(fromStored) ?? [];
        setRecentProducts((current) => {
          // A product opened before the disk read resolved must not be
          // clobbered by it — keep it on top and append the stored history.
          if (current.length === 0) return restored;
          const seen = new Set(current.map((item) => item.barcode));
          return [...current, ...restored.filter((item) => !seen.has(item.barcode))].slice(
            0,
            MAX_RECENT,
          );
        });
        hydratedFor.current = userId;
      })
      .catch(() => {
        if (!cancelled) hydratedFor.current = userId;
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const addRecentProduct = useCallback((product: Omit<RecentProduct, 'viewedAt'>) => {
    dirty.current = true;
    setRecentProducts((prev) => {
      // Move to top if already exists, otherwise prepend
      const filtered = prev.filter((p) => p.barcode !== product.barcode);
      return [{ ...product, viewedAt: new Date() }, ...filtered].slice(0, MAX_RECENT);
    });
  }, []);

  useEffect(() => {
    if (!dirty.current || !userId || hydratedFor.current !== userId) return;
    void recentsCache.write(recentProducts.map(toStored));
  }, [recentProducts, userId]);

  return (
    <RecentProductsContext.Provider value={{ recentProducts, addRecentProduct }}>
      {children}
    </RecentProductsContext.Provider>
  );
}

export function useRecentProducts() {
  return useContext(RecentProductsContext);
}
