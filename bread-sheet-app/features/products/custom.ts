import type { ProductSearchResult } from '@/features/search/api';
import { ApiError } from '@/lib/api';

/**
 * Business logic for the Add Custom Product flow (TICKET-P6-007 / ADR 0006).
 * Lives here, not in `app/(app)/add-custom-product.tsx`, so the screen stays
 * UI-only — the same convention as `features/products/edit-form.ts` and
 * `features/search/match.ts`.
 */

/** Name length cap, measured on the RAW string before trimming (server mirror). */
export const CUSTOM_PRODUCT_NAME_MAX_RAW_CHARS = 80;

export type CustomProductNameValidation =
  | { valid: true; name: string }
  | { valid: false; reason: 'empty' | 'too_long'; message: string };

/**
 * Mirrors the server's name validation (1–80 chars, raw length capped before
 * trimming) so the client never sends a name it would reject with `400`.
 */
export function validateCustomProductName(raw: string): CustomProductNameValidation {
  if (raw.length > CUSTOM_PRODUCT_NAME_MAX_RAW_CHARS) {
    return {
      valid: false,
      reason: 'too_long',
      message: `Name must be ${CUSTOM_PRODUCT_NAME_MAX_RAW_CHARS} characters or fewer.`,
    };
  }
  const name = raw.trim();
  if (!name) {
    return { valid: false, reason: 'empty', message: 'Name is required.' };
  }
  return { valid: true, name };
}

/**
 * Minimum trimmed length before the "Create '<query>'" action is offered.
 * Matches `features/search/api.ts`'s `SEARCH_QUERY_MIN_TRIMMED_CHARS` — the
 * same query drives both the search box and the create prompt.
 */
export const CREATE_PROMPT_MIN_TRIMMED_CHARS = 2;

/** True once the trimmed query is long enough to offer "Create '<query>'". */
export function canOfferCreate(query: string): boolean {
  return query.trim().length >= CREATE_PROMPT_MIN_TRIMMED_CHARS;
}

/**
 * Decision 3's soft client-side duplicate gate: if any already-loaded search
 * result's trigram similarity to the query is ≥ this threshold, creating
 * requires a "Did you mean…?" confirmation first. The hard gate (an exact
 * normalised-name collision) lives on the server and always wins — this is
 * only what blocks "Negroni" / "Negroni" at the UI layer before the request
 * is even sent.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

/**
 * The most likely duplicate among the results already on screen, or `null`
 * if none clears the threshold. Takes the highest-similarity result rather
 * than assuming the list is sorted — safe regardless of API ordering.
 */
export function findLikelyDuplicate(
  results: ProductSearchResult[],
): ProductSearchResult | null {
  if (results.length === 0) return null;
  const top = results.reduce((best, r) => (r.similarity > best.similarity ? r : best));
  return top.similarity >= DUPLICATE_SIMILARITY_THRESHOLD ? top : null;
}

/** Shape of the server's hard duplicate-name conflict (`POST /api/custom-products` 409). */
export interface DuplicateNameErrorBody {
  code: 'duplicate_name';
  productId: string;
  message?: string;
}

/**
 * True when `err` is the server's hard duplicate-name gate — a 409 whose body
 * carries `code: 'duplicate_name'` and the existing product's id. Distinct
 * from the client's soft similarity gate above: this one fires even when the
 * soft gate didn't (e.g. the duplicate was created between the search
 * response and the create request), and the caller should navigate straight
 * to `productId` rather than show a form error.
 */
export function isDuplicateNameConflict(
  err: unknown,
): err is ApiError & { body: DuplicateNameErrorBody } {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const body = err.body as Partial<DuplicateNameErrorBody> | undefined;
  return body?.code === 'duplicate_name' && typeof body.productId === 'string';
}
