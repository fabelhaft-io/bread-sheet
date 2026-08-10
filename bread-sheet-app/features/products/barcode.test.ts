import {
  BARCODE_RE,
  isValidBarcode,
  sanitizeBarcodeInput,
  stripBarcodeSeparators,
  validateBarcode,
} from './barcode';

/**
 * TICKET-P6-006: manual barcode entry validates client-side against the same
 * expression the server uses, and reports length and non-digit problems as
 * distinguishable errors.
 */

describe('validateBarcode', () => {
  it('accepts codes of 8 to 13 digits', () => {
    for (const code of ['12345678', '1234567890', '4006381333931']) {
      expect(validateBarcode(code)).toEqual({ valid: true, barcode: code });
    }
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateBarcode('  4006381333931 ')).toEqual({
      valid: true,
      barcode: '4006381333931',
    });
  });

  it('distinguishes empty, non-digit, too-short and too-long input', () => {
    expect(validateBarcode('')).toMatchObject({ valid: false, reason: 'empty' });
    expect(validateBarcode('   ')).toMatchObject({ valid: false, reason: 'empty' });
    expect(validateBarcode('40063813A3931')).toMatchObject({
      valid: false,
      reason: 'non-digit',
    });
    expect(validateBarcode('1234567')).toMatchObject({ valid: false, reason: 'too-short' });
    expect(validateBarcode('12345678901234')).toMatchObject({
      valid: false,
      reason: 'too-long',
    });
  });

  it('names the digit count in the length errors', () => {
    const short = validateBarcode('1234567');
    expect(short.valid).toBe(false);
    if (!short.valid) expect(short.message).toContain('this has 7');

    const long = validateBarcode('12345678901234');
    expect(long.valid).toBe(false);
    if (!long.valid) expect(long.message).toContain('this has 14');
  });

  it('treats a code with a separator as non-digit rather than stripping it', () => {
    // Deliberate: a dash could equally be a misread digit, so we ask rather
    // than guess. `sanitizeBarcodeInput` is the repair path, applied on typing.
    expect(validateBarcode('4006381-333931')).toMatchObject({
      valid: false,
      reason: 'non-digit',
    });
  });

  it('agrees with the raw expression the server uses', () => {
    const samples = ['12345678', '1234567', '4006381333931', '12345678901234', 'abcdefgh', ''];
    for (const sample of samples) {
      expect(isValidBarcode(sample)).toBe(BARCODE_RE.test(sample));
    }
  });
});

describe('sanitizeBarcodeInput', () => {
  it('keeps digits only', () => {
    expect(sanitizeBarcodeInput('4006 381-333/931')).toBe('4006381333931');
  });

  it('salvages the digits of an alphanumeric scan payload', () => {
    // A CODE-128 label the camera can now read but the API cannot look up.
    expect(sanitizeBarcodeInput('LOT-4006381333931-B')).toBe('4006381333931');
  });

  it('caps the input at the maximum barcode length', () => {
    expect(sanitizeBarcodeInput('123456789012345678')).toBe('1234567890123');
  });
});

describe('stripBarcodeSeparators', () => {
  it('removes the separators a code is written with', () => {
    expect(stripBarcodeSeparators('4006 381-333/931')).toBe('4006381333931');
  });

  it('keeps letters so they can be reported as a non-digit error', () => {
    // Deleting the stray character would look like acceptance and fail later.
    expect(stripBarcodeSeparators('40063813A3931')).toBe('40063813A3931');
    expect(validateBarcode(stripBarcodeSeparators('40063813A3931'))).toMatchObject({
      reason: 'non-digit',
    });
  });
});
