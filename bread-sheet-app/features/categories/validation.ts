/**
 * Client-side validation for a custom category name (TICKET-P6-003), mirroring
 * the server's own rule (1–24 chars, max 40 categories per user) so the
 * client never sends a name it would reject with `400`. Same shape as
 * `features/products/custom.ts#validateCustomProductName`.
 */

/** Cap measured on the RAW string, before trimming (CLAUDE.md input-hygiene convention). */
export const CATEGORY_NAME_MAX_RAW_CHARS = 24;

/** Server-side ceiling on categories per user — surfaced so the picker can explain a 403/400. */
export const MAX_CATEGORIES_PER_USER = 40;

export type CategoryNameValidation =
  | { valid: true; name: string }
  | { valid: false; reason: 'empty' | 'too_long'; message: string };

export function validateCategoryName(raw: string): CategoryNameValidation {
  if (raw.length > CATEGORY_NAME_MAX_RAW_CHARS) {
    return {
      valid: false,
      reason: 'too_long',
      message: `Name must be ${CATEGORY_NAME_MAX_RAW_CHARS} characters or fewer.`,
    };
  }
  const name = raw.trim();
  if (!name) {
    return { valid: false, reason: 'empty', message: 'Name is required.' };
  }
  return { valid: true, name };
}
