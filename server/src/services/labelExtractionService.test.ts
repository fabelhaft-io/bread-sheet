import { describe, it, expect } from 'vitest';
import { extractFromText } from './labelExtractionService.js';

const ENGLISH_LABEL = `
Nutrition Information
Serving size: 30g

Per 100g
Energy     1234 kJ / 295 kcal
Fat        10.5 g
  of which saturates  3.2 g
Carbohydrates  45.2 g
  of which sugars     12.1 g
Protein    8.4 g
Salt       0.5 g

Ingredients: Wheat flour, sugar, palm oil, cocoa powder (4.5%), salt, raising agent (sodium bicarbonate), natural flavouring.

Allergens: Contains wheat, may contain milk.
`;

const GERMAN_LABEL = `
Nährwertangaben
Portionsgröße: 30 g

Pro 100 g
Brennwert   1275 kJ / 304 kcal
Fett        12,5 g
  davon gesättigte Fettsäuren   4,8 g
Kohlenhydrate   50,2 g
  davon Zucker   15,3 g
Eiweiß   6,2 g
Salz   0,8 g

Zutaten: Weizenmehl, Zucker, Palmöl, Kakaopulver (5%), Salz, Triebmittel (Natriumbicarbonat), natürliche Aromen.

Allergene: Enthält Weizen, kann Milch enthalten.
`;

