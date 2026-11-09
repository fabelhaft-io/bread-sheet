import type { RatingCategory } from '@/features/categories/types';

/**
 * Wire shapes for the rating endpoints. Shared because Phase 8 caches the
 * `/api/users/me/ratings` payload on disk and reads "my rating for this
 * product" back out of it, so more than one screen needs the type.
 */

/** Product summary embedded in a rating-history entry. */
export interface RatedProduct {
  id: string;
  kind: 'PACKAGED' | 'CUSTOM';
  name: string;
  brand: string | null;
  image: string | null;
}

/**
 * One entry of `GET /api/users/me/ratings`, newest first.
 *
 * `category` (TICKET-P6-003) is the user's own label for this rating — never
 * the machine-derived `ProductDetail.suggestedCategory` — and drives the
 * Home tab's chip filter and its counts. Required, not optional: every entry
 * the server returns carries it, `null` meaning uncategorised.
 */
export interface RatingEntry {
  id: string;
  /** 0–10, mirrors `taste`. */
  score: number;
  /** 0–10 in 0.5 increments. */
  taste: number;
  comment: string | null;
  createdAt: string;
  product: RatedProduct;
  category: RatingCategory | null;
}

/** The caller's own rating for a single product. */
export interface UserRating {
  id: string;
  taste: number;
  comment: string | null;
}
