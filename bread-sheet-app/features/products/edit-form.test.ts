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
  barcode: '0000000000001',
  name: 'Sourdough Loaf',
  brand: 'Artisan',
  image: null,
  description: null,
  status: 'VERIFIED',
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
