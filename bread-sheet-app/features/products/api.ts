import { api, ApiError } from '@/lib/api';

import type { ExtractedLabel, ProductSubmission } from './types';

/**
 * Result of a product-image upload. The backend runs an AI plausibility check
 * before persisting the image and, for product photos, reads front-of-pack
 * identity suggestions off the packaging (P5-005). A rejected image is never
 * stored and surfaces as a 422 `ApiError`.
 */
export interface ProductImageUploadResult {
  url: string;
  name: string | null;
  brand: string | null;
  genericName: string | null;
}

/**
 * API helpers for the Add Product flow. Each function maps 1:1 to a backend
 * endpoint defined in TICKET-P5-003. They live in `features/products/` so
 * screen files stay UI-only and the calls are trivially mockable in tests.
 *
 * NOTE: The backend endpoints are not yet implemented (P5-003 is open) — this
 * is the client-side skeleton. Once the backend lands these signatures should
 * not need to change.
 */

/**
 * Upload a product or label image. The API returns the predicted
 * `processed/` S3 URL immediately (a Lambda resize runs asynchronously, see
 * P5-003). The `kind` prefix (`product/` vs `label/`) tells the Lambda which
 * size cap to apply.
 */
export async function uploadProductImage(
  imageUri: string,
  kind: 'product' | 'label',
  authHeader: string | null,
): Promise<ProductImageUploadResult> {
  const form = new FormData();
  form.append('kind', kind);
  form.append('image', {
    uri: imageUri,
    name: `${kind}.jpg`,
    type: 'image/jpeg',
  } as unknown as Blob);

  const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/products/upload-image`, {
    method: 'POST',
    headers: authHeader ? { Authorization: authHeader } : undefined,
    body: form,
  });
  if (!res.ok) {
    // Mirror lib/api's error contract so callers can branch on `.status === 422`
    // and read the plausibility `reason` off `.body`, just like the JSON helpers.
    const body = await res.json().catch(() => ({}));
    const message =
      (body && typeof body === 'object' && typeof (body as { reason?: unknown }).reason === 'string'
        ? (body as { reason: string }).reason
        : null) ?? `Image upload failed: ${res.status}`;
    throw new ApiError(res.status, message, body);
  }
  const data = (await res.json()) as Partial<ProductImageUploadResult> & { url: string };
  return {
    url: data.url,
    name: data.name ?? null,
    brand: data.brand ?? null,
    genericName: data.genericName ?? null,
  };
}

/**
 * Structure a nutritional label from on-device OCR text. Callers should only
 * invoke this when the extracted text clears `MIN_OCR_LENGTH`; otherwise use
 * `extractLabelFromImage` so the backend can run vision inference.
 */
export function extractLabelFromText(rawText: string): Promise<ExtractedLabel> {
  return api.post<ExtractedLabel>('/api/products/extract-label', { rawText });
}

/**
 * Fallback extraction path — sends the label image to the backend when
 * on-device OCR returned too little text. Uses `multipart/form-data`; the
 * generic JSON helper in `lib/api.ts` is bypassed.
 */
export async function extractLabelFromImage(
  imageUri: string,
  authHeader: string | null,
): Promise<ExtractedLabel> {
  const form = new FormData();
  // React Native's FormData accepts `{uri, name, type}` objects — this is
  // non-standard but works on both iOS/Android and under Hermes.
  form.append('image', {
    uri: imageUri,
    name: 'label.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);

  const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/products/extract-label`, {
    method: 'POST',
    headers: authHeader ? { Authorization: authHeader } : undefined,
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Label extraction failed: ${res.status}`);
  }
  return res.json() as Promise<ExtractedLabel>;
}

/**
 * Submit a new product. The server persists it as `PENDING_REVIEW` and runs
 * AI plausibility checks before responding. A 422 indicates the submission
 * was rejected for plausibility reasons and carries an inline error payload
 * the form can surface.
 */
export function submitProduct(payload: ProductSubmission) {
  return api.post<{ barcode: string; status: string }>('/api/products', payload);
}

/**
 * Cast a "looks correct" vote on a `PENDING_REVIEW` product. After two
 * distinct verifiers approve the product is auto-promoted to `VERIFIED`.
 */
export function approveProduct(barcode: string) {
  return api.post<{ verifications: number }>(
    `/api/products/${encodeURIComponent(barcode)}/verify`,
    {},
  );
}

/**
 * Cast a "something looks wrong" vote. The DELETE method is the channel for
 * REJECT votes — it does not retract an existing approval.
 */
export function rejectProduct(barcode: string) {
  return api.delete<{ verifications: number }>(
    `/api/products/${encodeURIComponent(barcode)}/verify`,
  );
}
