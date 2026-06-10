import { Type } from '@google/genai';
import logger from '../logger.js';
import { getGeminiClient } from '../geminiClient.js';
import type { ImageKind } from './imageService.js';

const MODEL = 'gemini-2.5-flash';

export const VALID_PLAUSIBILITY_MODES = ['mock', 'gemini'] as const;
export type PlausibilityMode = (typeof VALID_PLAUSIBILITY_MODES)[number];

export function getPlausibilityMode(): PlausibilityMode {
  const m = process.env.PLAUSIBILITY_MODE;
  if (!m) {
    throw new Error(
      'Missing required environment variable: PLAUSIBILITY_MODE. Valid values: mock | gemini',
    );
  }
  if (!VALID_PLAUSIBILITY_MODES.includes(m as PlausibilityMode)) {
    throw new Error(
      `Invalid PLAUSIBILITY_MODE "${m}". Must be one of: ${VALID_PLAUSIBILITY_MODES.join(' | ')}`,
    );
  }
  return m as PlausibilityMode;
}

export type Verdict = 'ok' | 'not_a_product' | 'unusable' | 'abuse';

export interface PlausibilityResult {
  verdict: Verdict;
  // Model-provided detail. Used server-side for logging and (on `abuse`) the
  // moderation record — never forwarded verbatim to the client.
  reason: string;
  // Front-of-pack suggestions. Only meaningful for `kind === 'product'`; the
  // model returns null for label images.
  name: string | null;
  brand: string | null;
  genericName: string | null;
}

function buildPrompt(kind: ImageKind): string {
  const subject =
    kind === 'product'
      ? 'the front-of-pack of a packaged food or drink product (the shot used in listings)'
      : "a packaged food or drink product's nutrition / ingredients label";

  return `You are a content gate for a food-rating app. A user uploaded an image that is supposed to show ${subject}.

Judge the image and return JSON matching the provided schema.

"verdict":
- "abuse" if the image contains sexual, pornographic, or graphic/violent content. This takes priority over everything else.
- "unusable" if it is too blurry, dark, cropped, or low-quality to tell what it shows.
- "not_a_product" if it is clearly something unrelated to a packaged food/drink product (a person, a pet, scenery, a random object, a screenshot, etc.).
- "ok" otherwise.

"reason": one short factual sentence describing what you see (for internal logging).

${
  kind === 'product'
    ? `"name", "brand", "genericName": only when verdict is "ok", read the product's display name, brand, and generic category (e.g. "Oat drink") off the packaging. Ignore taglines, slogans, and marketing copy. Use null for anything you cannot read with confidence.`
    : `"name", "brand", "genericName": always null for label images.`
}`;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ['ok', 'not_a_product', 'unusable', 'abuse'] },
    reason: { type: Type.STRING },
    name: { type: Type.STRING, nullable: true },
    brand: { type: Type.STRING, nullable: true },
    genericName: { type: Type.STRING, nullable: true },
  },
  required: ['verdict', 'reason', 'name', 'brand', 'genericName'],
};

// Fixed verdict returned in mock mode regardless of image content, so the test
// suite and local dev work without a Gemini API key. Tests that need to exercise
// rejection paths mock this module directly.
function checkMock(kind: ImageKind): PlausibilityResult {
  return {
    verdict: 'ok',
    reason: 'mock mode — image accepted without inspection',
    name: kind === 'product' ? 'Mock Product' : null,
    brand: kind === 'product' ? 'Mock Brand' : null,
    genericName: null,
  };
}

async function checkGemini(
  buffer: Buffer,
  mimeType: string,
  kind: ImageKind,
): Promise<PlausibilityResult> {
  const client = getGeminiClient();
  const response = await client.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: buffer.toString('base64') } },
          { text: buildPrompt(kind) },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });

  const raw = response.text ?? '';
  logger.debug('plausibility:gemini raw response', { kind, length: raw.length, text: raw });
  return JSON.parse(raw) as PlausibilityResult;
}

/**
 * Judge whether an uploaded image plausibly shows what the slot expects, and —
 * for product photos — read front-of-pack name/brand suggestions in the same
 * call. Both image kinds are gated for abusive content.
 */
export async function checkImage(
  buffer: Buffer,
  mimeType: string,
  kind: ImageKind,
): Promise<PlausibilityResult> {
  switch (getPlausibilityMode()) {
    case 'gemini':
      return checkGemini(buffer, mimeType, kind);
    default:
      return checkMock(kind);
  }
}