import { Type } from '@google/genai';
import logger from '../logger.js';
import { getGeminiClient } from '../geminiClient.js';
import { withGeminiDeadline } from './geminiDeadline.js';
import { logGeminiUsage } from './geminiUsage.js';
import { reserveGeminiCall } from './geminiQuota.js';
import type { ImageKind } from './imageService.js';

const MODEL = 'gemini-3.5-flash';

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
      : kind === 'item'
        ? 'a real food or drink item a person could plausibly have consumed — e.g. a cocktail in a glass, a home-cooked dish, a cup of loose-leaf tea — photographed in good faith to show what it looked like'
        : "a packaged food or drink product's nutrition / ingredients label";

  const notAProductRule =
    kind === 'item'
      ? '"not_a_product" if it is clearly something unrelated to a consumable food or drink item (a person, a pet, scenery, a random object, a screenshot, etc.) — a cocktail, plated dish, or drink in a cup all count as the item itself and must pass.'
      : '"not_a_product" if it is clearly something unrelated to a packaged food/drink product (a person, a pet, scenery, a random object, a screenshot, etc.).';

  const suggestionRule =
    kind === 'product'
      ? `"name", "brand", "genericName": only when verdict is "ok", read the product's display name, brand, and generic category (e.g. "Oat drink") off the packaging. Ignore taglines, slogans, and marketing copy. Use null for anything you cannot read with confidence.`
      : kind === 'item'
        ? `"name": only when verdict is "ok" and a confident, specific name is obvious from the image (e.g. a well-known cocktail), suggest one short display name; otherwise null. "brand", "genericName": always null — a custom item has no brand or packaging-derived category.`
        : `"name", "brand", "genericName": always null for label images.`;

  return `You are a content gate for a food-rating app. A user uploaded an image that is supposed to show ${subject}.

Judge the image and return JSON matching the provided schema.

"verdict":
- "abuse" if the image contains sexual, pornographic, or graphic/violent content. This takes priority over everything else.
- "unusable" if it is too blurry, dark, cropped, or low-quality to tell what it shows.
- ${notAProductRule}
- "ok" otherwise.

"reason": one short factual sentence describing what you see (for internal logging).

${suggestionRule}`;
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
    name: kind === 'product' ? 'Mock Product' : kind === 'item' ? 'Mock Item' : null,
    brand: kind === 'product' ? 'Mock Brand' : null,
    genericName: null,
  };
}

async function checkGemini(
  buffer: Buffer,
  mimeType: string,
  kind: ImageKind,
): Promise<PlausibilityResult> {
  await reserveGeminiCall('plausibility');

  const client = getGeminiClient();
  const response = await withGeminiDeadline('plausibility', (abortSignal) =>
    client.models.generateContent({
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
        thinkingConfig: { thinkingBudget: 0 },
        abortSignal,
      },
    }),
  );

  logGeminiUsage('plausibility', response.usageMetadata);
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