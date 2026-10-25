import { describe, it, expect } from 'vitest';
import { isValidUuid } from './idValidator.js';

describe('isValidUuid', () => {
  it('accepts a well-formed UUID', () => {
    expect(isValidUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
  });

  it('accepts uppercase hex digits', () => {
    expect(isValidUuid('11111111-1111-4111-8111-111111111111'.toUpperCase())).toBe(true);
  });

  it('rejects a GTIN (digits only, wrong shape)', () => {
    expect(isValidUuid('1234567890123')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isValidUuid(12345)).toBe(false);
    expect(isValidUuid(null)).toBe(false);
    expect(isValidUuid(undefined)).toBe(false);
  });

  it('rejects an overlong string', () => {
    expect(isValidUuid('1'.repeat(100))).toBe(false);
  });

  it('rejects a near-miss (wrong segment lengths)', () => {
    expect(isValidUuid('11111111-111-4111-8111-111111111111')).toBe(false);
  });
});
