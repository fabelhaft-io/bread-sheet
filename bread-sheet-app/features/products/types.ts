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
  /** S3 object key (`processed/{uuid}.jpg`) returned by the upload-image endpoint. */
  productImageKey: string;
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
  /** Nutrition + identity columns, present on cached products (P5-006 edit form). */
  genericName?: string | null;
  energyKcal?: number | null;
  fat?: number | null;
  saturatedFat?: number | null;
  carbohydrates?: number | null;
  sugars?: number | null;
  protein?: number | null;
  salt?: number | null;
  servingSize?: string | null;
  ingredients?: string | null;
}

// ─── Product editing & peer review (TICKET-P5-006) ──────────────────────────

export type EditVote = 'APPROVE' | 'REJECT';

/**
 * Wire payload for `POST /products/:barcode/edits` — only the changed fields.
 * `productImageKey` is included only when the photo was replaced.
 */
export interface ProductEditChanges {
  name?: string;
  brand?: string | null;
  genericName?: string | null;
  energyKcal?: number | null;
  fat?: number | null;
  saturatedFat?: number | null;
  carbohydrates?: number | null;
  sugars?: number | null;
  protein?: number | null;
  salt?: number | null;
  servingSize?: string | null;
  ingredients?: string | null;
  productImageKey?: string;
}

/**
 * Response of `GET /products/:barcode/edits/pending`. `originalValues` is the
 * snapshot at proposal time (the diff baseline), keyed by product column name
 * (`image`, not `productImageKey`; image values arrive as resolved URLs).
 */
export interface PendingEdit {
  editId: string;
  barcode: string;
  originalValues: Record<string, string | number | null>;
  proposedChanges: Record<string, string | number | null>;
  approvals: number;
  rejections: number;
  createdAt: string;
  viewer: {
    isAuthor: boolean;
    vote: EditVote | null;
    dismissed: boolean;
  };
}
