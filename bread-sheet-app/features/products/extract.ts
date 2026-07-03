import { log } from '@/lib/log';
import { supabase } from '@/lib/supabase';

import { extractLabelFromImage, extractLabelFromText } from './api';
import { MIN_OCR_LENGTH } from './constants';
import { recogniseLabelText } from './ocr';
import type { ExtractedLabel } from './types';

/**
 * Orchestrates the three-tier extraction described in TICKET-P5-002:
 *
 *  1. Run on-device OCR against the label image.
 *  2. If the text is ≥ `MIN_OCR_LENGTH` chars, ship only the text to
 *     `POST /products/extract-label` — saves a potentially large image
 *     upload and keeps the nutrition label off the wire when possible.
 *  3. If on-device OCR yielded too little (bad lighting, blurry, etc.),
 *     fall back to the image-upload path so the backend can run Claude
 *     vision inference.
 *
 * Every branch is wrapped in try/catch so a network or OCR failure simply
 * returns `null` — the review step treats that as "fall back to manual
 * entry", never as a hard error.
 */
export type ExtractionOutcome =
  | { kind: 'ok'; data: ExtractedLabel; path: 'text' | 'image' }
  | { kind: 'skipped'; reason: 'no_text' | 'ocr_unavailable' | 'backend_error' };

export async function extractFromLabelImage(imageUri: string): Promise<ExtractionOutcome> {
  const ocr = await recogniseLabelText(imageUri);

  const trimmedLen = ocr.rawText.trim().length;
  // Dev-only: dumps raw recognised label text, which is user-supplied content —
  // must never reach production device logs (hence log.debug, gated on __DEV__).
  log.debug(
    `[extract] on-device OCR — unavailable=${ocr.unavailable} length=${trimmedLen} threshold=${MIN_OCR_LENGTH} path=${
      !ocr.unavailable && trimmedLen >= MIN_OCR_LENGTH ? 'text' : 'image-fallback'
    }\n--- rawText ---\n${ocr.rawText.slice(0, 1000)}\n--- end rawText ---`,
  );

  if (!ocr.unavailable && ocr.rawText.trim().length >= MIN_OCR_LENGTH) {
    try {
      const data = await extractLabelFromText(ocr.rawText);
      return { kind: 'ok', data, path: 'text' };
    } catch {
      // Fall through to image path — maybe the text path errored server-side
      // but vision still succeeds.
    }
  }

  // Image fallback (OCR short, OCR unavailable, or the text path errored).
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const authHeader = session ? `Bearer ${session.access_token}` : null;
    const data = await extractLabelFromImage(imageUri, authHeader);
    return { kind: 'ok', data, path: 'image' };
  } catch {
    const reason = ocr.unavailable
      ? 'ocr_unavailable'
      : ocr.rawText.trim().length === 0
        ? 'no_text'
        : 'backend_error';
    return { kind: 'skipped', reason };
  }
}
