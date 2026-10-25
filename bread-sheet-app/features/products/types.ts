/**
 * Shared types for the Add Product / review flow. Intentionally aligned with
 * the backend contract defined in TICKET-P5-003 so that the wire payload is a
 * direct `JSON.stringify` of a `ProductSubmission` object.
 */

export type ProductStatus = 'VERIFIED' | 'PENDING_REVIEW' | 'REJECTED';

/** TICKET-P6-009: `Product.kind` — a custom product has no `PackagedProduct`. */
export type ProductKind = 'PACKAGED' | 'CUSTOM';

/**
 * Nutrient & identity fields that make up a product submission. All optional
 * fields accept `null` explicitly — the backend differentiates between "not
 * provided" (null) and "zero" (0), especially for the reviewer diff screen.
 *
 * `gtin` (TICKET-P6-009, formerly `barcode`) identifies the manufactured
 * article being submitted; the server resolves or creates the `Product` +
 * `PackagedProduct` pair from it.
 */
export interface ProductSubmission {
  gtin: string;
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
 * The manufactured-article half of a `PACKAGED` product (TICKET-P6-009 /
 * ADR 0006). `null` on `ProductDetail.packaged` for a `CUSTOM` product —
 * there is nothing to store and nothing to display, not even "no nutrition
 * info yet".
 */
export interface PackagedDetails {
  gtin: string;
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
}

/**
 * Response shape for `GET /products/:productId` augmented with the
 * unverified and submitter metadata required for the reviewer flow. Kept
 * intentionally minimal — the reviewer banner only branches on `unverified`
 * and `submittedByUserId`.
 *
 * TICKET-P6-009: identity is `id` (a server UUID), not a barcode. GTIN and
 * nutrition/ingredient data live under `packaged`, which is `null` for a
 * `CUSTOM` product.
 */
export interface ProductDetail {
  id: string;
  kind: ProductKind;
  name: string;
  brand: string | null;
  image: string | null;
  description: string | null;
  status?: ProductStatus;
  unverified?: boolean;
  submittedByUserId?: string | null;
  /** Fully-populated submission view for the reviewer screen (P5-002). Stays flat. */
  submission?: Partial<ProductSubmission> | null;
  packaged: PackagedDetails | null;
}

// ─── Product editing & peer review (TICKET-P5-006) ──────────────────────────

export type EditVote = 'APPROVE' | 'REJECT';

/**
 * Wire payload for `POST /products/:productId/edits` — only the changed fields.
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
 * Response of `GET /products/:productId/edits/pending`. `originalValues` is
 * the snapshot at proposal time (the diff baseline), keyed by product column
 * name (`image`, not `productImageKey`; image values arrive as resolved
 * URLs).
 */
export interface PendingEdit {
  editId: string;
  productId: string;
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
