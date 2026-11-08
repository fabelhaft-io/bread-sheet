import {
  buildCorrectionPayload,
  buildEditChanges,
  formHasChanges,
  productToFormValues,
  validateFormValues,
  type EditFormValues,
} from './edit-form';
import type { ProductDetail } from './types';

const PRODUCT: ProductDetail = {
  id: 'p1',
  kind: 'PACKAGED',
  name: 'Sourdough Loaf',
  brand: 'Artisan',
  image: null,
  description: null,
  status: 'VERIFIED',
  packaged: {
    gtin: '0000000000001',
    genericName: 'Bread',
    energyKcal: 250,
    fat: 3.5,
    saturatedFat: null,
    carbohydrates: 45,
    sugars: 0,
    protein: 8,
    salt: 1.2,
    servingSize: '50g',
    ingredients: 'Flour, water, salt',
  },
};

const initial = productToFormValues(PRODUCT);

function withChanges(overrides: Partial<EditFormValues>): EditFormValues {
  return { ...initial, ...overrides };
}

describe('productToFormValues', () => {
  it('stringifies numbers and maps nulls to empty strings', () => {
    expect(initial.energyKcal).toBe('250');
    expect(initial.saturatedFat).toBe('');
    // 0 is data, not "missing" — zero-sugar products keep their zero.
    expect(initial.sugars).toBe('0');
  });
});

describe('buildEditChanges', () => {
  it('returns null when nothing changed', () => {
    expect(buildEditChanges(initial, { ...initial }, null)).toBeNull();
    expect(formHasChanges(initial, { ...initial }, null)).toBe(false);
  });

  it('treats formatting-only differences as unchanged (numeric compare, trim)', () => {
    const current = withChanges({ energyKcal: '250.0', brand: ' Artisan ' });
    expect(buildEditChanges(initial, current, null)).toBeNull();
  });

  it('includes only the fields that actually changed', () => {
    const current = withChanges({ name: 'Sourdough Boule', salt: '1.5' });
    expect(buildEditChanges(initial, current, null)).toEqual({
      name: 'Sourdough Boule',
      salt: 1.5,
    });
  });

  it('emits an explicit null when a field is cleared', () => {
    const current = withChanges({ servingSize: '' });
    expect(buildEditChanges(initial, current, null)).toEqual({ servingSize: null });
  });

  it('carries a replaced photo as productImageKey', () => {
    const key = 'processed/123e4567-e89b-42d3-a456-426614174000.jpg';
    expect(buildEditChanges(initial, { ...initial }, key)).toEqual({
      productImageKey: key,
    });
    expect(formHasChanges(initial, { ...initial }, key)).toBe(true);
  });
});

describe('validateFormValues', () => {
  it('requires a name', () => {
    expect(validateFormValues(withChanges({ name: ' ' })).name).toBeTruthy();
  });

  it('rejects non-numeric nutrition values', () => {
    const errors = validateFormValues(withChanges({ fat: 'lots' }));
    expect(errors.fat).toBeTruthy();
  });

  it('accepts comma decimals', () => {
    expect(validateFormValues(withChanges({ fat: '3,5' }))).toEqual({});
  });
});

describe('buildCorrectionPayload', () => {
  it('sends the full payload with typed values and no image key by default', () => {
    const payload = buildCorrectionPayload(initial, null);
    expect(payload).toMatchObject({
      name: 'Sourdough Loaf',
      energyKcal: 250,
      saturatedFat: null,
      sugars: 0,
    });
    expect('productImageKey' in payload).toBe(false);
  });

  it('attaches the image key when the photo was replaced', () => {
    const key = 'processed/123e4567-e89b-42d3-a456-426614174000.jpg';
    expect(buildCorrectionPayload(initial, key).productImageKey).toBe(key);
  });
});

// ─── CUSTOM products (TICKET-P6-007 / ADR 0006) ─────────────────────────────
// Only `name` (and the photo) are editable — a packaged-only field must never
// appear in the payload, even as an explicit `null`, since the server 400s on
// its mere presence.

const CUSTOM_PRODUCT: ProductDetail = {
  id: 'c1',
  kind: 'CUSTOM',
  name: 'Negroni',
  brand: null,
  image: null,
  description: null,
  status: 'PENDING_REVIEW',
  packaged: null,
};

const customInitial = productToFormValues(CUSTOM_PRODUCT);

describe('CUSTOM products', () => {
  it('only diffs the name field', () => {
    const current = { ...customInitial, name: 'Negroni Sbagliato', fat: '999' };
    expect(buildEditChanges(customInitial, current, null, 'CUSTOM')).toEqual({
      name: 'Negroni Sbagliato',
    });
  });

  it('builds a correction payload with only name (and photo), never packaged-only fields', () => {
    const payload = buildCorrectionPayload(
      { ...customInitial, name: 'Negroni Fixed' },
      null,
      'CUSTOM',
    );
    expect(payload).toEqual({ name: 'Negroni Fixed' });
    expect('brand' in payload).toBe(false);
    expect('energyKcal' in payload).toBe(false);
  });

  it('attaches the photo key when replaced, still with no packaged fields', () => {
    const key = 'processed/123e4567-e89b-42d3-a456-426614174000.jpg';
    const payload = buildCorrectionPayload(customInitial, key, 'CUSTOM');
    expect(payload).toEqual({ name: 'Negroni', productImageKey: key });
  });

  it('ignores a (hypothetical) change to a packaged-only field when computing hasChanges', () => {
    const current = { ...customInitial, fat: '999' };
    expect(formHasChanges(customInitial, current, null, 'CUSTOM')).toBe(false);
  });

  it('reports a change when the name differs', () => {
    const current = { ...customInitial, name: 'Negroni Sbagliato' };
    expect(formHasChanges(customInitial, current, null, 'CUSTOM')).toBe(true);
  });

  it('never raises numeric field errors for a CUSTOM product', () => {
    expect(validateFormValues({ ...customInitial, fat: 'lots' }, 'CUSTOM')).toEqual({});
  });

  it('still requires a name for a CUSTOM product', () => {
    expect(validateFormValues({ ...customInitial, name: ' ' }, 'CUSTOM').name).toBeTruthy();
  });
});
