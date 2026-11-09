/**
 * Wire shapes for the category endpoints (TICKET-P6-003).
 *
 * A category is a label the *user* owns, not a fact about the product — see
 * the ticket's design stance. Contrast with `ProductDetail.suggestedCategory`
 * (`features/products/types.ts`), which is machine-derived and never written
 * here.
 */

/** One row of `GET /api/users/me/categories` (`categoryController.ts#serializeCategory`). */
export interface UserCategory {
  id: string;
  name: string;
  /** Slugified, case-folded form — what a seed is matched against. */
  slug: string;
  isSeed: boolean;
  createdAt: string;
  /** Count of the caller's own ratings currently tagged with this category. */
  ratingCount: number;
}

/** `POST /api/users/me/categories` — find-or-create, one or the other. */
export type CreateCategoryPayload = { name: string } | { seedSlug: string };

/**
 * Embedded on a rating-history entry (`GET /api/users/me/ratings`,
 * `features/ratings/types.ts#RatingEntry`). Deliberately a narrower shape
 * than `UserCategory` — a rating only ever needs to display the name.
 */
export interface RatingCategory {
  id: string;
  name: string;
}
