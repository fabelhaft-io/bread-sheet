import type { EditChanges } from '../services/productEditService.js';
import {
  PRODUCT_IMAGE_KEY_RE,
  SubmissionValidationError,
  optionalNumber,
  optionalString,
  requireString,
} from './productSubmissionValidator.js';

/**
 * Validates the partial payload of POST /products/:barcode/edits (TICKET-P5-006).
 * Only provided fields are validated; each follows the same rules as the full
 * submission validator. `productImageKey` (client wire name) is mapped to the
 * `image` product column. Unknown fields are rejected so typos don't silently
 * drop a proposed change.
 */
export function validateProductEditChanges(body: unknown): EditChanges {
  if (!body || typeof body !== 'object') {
    throw new SubmissionValidationError('body', 'Request body required');
  }
  const b = body as Record<string, unknown>;

  const KNOWN = new Set([
    'name',
    'brand',
    'genericName',
    'energyKcal',
    'fat',
    'saturatedFat',
    'carbohydrates',
    'sugars',
    'protein',
    'salt',
    'servingSize',
    'ingredients',
    'productImageKey',
  ]);
  for (const key of Object.keys(b)) {
    if (!KNOWN.has(key)) {
      throw new SubmissionValidationError(key, `${key} is not an editable field`);
    }
  }

  const changes: EditChanges = {};

  if ('name' in b) changes.name = requireString(b.name, 'name');
  if ('brand' in b) changes.brand = optionalString(b.brand, 'brand');
  if ('genericName' in b) changes.genericName = optionalString(b.genericName, 'genericName');
  if ('energyKcal' in b) changes.energyKcal = optionalNumber(b.energyKcal, 'energyKcal');
  if ('fat' in b) changes.fat = optionalNumber(b.fat, 'fat');
  if ('saturatedFat' in b) changes.saturatedFat = optionalNumber(b.saturatedFat, 'saturatedFat');
  if ('carbohydrates' in b) changes.carbohydrates = optionalNumber(b.carbohydrates, 'carbohydrates');
  if ('sugars' in b) changes.sugars = optionalNumber(b.sugars, 'sugars');
  if ('protein' in b) changes.protein = optionalNumber(b.protein, 'protein');
  if ('salt' in b) changes.salt = optionalNumber(b.salt, 'salt');
  if ('servingSize' in b) changes.servingSize = optionalString(b.servingSize, 'servingSize', 100);
  if ('ingredients' in b) changes.ingredients = optionalString(b.ingredients, 'ingredients', 2000);

  if ('productImageKey' in b) {
    const key = requireString(b.productImageKey, 'productImageKey', 1024);
    if (!PRODUCT_IMAGE_KEY_RE.test(key)) {
      throw new SubmissionValidationError(
        'productImageKey',
        'productImageKey must be a server-issued upload key',
      );
    }
    changes.image = key;
  }

  if (Object.keys(changes).length === 0) {
    throw new SubmissionValidationError('body', 'No editable fields provided');
  }

  return changes;
}
