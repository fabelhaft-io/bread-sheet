import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGenerateContent = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models: { generateContent: typeof mockGenerateContent };
    constructor(_opts: unknown) {
      this.models = { generateContent: mockGenerateContent };
    }
  }
  return {
    GoogleGenAI,
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER' },
  };
});

const OK_RESPONSE = {
  verdict: 'ok' as const,
  reason: 'A carton of oat drink, front of pack.',
  name: 'Oat Drink',
  brand: 'Alpro',
  genericName: 'Oat drink',
};

describe('imagePlausibilityService', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    vi.resetModules();
    delete process.env.PLAUSIBILITY_MODE;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    delete process.env.PLAUSIBILITY_MODE;
    delete process.env.GEMINI_API_KEY;
  });

  describe('getPlausibilityMode', () => {
    it('throws when PLAUSIBILITY_MODE is missing', async () => {
      const { getPlausibilityMode } = await import('./imagePlausibilityService.js');
      expect(() => getPlausibilityMode()).toThrow(/PLAUSIBILITY_MODE/);
    });

    it('throws on an invalid value', async () => {
      process.env.PLAUSIBILITY_MODE = 'banana';
      const { getPlausibilityMode } = await import('./imagePlausibilityService.js');
      expect(() => getPlausibilityMode()).toThrow(/Invalid PLAUSIBILITY_MODE/);
    });
  });

  describe('mock mode', () => {
    beforeEach(() => {
      process.env.PLAUSIBILITY_MODE = 'mock';
    });

    it('returns ok with stub suggestions for product photos', async () => {
      const { checkImage } = await import('./imagePlausibilityService.js');
      const result = await checkImage(Buffer.from('x'), 'image/jpeg', 'product');

      expect(result.verdict).toBe('ok');
      expect(result.name).toBeTruthy();
      expect(result.brand).toBeTruthy();
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('returns ok with null suggestions for label photos', async () => {
      const { checkImage } = await import('./imagePlausibilityService.js');
      const result = await checkImage(Buffer.from('x'), 'image/jpeg', 'label');

      expect(result.verdict).toBe('ok');
      expect(result.name).toBeNull();
      expect(result.brand).toBeNull();
    });
  });

  describe('gemini mode', () => {
    beforeEach(() => {
      process.env.PLAUSIBILITY_MODE = 'gemini';
      process.env.GEMINI_API_KEY = 'test-key';
    });

    it('sends the image + a product-specific prompt and returns parsed JSON', async () => {
      mockGenerateContent.mockResolvedValue({ text: JSON.stringify(OK_RESPONSE) });
      const { checkImage } = await import('./imagePlausibilityService.js');
      const buffer = Buffer.from('fake-image-bytes');

      const result = await checkImage(buffer, 'image/jpeg', 'product');

      expect(result).toEqual(OK_RESPONSE);
      const call = mockGenerateContent.mock.calls[0][0];
      expect(call.model).toBe('gemini-2.5-flash');
      expect(call.config.responseMimeType).toBe('application/json');
      expect(call.contents[0].parts[0].inlineData).toEqual({
        mimeType: 'image/jpeg',
        data: buffer.toString('base64'),
      });
      expect(call.contents[0].parts[1].text).toMatch(/front-of-pack/i);
    });

    it('uses a label-specific prompt for label images', async () => {
      mockGenerateContent.mockResolvedValue({ text: JSON.stringify(OK_RESPONSE) });
      const { checkImage } = await import('./imagePlausibilityService.js');

      await checkImage(Buffer.from('x'), 'image/jpeg', 'label');

      const call = mockGenerateContent.mock.calls[0][0];
      expect(call.contents[0].parts[1].text).toMatch(/label/i);
    });

    it('returns the abuse verdict with the model reason', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          verdict: 'abuse',
          reason: 'explicit content',
          name: null,
          brand: null,
          genericName: null,
        }),
      });
      const { checkImage } = await import('./imagePlausibilityService.js');

      const result = await checkImage(Buffer.from('x'), 'image/jpeg', 'product');

      expect(result.verdict).toBe('abuse');
      expect(result.reason).toBe('explicit content');
    });

    it('throws when GEMINI_API_KEY is missing', async () => {
      delete process.env.GEMINI_API_KEY;
      const { checkImage } = await import('./imagePlausibilityService.js');

      await expect(checkImage(Buffer.from('x'), 'image/jpeg', 'product')).rejects.toThrow(
        /GEMINI_API_KEY/,
      );
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
  });
});
