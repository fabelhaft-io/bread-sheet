import type { ProductDetail, ProductEditChanges, ProductKind } from './types';

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

/**
 * Fields a given product kind may edit (TICKET-P6-007 / ADR 0006). A
 * `CUSTOM` product has no `PackagedProduct` row, so `name` and the photo
 * (`productImageKey`, handled separately by the caller) are the only
 * editable fields — a nutrition or allergen field in the payload is a `400`
 * server-side, and the client must not send one in the first place.
 * Defaults to `PACKAGED` so every existing call site keeps its old
 * behaviour without passing a `kind`.
 */
export function editableFieldsForKind(kind: ProductKind): readonly EditFormField[] {
  return kind === 'CUSTOM' ? (['name'] as const) : EDIT_FORM_FIELDS;
}

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

/**
 * Pre-populate the form from the current product values. Nutrition and
 * ingredient fields live under `product.packaged` (TICKET-P6-009); a `null`
 * `packaged` (a `CUSTOM` product) pre-fills those fields empty — this screen
 * is never reached for a `CUSTOM` product today (P6-007 is out of scope), but
 * the read is written defensively rather than assuming non-null.
 */
export function productToFormValues(product: ProductDetail): EditFormValues {
  const packaged = product.packaged;
  return {
    name: product.name ?? '',
    brand: product.brand ?? '',
    genericName: toText(packaged?.genericName),
    energyKcal: toText(packaged?.energyKcal),
    fat: toText(packaged?.fat),
    saturatedFat: toText(packaged?.saturatedFat),
    carbohydrates: toText(packaged?.carbohydrates),
    sugars: toText(packaged?.sugars),
    protein: toText(packaged?.protein),
    salt: toText(packaged?.salt),
    servingSize: toText(packaged?.servingSize),
    ingredients: toText(packaged?.ingredients),
  };
}

/**
 * Per-field validation errors (numeric fields must parse when non-empty).
 * `kind` restricts which fields are even considered — a `CUSTOM` product's
 * numeric fields are never rendered, so there is nothing to validate.
 */
export function validateFormValues(
  form: EditFormValues,
  kind: ProductKind = 'PACKAGED',
): Partial<Record<EditFormField, string>> {
  const errors: Partial<Record<EditFormField, string>> = {};
  if (!form.name.trim()) errors.name = 'Product name is required.';
  if (kind === 'CUSTOM') return errors;
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
 * `kind` restricts the diff to the fields that kind may edit — for `CUSTOM`
 * that is `name` only (ADR 0006), so a packaged-only field is never sent and
 * never risks the server's `400`.
 */
export function buildEditChanges(
  initial: EditFormValues,
  current: EditFormValues,
  newImageKey: string | null,
  kind: ProductKind = 'PACKAGED',
): ProductEditChanges | null {
  const changes: ProductEditChanges = {};

  for (const field of editableFieldsForKind(kind)) {
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
 * Full payload for the PENDING_REVIEW correction path (PATCH). For a
 * `PACKAGED` product every field is sent; for a `CUSTOM` product only `name`
 * (and the photo key, if replaced) — the packaged-only fields are omitted
 * entirely rather than sent as `null`, since the server 400s on their mere
 * presence in a `CUSTOM` payload (ADR 0006).
 */
export function buildCorrectionPayload(
  form: EditFormValues,
  newImageKey: string | null,
  kind: ProductKind = 'PACKAGED',
) {
  const photo = newImageKey ? { productImageKey: newImageKey } : {};
  if (kind === 'CUSTOM') {
    return { name: form.name.trim(), ...photo };
  }
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
    ...photo,
  };
}

/** True when the form differs from its initial values (or the photo changed). */
export function formHasChanges(
  initial: EditFormValues,
  current: EditFormValues,
  newImageKey: string | null,
  kind: ProductKind = 'PACKAGED',
): boolean {
  if (newImageKey) return true;
  return editableFieldsForKind(kind).some(
    (f) => typedValue(f, initial) !== typedValue(f, current),
  );
}
