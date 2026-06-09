/**
 * Shared types for the Add Product / review flow. Intentionally aligned with
 * the backend contract defined in TICKET-P5-003 so that the wire payload is a
 * direct `JSON.stringify` of a `ProductSubmission` object.
 */

export type ProductStatus = 'VERIFIED' | 'PENDING_REVIEW' | 'REJECTED';

/**
 * Nutrient & identity fields that make up a product submission. All optional
 * fields accept `null` explicitly — the backend differentiates between "not
 * provided" (null) and "zero" (0), especially for the reviewer diff screen.
 */
export interface ProductSubmission {
  barcode: string;
  name: string;
  brand: string | null;
  genericName: string | null;
  energyKcal: number | null;
  fat: number | null;
  saturatedFat: number | null;
  carbohydrates: number | null;
  sugars: number | null;
  protein: number | null;
  salt: number | null;
  servingSize: string | null;
  productImageUrl: string;
  ingredients: string | null;
}

/**
 * Response shape for `POST /products/extract-label`. Every field is optional
 * so partial extractions can still pre-fill what's available. The
 * `confidence` field is used by the client to decide whether the "pre-fill"
 * or "manual" review mode is the default.
 */
export interface ExtractedLabel {
  name: string | null;
  brand: string | null;
  genericName: string | null;
  energyKcal: number | null;
  fat: number | null;
  saturatedFat: number | null;
  carbohydrates: number | null;
  sugars: number | null;
  protein: number | null;
  salt: number | null;
  servingSize: string | null;
  ingredients: string | null;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Response shape for `GET /products/:barcode` augmented with the unverified
 * and submitter metadata required for the reviewer flow. Kept intentionally
 * minimal — the reviewer banner only branches on `unverified` and
 * `submittedByUserId`.
 */
export interface ProductDetail {
  id: string;
  barcode: string;
  name: string;
  brand: string | null;
  image: string | null;
  description: string | null;
  status?: ProductStatus;
  unverified?: boolean;
  submittedByUserId?: string | null;
  /** Fully-populated submission view for the reviewer screen (P5-002). */
  submission?: Partial<ProductSubmission> | null;
}
