/**
 * Client-side barcode validation for manual entry (TICKET-P6-006).
 *
 * The pattern mirrors `BARCODE_RE` in `server/src/controllers/productController.ts`
 * exactly — the client must not accept a code the server will reject with a bare
 * `400 Invalid barcode format`, which is the raw error P6-006 exists to remove.
 * Keep the two in sync; a divergence is only ever visible as a server error the
 * user cannot act on.
 */

/** Same expression the server validates against: 8–13 digits, nothing else. */
export const BARCODE_RE = /^\d{8,13}$/;

export const BARCODE_MIN_DIGITS = 8;
export const BARCODE_MAX_DIGITS = 13;

/**
 * Why an input was rejected. The ticket asks for *distinguishable* errors —
 * "that's not long enough" and "that isn't a digit" are different mistakes and
 * a single "invalid barcode" tells the user nothing about which one they made.
 */
export type BarcodeErrorReason = 'empty' | 'non-digit' | 'too-short' | 'too-long';

export type BarcodeValidation =
  | { valid: true; barcode: string }
  | { valid: false; reason: BarcodeErrorReason; message: string };

/**
 * Keeps only digits, capped at the maximum length. Used to *seed* the manual
 * sheet from something that is not user input — a scanned CODE-128 payload, a
 * route parameter the server rejected — where the digits are the salvageable
 * part and the rest is noise.
 */
export function sanitizeBarcodeInput(input: string): string {
  return input.replace(/\D/g, '').slice(0, BARCODE_MAX_DIGITS);
}

/**
 * Removes the separators a code is *written* with — spaces, dashes, slashes,
 * dots — and nothing else. This is what the field applies as the user types.
 *
 * Letters are deliberately left in so `validateBarcode` can report them as a
 * non-digit error: a pasted `4006381X33931` is a misread the user needs to see,
 * whereas silently deleting the `X` would look like their code was accepted and
 * then fail as a not-found somewhere else.
 */
export function stripBarcodeSeparators(input: string): string {
  return input.replace(/[\s\-/.]/g, '');
}

/**
 * Validates raw user input. Whitespace around the code is trimmed — everything
 * else is reported rather than silently repaired, because a code containing a
 * letter is more likely a misread than a formatting quirk.
 */
export function validateBarcode(input: string): BarcodeValidation {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { valid: false, reason: 'empty', message: 'Enter the barcode number.' };
  }

  if (!/^\d+$/.test(trimmed)) {
    return {
      valid: false,
      reason: 'non-digit',
      message: 'Barcodes are digits only — remove any letters, spaces or dashes.',
    };
  }

  if (trimmed.length < BARCODE_MIN_DIGITS) {
    return {
      valid: false,
      reason: 'too-short',
      message: `Too short — barcodes have ${BARCODE_MIN_DIGITS}–${BARCODE_MAX_DIGITS} digits, this has ${trimmed.length}.`,
    };
  }

  if (trimmed.length > BARCODE_MAX_DIGITS) {
    return {
      valid: false,
      reason: 'too-long',
      message: `Too long — barcodes have ${BARCODE_MIN_DIGITS}–${BARCODE_MAX_DIGITS} digits, this has ${trimmed.length}.`,
    };
  }

  return { valid: true, barcode: trimmed };
}

/** Convenience predicate for callsites that only need the yes/no answer. */
export function isValidBarcode(input: string): boolean {
  return validateBarcode(input).valid;
}
