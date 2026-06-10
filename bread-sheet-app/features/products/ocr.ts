/**
 * On-device OCR wrapper for the nutritional label photo.
 *
 * Uses `@react-native-ml-kit/text-recognition`, which binds to Google ML Kit
 * on Android and Apple's Vision framework on iOS. Both run locally — no
 * image leaves the device unless the caller explicitly invokes the image
 * fallback in `features/products/api.ts`.
 *
 * This module is resilient to the native module being unavailable: in that
 * case `recogniseLabelText` returns `null`, and the UI flow treats the OCR
 * result as insufficient and falls back to either the image-upload path or
 * manual entry. This keeps the module consumable from jest-expo (which does
 * not load native modules) without ceremony.
 */

type OcrResult = { text: string } | null;

export interface LabelOcrOutcome {
  /** Raw text returned by the OCR engine (joined across blocks). May be empty. */
  rawText: string;
  /** `true` when the native module was not available and nothing was run. */
  unavailable: boolean;
}

/**
 * Attempt to run on-device OCR against the image at `uri`. Returns a
 * structured outcome that the UI can branch on. Never throws — any loading
 * or recognition error is reported via `unavailable: true` so the caller can
 * fall back gracefully.
 */
export async function recogniseLabelText(uri: string): Promise<LabelOcrOutcome> {
  try {
    // Dynamic import so bundlers don't fail when the package is absent and
    // jest-expo tests don't need the native module.
    const mod = await importTextRecognition();
    if (!mod) return { rawText: '', unavailable: true };
    const result: OcrResult = await mod.recognize(uri);
    return { rawText: result?.text ?? '', unavailable: false };
  } catch {
    // If ML Kit throws for any reason (model download failed, empty image,
    // etc.) we silently fall back — the UI treats it the same as a short
    // extraction.
    return { rawText: '', unavailable: true };
  }
}

type TextRecognitionModule = {
  recognize: (uri: string) => Promise<OcrResult>;
};

async function importTextRecognition(): Promise<TextRecognitionModule | null> {
  try {
    // `@react-native-ml-kit/text-recognition` exports the recognizer as the
    // module's default export in recent versions; older releases used a
    // named export. Handle both.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-ml-kit/text-recognition');
    const candidate = (mod?.default ?? mod) as TextRecognitionModule | undefined;
    if (!candidate || typeof candidate.recognize !== 'function') return null;
    return candidate;
  } catch {
    return null;
  }
}
