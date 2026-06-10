import { ProductSubmissionInput } from '../services/productService.js';

export class SubmissionValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'SubmissionValidationError';
  }
}

// Helpers — keep these terse, they're called per-field.
function requireString(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SubmissionValidationError(field, `${field} is required`);
  }
  if (value.length > max) {
    throw new SubmissionValidationError(field, `${field} is too long`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  field: string,
  max = 500,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new SubmissionValidationError(field, `${field} must be a string`);
  }
  if (value.length > max) {
    throw new SubmissionValidationError(field, `${field} is too long`);
  }
  return value.trim() || null;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SubmissionValidationError(field, `${field} must be a number`);
  }
  if (value < 0 || value >= 10000) {
    throw new SubmissionValidationError(field, `${field} is out of range`);
  }
  return value;
}

export function validateProductSubmission(
  body: unknown,
): ProductSubmissionInput {
  if (!body || typeof body !== 'object') {
    throw new SubmissionValidationError('body', 'Request body required');
  }
  const b = body as Record<string, unknown>;

  // Barcode: digits only, 8–14 chars
  const barcode = requireString(b.barcode, 'barcode', 14);
  if (!/^\d{8,14}$/.test(barcode)) {
    throw new SubmissionValidationError(
      'barcode',
      'barcode must be 8–14 digits',
    );
  }

  // Product image key: exactly the shape POST /upload-image issues
  // (`processed/{uuid}.jpg`). Anything else — including absolute URLs from the
  // pre-key era — is rejected so arbitrary strings never reach the image column.
  const productImageKey = requireString(
    b.productImageKey,
    'productImageKey',
    1024,
  );
  if (!/^processed\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/.test(productImageKey)) {
    throw new SubmissionValidationError(
      'productImageKey',
      'productImageKey must be a server-issued upload key',
    );
  }

  return {
    barcode,
    name: requireString(b.name, 'name'),
    brand: optionalString(b.brand, 'brand'),
    genericName: optionalString(b.genericName, 'genericName'),
    energyKcal: optionalNumber(b.energyKcal, 'energyKcal'),
    fat: optionalNumber(b.fat, 'fat'),
    saturatedFat: optionalNumber(b.saturatedFat, 'saturatedFat'),
    carbohydrates: optionalNumber(b.carbohydrates, 'carbohydrates'),
    sugars: optionalNumber(b.sugars, 'sugars'),
    protein: optionalNumber(b.protein, 'protein'),
    salt: optionalNumber(b.salt, 'salt'),
    servingSize: optionalString(b.servingSize, 'servingSize', 100),
    productImageKey,
    ingredients: optionalString(b.ingredients, 'ingredients', 2000),
  };
}
