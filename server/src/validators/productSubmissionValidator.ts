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

  // Product image URL: must look like our S3 URL (cheap sanity check; tighten later)
  const productImageUrl = requireString(
    b.productImageUrl,
    'productImageUrl',
    1024,
  );
  if (!productImageUrl.includes('/submissions/')) {
    throw new SubmissionValidationError(
      'productImageUrl',
      'productImageUrl must be a server-issued upload URL',
    );
  }

  return {
    barcode,
    name: requireString(b.name, 'name'),
    brand: optionalString(b.brand, 'brand'),
    genericName: optionalString(b.genericName, 'genericName'),
    energyKcal: optionalNumber(b.energyKcal, 'energyKcal'),
    carbohydrates: optionalNumber(b.carbohydrates, 'carbohydrates'),
    fat: optionalNumber(b.fat, 'fat'),
    protein: optionalNumber(b.protein, 'protein'),
    salt: optionalNumber(b.salt, 'salt'),
    servingSize: optionalString(b.servingSize, 'servingSize', 100),
    productImageUrl,
    ingredients: optionalString(b.ingredients, 'ingredients', 2000),
  };
}
