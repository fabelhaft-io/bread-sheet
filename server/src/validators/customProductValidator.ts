import { isValidUuid } from './idValidator.js';
import {
  PRODUCT_IMAGE_KEY_RE,
  SubmissionValidationError,
  requireString,
} from './productSubmissionValidator.js';

/**
 * TICKET-P6-007 validators for custom products (`Product.kind === CUSTOM`).
 *
 * Both the create and correction bodies are a strict allowlist, not a
 * subset check: any key outside the allowed set — including every
 * `PackagedProduct`-only field (gtin/barcode, genericName, the nutrition
 * fields, servingSize, ingredients, allergens) and `brand` (a custom
 * product's identity is its name alone; it has no brand) — is rejected with
 * `PackagedFieldNotAllowedError` (400), not silently dropped.
 *
 * `PackagedFieldNotAllowedError` lives here (not in `customProductService.js`,
 * which imports it back) deliberately: this module has no runtime dependency
 * on `../db.js`, so a pure validator unit test never has to stand up a fake
 * Prisma client just to import an error class.
 */

export class PackagedFieldNotAllowedError extends Error {
  readonly code = 'packaged_field_not_allowed';
  constructor(public readonly field: string) {
    super(`${field} is not editable on a custom product`);
  }
}

const MAX_NAME_LENGTH = 80;

/**
 * 1–80 chars after trimming, with the 80 cap measured on the RAW string
 * BEFORE trimming (CLAUDE.md convention) — a string that is mostly padding
 * around a short real name must still be rejected, not silently truncated
 * down to something that looks fine once trimmed.
 */
export function validateCustomProductName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SubmissionValidationError('name', 'name must be a string');
  }
  if (value.length === 0) {
    throw new SubmissionValidationError('name', 'name is required');
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new SubmissionValidationError(
      'name',
      `name must be at most ${MAX_NAME_LENGTH} characters`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SubmissionValidationError('name', 'name is required');
  }
  return trimmed;
}

function validateImageKey(value: unknown, field: string): string {
  const key = requireString(value, field, 1024);
  if (!PRODUCT_IMAGE_KEY_RE.test(key)) {
    throw new SubmissionValidationError(field, `${field} must be a server-issued upload key`);
  }
  return key;
}

export interface CustomProductCreateInput {
  name: string;
  imageKey: string | null;
}

// Exactly the wire shape in the API contract: `{ name, imageKey? }`.
const CREATE_KEYS = new Set(['name', 'imageKey']);

export function validateCustomProductCreate(body: unknown): CustomProductCreateInput {
  if (!body || typeof body !== 'object') {
    throw new SubmissionValidationError('body', 'Request body required');
  }
  const b = body as Record<string, unknown>;

  for (const key of Object.keys(b)) {
    if (!CREATE_KEYS.has(key)) {
      throw new PackagedFieldNotAllowedError(key);
    }
  }

  const name = validateCustomProductName(b.name);

  let imageKey: string | null = null;
  if (b.imageKey !== undefined && b.imageKey !== null) {
    imageKey = validateImageKey(b.imageKey, 'imageKey');
  }

  return { name, imageKey };
}

export interface CustomProductCorrectionInput {
  productId: string;
  /** `null` = not being renamed. */
  name: string | null;
  /** `null` = photo not replaced, keep current. */
  imageKey: string | null;
}

// PATCH /products/:productId for a CUSTOM product: `{ name?, productImageKey? }`.
// `productImageKey` (not `imageKey`) deliberately matches the existing field
// name the PACKAGED correction flow already uses — the wire name for "the
// photo" is not renamed per kind.
const CORRECTION_KEYS = new Set(['name', 'productImageKey']);

export function validateCustomProductCorrection(body: unknown): CustomProductCorrectionInput {
  if (!body || typeof body !== 'object') {
    throw new SubmissionValidationError('body', 'Request body required');
  }
  const b = body as Record<string, unknown>;

  const productId = requireString(b.productId, 'productId', 64);
  if (!isValidUuid(productId)) {
    throw new SubmissionValidationError('productId', 'productId must be a valid id');
  }

  for (const key of Object.keys(b)) {
    if (key === 'productId') continue;
    if (!CORRECTION_KEYS.has(key)) {
      throw new PackagedFieldNotAllowedError(key);
    }
  }

  let name: string | null = null;
  if (b.name !== undefined && b.name !== null) {
    name = validateCustomProductName(b.name);
  }

  let imageKey: string | null = null;
  if (b.productImageKey !== undefined && b.productImageKey !== null) {
    imageKey = validateImageKey(b.productImageKey, 'productImageKey');
  }

  if (name === null && imageKey === null) {
    throw new SubmissionValidationError('body', 'No editable fields provided');
  }

  return { productId, name, imageKey };
}
