import { describe, it, expect } from 'vitest';
import { validateProductEditChanges } from './productEditValidator.js';
import { SubmissionValidationError } from './productSubmissionValidator.js';

const VALID_KEY = 'processed/123e4567-e89b-42d3-a456-426614174000.jpg';

describe('validateProductEditChanges', () => {
  it('rejects a missing body', () => {
    expect(() => validateProductEditChanges(null)).toThrow(SubmissionValidationError);
  });

  it('rejects an empty object (no editable fields)', () => {
    expect(() => validateProductEditChanges({})).toThrow(SubmissionValidationError);
  });

  it('rejects unknown fields so typos do not silently drop a change', () => {
    expect(() => validateProductEditChanges({ nam: 'Bread' })).toThrow(
      /not an editable field/,
    );
  });

  it('rejects barcode changes (not an editable field)', () => {
    expect(() => validateProductEditChanges({ barcode: '4006381333931' })).toThrow(
      /not an editable field/,
    );
  });

  it('accepts a partial payload and returns only the provided fields', () => {
    const changes = validateProductEditChanges({ name: ' Bread ', salt: 1.5 });
    expect(changes).toEqual({ name: 'Bread', salt: 1.5 });
  });

  it('rejects an empty name (name is required when provided)', () => {
    expect(() => validateProductEditChanges({ name: '  ' })).toThrow(
      SubmissionValidationError,
    );
  });

  it('allows explicit nulls to clear optional fields', () => {
    const changes = validateProductEditChanges({ brand: null, sugars: null });
    expect(changes).toEqual({ brand: null, sugars: null });
  });

  it('rejects out-of-range numbers', () => {
    expect(() => validateProductEditChanges({ energyKcal: -1 })).toThrow(
      SubmissionValidationError,
    );
    expect(() => validateProductEditChanges({ energyKcal: 10001 })).toThrow(
      SubmissionValidationError,
    );
  });

  it('maps productImageKey to the image column after shape validation', () => {
    const changes = validateProductEditChanges({ productImageKey: VALID_KEY });
    expect(changes).toEqual({ image: VALID_KEY });
  });

  it('rejects a productImageKey that is not a server-issued upload key', () => {
    expect(() =>
      validateProductEditChanges({ productImageKey: 'https://evil.example/x.jpg' }),
    ).toThrow(/server-issued upload key/);
  });
});
