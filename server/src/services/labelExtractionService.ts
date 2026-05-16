export interface ExtractedLabel {
  name: string | null;
  brand: string | null;
  genericName: string | null;
  energyKcal: number | null;
  carbohydrates: number | null;
  fat: number | null;
  protein: number | null;
  salt: number | null;
  servingSize: string | null;
  ingredients: string | null;
  confidence: 'low' | 'medium' | 'high';
}

// All patterns use the 'm' flag so '^' anchors to the start of each line.
// This prevents sub-entry rows ("of which saturates", "davon Zucker") from
// matching the parent-nutrient patterns.

const ENERGY_KCAL_PATTERNS: RegExp[] = [
  // "1234 kJ / 295 kcal": skip the kJ value explicitly so [^\d\n]* between
  // the two numbers stays mutually exclusive with \d+ (no backtracking).
  /^\s*(?:energy|energie|brennwert)[^\d\n]*\d+(?:[.,]\d+)?\s*k[Jj][^\d\n]*(\d+(?:[.,]\d+)?)\s*kcal/im,
  // "295 kcal" (kcal-only, no leading kJ value)
  /^\s*(?:energy|energie|brennwert)[^\d\n]*(\d+(?:[.,]\d+)?)\s*kcal/im,
];

const CARBS_PATTERNS: RegExp[] = [
  // [^\d\n]* is disjoint from \d+ so there is no ambiguous split to backtrack over.
  /^\s*(?:carbohydrates?|kohlenhydrate|glucides?)[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
];

const FAT_PATTERNS: RegExp[] = [
  /^\s*(?:total\s+)?fat\b[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
  /^\s*fett\b[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
  /^\s*matières?\s+grasses?\b[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
];

const PROTEIN_PATTERNS: RegExp[] = [
  /^\s*proteine?\b[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
  // 'ß' is not \w so \b doesn't apply — use a lookahead instead
  /^\s*eiweiß(?=\s|[:\-]|$)[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
  /^\s*protéines?\b[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
];

const SALT_PATTERNS: RegExp[] = [
  /^\s*salt\b[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
  /^\s*salz\b[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
  /^\s*sel\b[^\d\n]*(\d+(?:[.,]\d+)?)\s*g\b/im,
];

const SERVING_SIZE_PATTERNS: RegExp[] = [
  /(?:serving\s+size|portionsgröße|portion(?:ierung)?)\s*[:\-]?\s*(\d+(?:[.,]\d+)?\s*(?:g|ml|oz))/im,
];

function parseDecimal(s: string): number {
  return parseFloat(s.replace(',', '.'));
}

function matchNumber(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return parseDecimal(m[1]);
  }
  return null;
}

function matchString(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

function extractIngredients(text: string): string | null {
  const HEADER_RE = /^\s*(?:ingredients?|zutaten)\s*[:\-]?\s*/im;
  const match = HEADER_RE.exec(text);
  if (!match) return null;

  const rest = text.slice(match.index + match[0].length);

  const STOP_RE = /\n\s*\n|\n\s*(?:allergen|may contain|kann enthalten|nutritional|nährwert)/im;
  const stopMatch = STOP_RE.exec(rest);
  const raw = stopMatch ? rest.slice(0, stopMatch.index) : rest.slice(0, 500);

  const result = raw.replace(/\s+/g, ' ').trim();
  return result.length > 0 ? result.slice(0, 1000) : null;
}

export function extractFromText(rawText: string): ExtractedLabel {
  const energyKcal = matchNumber(rawText, ENERGY_KCAL_PATTERNS);
  const carbohydrates = matchNumber(rawText, CARBS_PATTERNS);
  const fat = matchNumber(rawText, FAT_PATTERNS);
  const protein = matchNumber(rawText, PROTEIN_PATTERNS);
  const salt = matchNumber(rawText, SALT_PATTERNS);
  const servingSize = matchString(rawText, SERVING_SIZE_PATTERNS);
  const ingredients = extractIngredients(rawText);

  const parsedCount = [energyKcal, carbohydrates, fat, protein, salt, servingSize, ingredients]
    .filter((v) => v !== null).length;

  const confidence: 'low' | 'medium' | 'high' =
    parsedCount >= 5 ? 'high' : parsedCount >= 3 ? 'medium' : 'low';

  return {
    name: null,
    brand: null,
    genericName: null,
    energyKcal,
    carbohydrates,
    fat,
    protein,
    salt,
    servingSize,
    ingredients,
    confidence,
  };
}