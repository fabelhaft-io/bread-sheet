/**
 * Wire shapes for the rating endpoints. Shared because Phase 8 caches the
 * `/api/users/me/ratings` payload on disk and reads "my rating for this
 * product" back out of it, so more than one screen needs the type.
 */

/** Product summary embedded in a rating-history entry. */
export interface RatedProduct {
  id: string;
  barcode: string;
  name: string;
  brand: string | null;
  image: string | null;
}

/** One entry of `GET /api/users/me/ratings`, newest first. */
export interface RatingEntry {
  id: string;
  /** 0–10, mirrors `taste`. */
  score: number;
  /** 0–10 in 0.5 increments. */
  taste: number;
  comment: string | null;
  createdAt: string;
  product: RatedProduct;
}

/** The caller's own rating for a single product. */
export interface UserRating {
  id: string;
  taste: number;
  comment: string | null;
}
