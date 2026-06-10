/**
 * Constants shared between the Add Product flow and (eventually) the backend
 * extraction endpoint. Per TICKET-P5-002, these values MUST match on both
 * sides — exported as module-level consts so a grep for `MIN_OCR_LENGTH`
 * surfaces every callsite at once.
 */

/**
 * Minimum number of characters returned by on-device OCR for the client to
 * treat the extraction as "good enough" to ship as plain text. Below this
 * threshold the Add Product flow falls back to uploading the label image so
 * the backend can run vision inference.
 */
export const MIN_OCR_LENGTH = 50;

/**
 * Longest-edge cap (pixels) applied client-side to the product display photo
 * before upload. Keeps payloads small; the Lambda re-runs the definitive
 * resize server-side.
 */
export const MAX_PRODUCT_IMAGE_LONGEST_EDGE = 1200;

/**
 * Longest-edge cap (pixels) for the label photo when it is used as the OCR
 * fallback. Higher than the product-photo cap because OCR accuracy benefits
 * from the extra detail.
 */
export const MAX_LABEL_IMAGE_LONGEST_EDGE = 1600;

/**
 * Hard client-side size limit after compression. Anything larger gets an
 * inline error and is not uploaded — the server enforces its own 4 MB cap
 * (see P5-003) as defence-in-depth.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * JPEG quality settings used by `expo-image-manipulator`. Lower for the
 * display photo (it is re-shown in feeds, 85% is visually lossless), higher
 * for the label (preserves legibility for OCR).
 */
export const PRODUCT_IMAGE_JPEG_QUALITY = 0.85;
export const LABEL_IMAGE_JPEG_QUALITY = 0.9;
