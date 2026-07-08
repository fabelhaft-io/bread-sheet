import type { ProductDetail, ProductEditChanges } from './types';

/**
 * Form logic for the Edit Product screen (TICKET-P5-006). Lives in
 * `features/products/` so the route file stays UI-only, mirroring the Add
 * Product flow conventions.
 */

/** Text-input state — one string per editable field (numbers as text). */
export interface EditFormValues {
  name: string;
  brand: string;
  genericName: string;
  energyKcal: string;
  fat: string;
  saturatedFat: string;
  carbohydrates: string;
  sugars: string;
  protein: string;
  salt: string;
  servingSize: string;
  ingredients: string;
}

export const EDIT_FORM_FIELDS = [
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
] as const;

export type EditFormField = (typeof EDIT_FORM_FIELDS)[number];

/** Human-readable labels, shared by the edit form and the reviewer diff screen. */
export const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  brand: 'Brand',
  genericName: 'Generic name',
  energyKcal: 'Energy (kcal/100 g)',
  fat: 'Fat (g)',
  saturatedFat: 'of which saturates (g)',
  carbohydrates: 'Carbohydrates (g)',
  sugars: 'of which sugars (g)',
  protein: 'Protein (g)',
  salt: 'Salt (g)',
  servingSize: 'Serving size',
  ingredients: 'Ingredients',
  image: 'Photo',
};

const NUMERIC_FIELDS = [
  'energyKcal',
  'fat',
  'saturatedFat',
  'carbohydrates',
  'sugars',
  'protein',
  'salt',
] as const;

function toText(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

export function parseNumeric(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Pre-populate the form from the current product values. */
export function productToFormValues(product: ProductDetail): EditFormValues {
  return {
    name: product.name ?? '',
    brand: product.brand ?? '',
    genericName: toText(product.genericName),
    energyKcal: toText(product.energyKcal),
    fat: toText(product.fat),
    saturatedFat: toText(product.saturatedFat),
    carbohydrates: toText(product.carbohydrates),
    sugars: toText(product.sugars),
    protein: toText(product.protein),
    salt: toText(product.salt),
    servingSize: toText(product.servingSize),
    ingredients: toText(product.ingredients),
  };
}

/** Per-field validation errors (numeric fields must parse when non-empty). */
export function validateFormValues(
  form: EditFormValues,
): Partial<Record<EditFormField, string>> {
  const errors: Partial<Record<EditFormField, string>> = {};
  if (!form.name.trim()) errors.name = 'Product name is required.';
  for (const field of NUMERIC_FIELDS) {
    if (form[field] !== '' && parseNumeric(form[field]) === null) {
      errors[field] = 'Must be a positive number.';
    }
  }
  return errors;
}

/** Typed value of one form field, ready for the wire. */
function typedValue(field: EditFormField, form: EditFormValues): string | number | null {
  if ((NUMERIC_FIELDS as readonly string[]).includes(field)) {
    return parseNumeric(form[field]);
  }
  const trimmed = form[field].trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Diff the edited form against the initial (pre-populated) form and return
 * only the changed fields as a wire payload. A replaced photo is carried as
 * `productImageKey`. Returns `null` when nothing changed — the submit button
 * is disabled in that case (spec: unchanged submits are blocked client-side).
 */
export function buildEditChanges(
  initial: EditFormValues,
  current: EditFormValues,
  newImageKey: string | null,
): ProductEditChanges | null {
  const changes: ProductEditChanges = {};

  for (const field of EDIT_FORM_FIELDS) {
    const before = typedValue(field, initial);
    const after = typedValue(field, current);
    if (before !== after) {
      if (field === 'name') {
        // `name` is required — an empty name never reaches here (validation).
        changes.name = String(after ?? '');
      } else {
        changes[field] = after as never;
      }
    }
  }
  if (newImageKey) changes.productImageKey = newImageKey;

  return Object.keys(changes).length === 0 ? null : changes;
}

/**
 * Full payload for the PENDING_REVIEW correction path (PATCH). All fields are
 * sent; `productImageKey` only when the photo was replaced.
 */
export function buildCorrectionPayload(
  form: EditFormValues,
  newImageKey: string | null,
) {
  return {
    name: form.name.trim(),
    brand: form.brand.trim() || null,
    genericName: form.genericName.trim() || null,
    energyKcal: parseNumeric(form.energyKcal),
    fat: parseNumeric(form.fat),
    saturatedFat: parseNumeric(form.saturatedFat),
    carbohydrates: parseNumeric(form.carbohydrates),
    sugars: parseNumeric(form.sugars),
    protein: parseNumeric(form.protein),
    salt: parseNumeric(form.salt),
    servingSize: form.servingSize.trim() || null,
    ingredients: form.ingredients.trim() || null,
    ...(newImageKey ? { productImageKey: newImageKey } : {}),
  };
}

/** True when the form differs from its initial values (or the photo changed). */
export function formHasChanges(
  initial: EditFormValues,
  current: EditFormValues,
  newImageKey: string | null,
): boolean {
  if (newImageKey) return true;
  return EDIT_FORM_FIELDS.some(
    (f) => typedValue(f, initial) !== typedValue(f, current),
  );
}
