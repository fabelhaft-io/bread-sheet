import type { RatingEntry } from '@/features/ratings/types';
import type { ProductDetail } from '@/features/products/types';

import { peekCache, readCache, writeCache } from './store';

/**
 * The three read caches Phase 8 keeps on disk (P8-002), expressed as
 * {@link ResourceCache} descriptors so `useCachedResource` does not need to
 * know how any of them are laid out.
 *
 * Document names (one JSON file each, per user):
 *   - `products` — `Product.id` → product, LRU-capped at
 *     {@link PRODUCT_CACHE_LIMIT}, plus a `gtin → id` index (TICKET-P6-009)
 *     so an offline scan of a cached product still resolves without a
 *     network round trip.
 *   - `ratings`  — the `/api/users/me/ratings` payload verbatim
 *   - `recents`  — the "Recently Opened" list
 *
 * Products live in a single map document rather than one file per id:
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

/**
 * On-disk shape of the `products` document (TICKET-P6-009). `byId` is the
 * LRU-capped map keyed by `Product.id`; `gtinIndex` is a reverse lookup so a
 * scanned or typed GTIN can resolve to an id without a network request — the
 * resolver screen checks it before calling the server.
 */
interface ProductsDoc {
  byId: Record<string, ProductCacheEntry>;
  gtinIndex: Record<string, string>;
}

const EMPTY_DOC: ProductsDoc = { byId: {}, gtinIndex: {} };

function evict(doc: ProductsDoc): ProductsDoc {
  const entries = Object.entries(doc.byId);
  if (entries.length <= PRODUCT_CACHE_LIMIT) return doc;
  entries.sort((a, b) => b[1].touchedAt - a[1].touchedAt);
  const kept = entries.slice(0, PRODUCT_CACHE_LIMIT);
  const keptIds = new Set(kept.map(([id]) => id));
  const gtinIndex = Object.fromEntries(
    Object.entries(doc.gtinIndex).filter(([, id]) => keptIds.has(id)),
  );
  return { byId: Object.fromEntries(kept), gtinIndex };
}

/** Cache descriptor for one product, backed by the shared `products` document. */
export function productCache(id: string): ResourceCache<ProductDetail> {
  return {
    peek() {
      const doc = peekCache<ProductsDoc>(PRODUCTS_DOC);
      return doc?.byId[id]?.data ?? null;
    },
    async read() {
      const doc = await readCache<ProductsDoc>(PRODUCTS_DOC);
      return doc?.byId[id]?.data ?? null;
    },
    async write(product) {
      const doc = (await readCache<ProductsDoc>(PRODUCTS_DOC)) ?? EMPTY_DOC;
      const gtin = product.packaged?.gtin;
      const next = evict({
        byId: { ...doc.byId, [id]: { data: product, touchedAt: Date.now() } },
        gtinIndex: gtin ? { ...doc.gtinIndex, [gtin]: id } : doc.gtinIndex,
      });
      await writeCache(PRODUCTS_DOC, next);
    },
  };
}

/** Synchronous `gtin → id` lookup — what lets an offline scan paint from cache. */
export function peekProductIdByGtin(gtin: string): string | null {
  const doc = peekCache<ProductsDoc>(PRODUCTS_DOC);
  return doc?.gtinIndex[gtin] ?? null;
}

/** Disk-backed `gtin → id` lookup, for the cold-start case `peek` cannot see. */
export async function readProductIdByGtin(gtin: string): Promise<string | null> {
  const doc = await readCache<ProductsDoc>(PRODUCTS_DOC);
  return doc?.gtinIndex[gtin] ?? null;
}

// ─── Ratings ──────────────────────────────────────────────────────────────────

export const ratingsCache: ResourceCache<RatingEntry[]> = {
  peek: () => peekCache<RatingEntry[]>(RATINGS_DOC),
  read: () => readCache<RatingEntry[]>(RATINGS_DOC),
  write: (value) => writeCache(RATINGS_DOC, value),
};

/**
 * "My rating for this product", read out of the cached `/api/users/me/ratings`
 * payload. This is what replaces the per-product
 * `GET /api/ratings/me/:barcode` round trip on the product screen — online as
 * well as offline. Keyed by `Product.id` since TICKET-P6-009.
 */
export function findCachedRating(
  ratings: RatingEntry[] | null,
  productId: string,
): RatingEntry | null {
  return ratings?.find((entry) => entry.product.id === productId) ?? null;
}

/**
 * Fold a just-submitted rating into the cached list so the Home tab and the
 * product screen reflect it immediately — including when the write is still
 * sitting in the outbox and the server has never seen it.
 */
export async function upsertCachedRating(entry: RatingEntry): Promise<void> {
  const current = (await ratingsCache.read()) ?? [];
  const without = current.filter((item) => item.product.id !== entry.product.id);
  await ratingsCache.write([entry, ...without]);
}

// ─── Recently opened ──────────────────────────────────────────────────────────

/** On-disk form of a recent product — `viewedAt` as an ISO string. */
export interface StoredRecentProduct {
  id: string;
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
