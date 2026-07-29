import type { RatingEntry } from '@/features/ratings/types';
import type { ProductDetail } from '@/features/products/types';

import { peekCache, readCache, writeCache } from './store';

/**
 * The three read caches Phase 8 keeps on disk (P8-002), expressed as
 * {@link ResourceCache} descriptors so `useCachedResource` does not need to
 * know how any of them are laid out.
 *
 * Document names (one JSON file each, per user):
 *   - `products` — barcode → product, LRU-capped at {@link PRODUCT_CACHE_LIMIT}
 *   - `ratings`  — the `/api/users/me/ratings` payload verbatim
 *   - `recents`  — the "Recently Opened" list
 *
 * Products live in a single map document rather than one file per barcode:
 * ~200 small records is trivial to read in one go, and it makes LRU eviction a
 * sort instead of a directory walk.
 */

export const PRODUCTS_DOC = 'products';
export const RATINGS_DOC = 'ratings';
export const RECENTS_DOC = 'recents';

/** Maximum number of products retained on disk; least-recently-seen evicted. */
export const PRODUCT_CACHE_LIMIT = 200;

/**
 * A cache a screen can paint from. `peek` is synchronous and only hits values
 * this process has already touched — that is what allows a first-frame render
 * without a spinner; `read` covers the cold-start case.
 */
export interface ResourceCache<T> {
  peek(): T | null;
  read(): Promise<T | null>;
  write(value: T): Promise<void>;
}

// ─── Products ─────────────────────────────────────────────────────────────────

interface ProductCacheEntry {
  data: ProductDetail;
  /** Epoch millis of the last read-through; drives LRU eviction. */
  touchedAt: number;
}

type ProductsDoc = Record<string, ProductCacheEntry>;

function evict(doc: ProductsDoc): ProductsDoc {
  const entries = Object.entries(doc);
  if (entries.length <= PRODUCT_CACHE_LIMIT) return doc;
  entries.sort((a, b) => b[1].touchedAt - a[1].touchedAt);
  return Object.fromEntries(entries.slice(0, PRODUCT_CACHE_LIMIT));
}

/** Cache descriptor for one product, backed by the shared `products` document. */
export function productCache(barcode: string): ResourceCache<ProductDetail> {
  return {
    peek() {
      const doc = peekCache<ProductsDoc>(PRODUCTS_DOC);
      return doc?.[barcode]?.data ?? null;
    },
    async read() {
      const doc = await readCache<ProductsDoc>(PRODUCTS_DOC);
      return doc?.[barcode]?.data ?? null;
    },
    async write(product) {
      const doc = (await readCache<ProductsDoc>(PRODUCTS_DOC)) ?? {};
      const next = evict({ ...doc, [barcode]: { data: product, touchedAt: Date.now() } });
      await writeCache(PRODUCTS_DOC, next);
    },
  };
}

// ─── Ratings ──────────────────────────────────────────────────────────────────

export const ratingsCache: ResourceCache<RatingEntry[]> = {
  peek: () => peekCache<RatingEntry[]>(RATINGS_DOC),
  read: () => readCache<RatingEntry[]>(RATINGS_DOC),
  write: (value) => writeCache(RATINGS_DOC, value),
};

/**
 * "My rating for this barcode", read out of the cached ratings list. This is
 * what replaces the per-product `GET /api/ratings/me/:barcode` round trip on
 * the product screen — online as well as offline.
 */
export function findCachedRating(
  ratings: RatingEntry[] | null,
  barcode: string,
): RatingEntry | null {
  return ratings?.find((entry) => entry.product.barcode === barcode) ?? null;
}

/**
 * Fold a just-submitted rating into the cached list so the Home tab and the
 * product screen reflect it immediately — including when the write is still
 * sitting in the outbox and the server has never seen it.
 */
export async function upsertCachedRating(entry: RatingEntry): Promise<void> {
  const current = (await ratingsCache.read()) ?? [];
  const without = current.filter((item) => item.product.barcode !== entry.product.barcode);
  await ratingsCache.write([entry, ...without]);
}

// ─── Recently opened ──────────────────────────────────────────────────────────

/** On-disk form of a recent product — `viewedAt` as an ISO string. */
export interface StoredRecentProduct {
  barcode: string;
  name: string;
  brand: string | null;
  image: string | null;
  viewedAt: string;
}

export const recentsCache: ResourceCache<StoredRecentProduct[]> = {
  peek: () => peekCache<StoredRecentProduct[]>(RECENTS_DOC),
  read: () => readCache<StoredRecentProduct[]>(RECENTS_DOC),
  write: (value) => writeCache(RECENTS_DOC, value),
};
