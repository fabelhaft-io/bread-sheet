import { api } from '@/lib/api';
import type { ProductKind } from '@/features/products/types';

/**
 * TICKET-P6-008 Slice B — global product search.
 *
 * `GET /api/products/search` is the backend's contract (built in parallel);
 * this module is the one place the client encodes it, matching the shape
 * `features/products/api.ts` uses for every other product endpoint.
 */

export interface ProductSearchResult {
  id: string;
  kind: ProductKind;
  name: string;
  brand: string | null;
  image: string | null;
  /** Visible to every caller per P5-007; drives the "Needs review" badge. */
  unverified: boolean;
  /** `pg_trgm` similarity of the name against the query, 0–1. */
  similarity: number;
}

export interface ProductSearchResponse {
  results: ProductSearchResult[];
  nextCursor: string | null;
}

/** Cap measured on the RAW string, before trimming (CLAUDE.md input-hygiene convention). */
export const SEARCH_QUERY_MAX_RAW_CHARS = 100;
/** Minimum length after trimming. */
export const SEARCH_QUERY_MIN_TRIMMED_CHARS = 2;

/**
 * Mirrors the server's own validation so the client never sends a query it
 * would reject with `400` — a query under 2 trimmed characters is too broad
 * to be useful, and the raw-character cap guards against a pathological
 * input before it reaches a network call at all.
 */
export function isSearchableQuery(raw: string): boolean {
  if (raw.length > SEARCH_QUERY_MAX_RAW_CHARS) return false;
  return raw.trim().length >= SEARCH_QUERY_MIN_TRIMMED_CHARS;
}

/**
 * Cursor-paginated (page size 20, server-side) name/brand search across the
 * shared catalogue. `signal` lets a caller cancel a superseded request — see
 * `hooks/use-product-search.ts`, which aborts the previous call on every
 * keystroke before debouncing the next one.
 */
export function searchProducts(
  query: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ProductSearchResponse> {
  const params = new URLSearchParams({ q: query.trim() });
  if (cursor) params.set('cursor', cursor);
  return api.get<ProductSearchResponse>(`/api/products/search?${params.toString()}`, { signal });
}
