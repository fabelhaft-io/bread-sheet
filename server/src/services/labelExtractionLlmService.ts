import { Type } from '@google/genai';
import logger from '../logger.js';
import { getGeminiClient } from '../geminiClient.js';
import type { ExtractedLabel } from './labelExtractionService.js';

const MODEL = 'gemini-2.5-flash';

const PROMPT = `You are extracting structured nutrition information from a photo of a packaged food product label.

Return JSON matching the provided schema. Strict rules:
- Return null for any field you cannot read with high confidence. Never guess or infer.
- All numeric nutrition fields are per 100 g of solid product, or per 100 ml of liquid product. If the label only states per-serving values, return null for those numeric fields and put the serving descriptor in "servingSize".
- "energyKcal" is kilocalories (kcal). If only kJ is present, convert: kcal = round(kJ / 4.184).
- "carbohydrates", "fat", "protein", "salt" are grams as a plain number (no unit).
- "servingSize" is the literal serving descriptor (e.g. "30g", "100ml", "1 slice"), or null.
- "ingredients" is the ingredient list as printed (comma-separated, allergens included if listed), or null.
- "name" is the product's display name. "brand" is the brand name. "genericName" is the generic product category (e.g. "Pear-blackberry juice"). Use null if not visible.
- "confidence": "high" if every key nutrition field reads cleanly; "medium" if most do; "low" if the label is blurry, cropped, or the nutrition table is not visible.`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING, nullable: true },
    brand: { type: Type.STRING, nullable: true },
    genericName: { type: Type.STRING, nullable: true },
    energyKcal: { type: Type.NUMBER, nullable: true },
    carbohydrates: { type: Type.NUMBER, nullable: true },
    fat: { type: Type.NUMBER, nullable: true },
    protein: { type: Type.NUMBER, nullable: true },
    salt: { type: Type.NUMBER, nullable: true },
    servingSize: { type: Type.STRING, nullable: true },
    ingredients: { type: Type.STRING, nullable: true },
    confidence: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
  },
  required: [
    'name',
    'brand',
    'genericName',
    'energyKcal',
    'carbohydrates',
    'fat',
    'protein',
    'salt',
    'servingSize',
    'ingredients',
    'confidence',
  ],
};

export async function extractLabelWithLlm(
  buffer: Buffer,
  mimeType = 'image/jpeg',
): Promise<ExtractedLabel> {
  const client = getGeminiClient();
  const response = await client.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: buffer.toString('base64') } },
          { text: PROMPT },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });

  const raw = response.text ?? '';
  logger.debug('vision:llm raw response', { length: raw.length, text: raw });
  return JSON.parse(raw) as ExtractedLabel;
}