describe('extractFromText', () => {
  describe('English label', () => {
    it('parses all macros including sub-values', () => {
      const result = extractFromText(ENGLISH_LABEL);
      expect(result.energyKcal).toBe(295);
      expect(result.fat).toBe(10.5);
      expect(result.saturatedFat).toBe(3.2);
      expect(result.carbohydrates).toBe(45.2);
      expect(result.sugars).toBe(12.1);
      expect(result.protein).toBe(8.4);
      expect(result.salt).toBe(0.5);
    });

    it('extracts serving size', () => {
      expect(extractFromText(ENGLISH_LABEL).servingSize).toBe('30g');
    });

    it('extracts ingredients up to the allergen section', () => {
      const result = extractFromText(ENGLISH_LABEL);
      expect(result.ingredients).toContain('Wheat flour');
      expect(result.ingredients).not.toContain('Allergens');
    });

    it('returns high confidence', () => {
      expect(extractFromText(ENGLISH_LABEL).confidence).toBe('high');
    });

    it('does not confuse "of which saturates" with total fat', () => {
      const result = extractFromText(ENGLISH_LABEL);
      expect(result.fat).toBe(10.5);        // not 3.2
      expect(result.saturatedFat).toBe(3.2); // sub-value extracted separately
    });

    it('does not confuse "of which sugars" with total carbohydrates', () => {
      const result = extractFromText(ENGLISH_LABEL);
      expect(result.carbohydrates).toBe(45.2); // not 12.1
      expect(result.sugars).toBe(12.1);         // sub-value extracted separately
    });

    it('always returns null for name, brand, genericName', () => {
      const result = extractFromText(ENGLISH_LABEL);
      expect(result.name).toBeNull();
      expect(result.brand).toBeNull();
      expect(result.genericName).toBeNull();
    });
  });

  describe('German label', () => {
    it('parses all macros including sub-values with comma as decimal separator', () => {
      const result = extractFromText(GERMAN_LABEL);
      expect(result.energyKcal).toBe(304);
      expect(result.fat).toBe(12.5);
      expect(result.saturatedFat).toBe(4.8);
      expect(result.carbohydrates).toBe(50.2);
      expect(result.sugars).toBe(15.3);
      expect(result.protein).toBe(6.2);
      expect(result.salt).toBe(0.8);
    });

    it('extracts serving size in German format', () => {
      expect(extractFromText(GERMAN_LABEL).servingSize).toBe('30 g');
    });

    it('extracts Zutaten as ingredients', () => {
      const result = extractFromText(GERMAN_LABEL);
      expect(result.ingredients).toContain('Weizenmehl');
      expect(result.ingredients).not.toContain('Allergene');
    });

    it('returns high confidence', () => {
      expect(extractFromText(GERMAN_LABEL).confidence).toBe('high');
    });

    it('does not confuse Fettsäuren row with total Fett', () => {
      const result = extractFromText(GERMAN_LABEL);
      expect(result.fat).toBe(12.5);            // not 4.8
      expect(result.saturatedFat).toBe(4.8);    // sub-value extracted separately
    });
  });

  describe('two-column OCR layout (label and value on separate lines)', () => {
    // OCR of a two-column nutrition table often puts each label on its own line
    // with the corresponding value on the immediately following line.
    const SPLIT_LINE_LABEL = `
Nährwertangaben pro 100 ml:
Brennwert
161 kJ / 38 kcal
Fett
0,02 g
davon gesättigte Fettsäuren
0,88 g
Kohlenhydrate
9,0 g
davon Zucker
8,0 g
Eiweiß
0,16 g
Salz
0,075 g
`;

    it('parses all macros including sub-values when label and value are on separate lines', () => {
      const result = extractFromText(SPLIT_LINE_LABEL);
      expect(result.energyKcal).toBe(38);
      expect(result.fat).toBe(0.02);
      expect(result.saturatedFat).toBe(0.88);
      expect(result.carbohydrates).toBe(9.0);
      expect(result.sugars).toBe(8.0);
      expect(result.protein).toBe(0.16);
      expect(result.salt).toBe(0.075);
    });

    it('does not match Fettsäuren as total fat when it appears on its own line', () => {
      const text = `Fett\n0,02 g\ndavon gesättigte Fettsäuren\n0,88 g\n`;
      expect(extractFromText(text).fat).toBe(0.02); // not 0.88
    });
  });

  describe('confidence levels', () => {
    it('returns medium when 3-4 fields match', () => {
      const text = `
Energy 200 kcal
Fat 5.0 g
Protein 10 g
`;
      const result = extractFromText(text);
      expect(result.confidence).toBe('medium');
    });

    it('returns low when 1-2 fields match', () => {
      const text = `
Protein 25 g
Nothing else of interest here
`;
      const result = extractFromText(text);
      expect(result.confidence).toBe('low');
      expect(result.protein).toBe(25);
      expect(result.energyKcal).toBeNull();
    });

    it('returns low with all-null when no patterns match', () => {
      const result = extractFromText('Random text with no nutritional information at all');
      expect(result.confidence).toBe('low');
      expect(result.energyKcal).toBeNull();
      expect(result.fat).toBeNull();
      expect(result.carbohydrates).toBeNull();
      expect(result.protein).toBeNull();
      expect(result.salt).toBeNull();
      expect(result.servingSize).toBeNull();
      expect(result.ingredients).toBeNull();
    });
  });

  describe('robustness', () => {
    it('never throws on empty input', () => {
      expect(() => extractFromText('')).not.toThrow();
    });

    it('never throws on very short input', () => {
      expect(() => extractFromText('abc')).not.toThrow();
    });

    it('returns all-null with confidence low on empty input', () => {
      const result = extractFromText('');
      expect(result.confidence).toBe('low');
      expect(result.energyKcal).toBeNull();
    });

    it('handles a label where energy is kcal-only (no kJ)', () => {
      const text = 'Energy 295 kcal\nFat 10 g\nProtein 8 g\nCarbohydrates 45 g';
      expect(extractFromText(text).energyKcal).toBe(295);
    });

    it('handles a label where energy has kJ before kcal', () => {
      const text = 'Energy 1234 kJ / 295 kcal\nFat 10 g';
      expect(extractFromText(text).energyKcal).toBe(295);
    });
  });

  // Regression guard for the polynomial-ReDoS fix (CodeQL js/polynomial-redos).
  // The German sub-nutrient patterns used to write the optional leading dash as
  // an optional `-` between two `[ \t]*` runs. Both runs match a space, so a
  // long line of spaces could be split between them in O(n) ways: parsing the
  // payload below took ~27 SECONDS of blocked event loop before the fix, from a
  // single request that passed every other guard.
  //
  // Timing in a test is normally a smell. Here the pre-fix and post-fix costs
  // differ by four orders of magnitude (~27 s vs ~5 ms), so a 2 s budget cannot
  // realistically flake while still failing loudly on any regression.
  describe('ReDoS resistance', () => {
    const REDOS_BUDGET_MS = 2_000;

    // 100k chars ~= a 100 KB JSON body, which is express.json()'s default cap —
    // i.e. the worst case the HTTP layer will actually hand to the parser.
    const spaces = (n: number) => ' '.repeat(n);

    it('parses a 100 KB whitespace payload in linear time', () => {
      // Must survive the controller's own `trim().length >= 50` guard to be a
      // faithful reproduction — a pure-whitespace body is rejected earlier.
      const payload = 'Zutaten: Wasser, Zucker, Salz, Weizenmehl, Hefe, Öl.\n' + spaces(100_000);

      const started = performance.now();
      extractFromText(payload);
      expect(performance.now() - started).toBeLessThan(REDOS_BUDGET_MS);
    });

    it('stays linear when the whitespace run follows a sub-nutrient keyword', () => {
      // Targets the vulnerable prefix head-on: line start, dash, spaces, keyword.
      for (const keyword of ['davon Zucker', 'davon gesättigte Fettsäuren']) {
        const payload = `-${spaces(50_000)}${keyword}${spaces(50_000)}`;
        const started = performance.now();
        extractFromText(payload);
        expect(performance.now() - started).toBeLessThan(REDOS_BUDGET_MS);
      }
    });

    it('still parses every dash/whitespace sub-nutrient spelling the fix touched', () => {
      // The rewrite must not narrow what the patterns accept.
      const variants = [
        'davon Zucker 8,0 g',
        '- davon Zucker 8,0 g',
        '  -  davon Zucker 8,0 g',
        '\t-\tZucker 8,0 g',
        '-davon Zucker 8,0 g',
        '   Zucker 8,0 g',
      ];
      for (const line of variants) {
        expect(extractFromText(line).sugars, line).toBe(8.0);
      }

      const satFatVariants = [
        'davon gesättigte Fettsäuren 0,88 g',
        '- davon gesättigte Fettsäuren 0,88 g',
        '  -  gesättigte Fettsäuren 0,88 g',
        '\t-\tdavon gesättigte Fettsäuren 0,88 g',
      ];
      for (const line of satFatVariants) {
        expect(extractFromText(line).saturatedFat, line).toBe(0.88);
      }
    });
  });
});