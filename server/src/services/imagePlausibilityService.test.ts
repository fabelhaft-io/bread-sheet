import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGenerateContent = vi.hoisted(() => vi.fn());
const mockReserveGeminiCall = vi.hoisted(() => vi.fn());

class FakeGeminiDailyQuotaExhaustedError extends Error {
  readonly status = 503;
  readonly code = 'daily_quota_exhausted';
  constructor(readonly cap: number) {
    super(`Gemini daily call cap (${cap}) reached`);
  }
}

vi.mock('./geminiQuota.js', () => ({
  reserveGeminiCall: mockReserveGeminiCall,
  GeminiDailyQuotaExhaustedError: FakeGeminiDailyQuotaExhaustedError,
}));

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
  category: 'dairy',
};

describe('imagePlausibilityService', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockReserveGeminiCall.mockReset();
    mockReserveGeminiCall.mockResolvedValue(undefined);
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
      expect(result.category).toBeNull();
    });

    // TICKET-P6-003: mock mode exercises the category field too, so the
    // "validate against the seed list" behaviour downstream has something to
    // persist without needing a live Gemini key.
    it('returns a valid seed slug as category for product photos', async () => {
      const { checkImage } = await import('./imagePlausibilityService.js');
      const result = await checkImage(Buffer.from('x'), 'image/jpeg', 'product');

      const { isSeedSlug } = await import('../constants/categorySeeds.js');
      expect(isSeedSlug(result.category)).toBe(true);
    });

    it('returns null category for item photos — no packaging to read a category from', async () => {
      const { checkImage } = await import('./imagePlausibilityService.js');
      const result = await checkImage(Buffer.from('x'), 'image/jpeg', 'item');

      expect(result.category).toBeNull();
    });

    it('never consults the daily quota', async () => {
      const { checkImage } = await import('./imagePlausibilityService.js');
      await checkImage(Buffer.from('x'), 'image/jpeg', 'product');
      expect(mockReserveGeminiCall).not.toHaveBeenCalled();
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
      expect(call.model).toBe('gemini-3.5-flash');
      expect(call.config.responseMimeType).toBe('application/json');
      // ADR 0005 L2: thinking disabled — reasoning tokens bill as output at the full rate.
      expect(call.config.thinkingConfig).toEqual({ thinkingBudget: 0 });
      expect(call.contents[0].parts[0].inlineData).toEqual({
        mimeType: 'image/jpeg',
        data: buffer.toString('base64'),
      });
      expect(call.contents[0].parts[1].text).toMatch(/front-of-pack/i);
    });

    it('passes an AbortSignal so the deadline actually cancels the call', async () => {
      mockGenerateContent.mockResolvedValue({ text: JSON.stringify(OK_RESPONSE) });
      const { checkImage } = await import('./imagePlausibilityService.js');

      await checkImage(Buffer.from('x'), 'image/jpeg', 'product');

      // Without this the budget in geminiDeadline.ts would abandon the request
      // rather than abort it, and the socket would stay open past the deadline.
      const call = mockGenerateContent.mock.calls[0][0];
      expect(call.config.abortSignal).toBeInstanceOf(AbortSignal);
      expect(call.config.abortSignal.aborted).toBe(false);
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

    // ADR 0005 L2: reserve before calling, never count after.
    it('reserves against the daily cap before calling Gemini', async () => {
      mockGenerateContent.mockResolvedValue({ text: JSON.stringify(OK_RESPONSE) });
      const { checkImage } = await import('./imagePlausibilityService.js');

      await checkImage(Buffer.from('x'), 'image/jpeg', 'product');

      expect(mockReserveGeminiCall).toHaveBeenCalledWith('plausibility');
      const reserveOrder = mockReserveGeminiCall.mock.invocationCallOrder[0]!;
      const callOrder = mockGenerateContent.mock.invocationCallOrder[0]!;
      expect(reserveOrder).toBeLessThan(callOrder);
    });

    // TICKET-P6-003: a model hallucination outside the curated seed list must
    // never reach Product.suggestedCategory.
    it('coerces a category outside the seed list to null', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ ...OK_RESPONSE, category: 'made-up-category' }),
      });
      const { checkImage } = await import('./imagePlausibilityService.js');

      const result = await checkImage(Buffer.from('x'), 'image/jpeg', 'product');

      expect(result.category).toBeNull();
    });

    it('passes through a valid seed slug for category', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ ...OK_RESPONSE, category: 'wine' }),
      });
      const { checkImage } = await import('./imagePlausibilityService.js');

      const result = await checkImage(Buffer.from('x'), 'image/jpeg', 'product');

      expect(result.category).toBe('wine');
    });

    it('never calls Gemini once the daily cap is exhausted', async () => {
      mockReserveGeminiCall.mockRejectedValue(new FakeGeminiDailyQuotaExhaustedError(300));
      const { checkImage } = await import('./imagePlausibilityService.js');

      await expect(checkImage(Buffer.from('x'), 'image/jpeg', 'product')).rejects.toThrow(
        FakeGeminiDailyQuotaExhaustedError,
      );
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
  });
});
