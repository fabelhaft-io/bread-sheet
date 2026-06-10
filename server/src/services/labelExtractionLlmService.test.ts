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
    Type: {
      OBJECT: 'OBJECT',
      STRING: 'STRING',
      NUMBER: 'NUMBER',
    },
  };
});

const FAKE_RESPONSE = {
  name: 'Bio Birnen-Brombeersaft',
  brand: null,
  genericName: 'Pear–blackberry juice',
  energyKcal: 38,
  carbohydrates: 9.0,
  sugars: 8.0,
  fat: 0.02,
  saturatedFat: 0.88,
  protein: 0.16,
  salt: 0.075,
  servingSize: '100ml',
  ingredients: 'Bio-Birnensaft (70%), Bio-Brombeersaft (30%)',
  confidence: 'high' as const,
};

describe('extractLabelWithLlm', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    vi.resetModules();
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('sends the image + prompt to Gemini and returns parsed JSON', async () => {
    mockGenerateContent.mockResolvedValue({ text: JSON.stringify(FAKE_RESPONSE) });
    const { extractLabelWithLlm } = await import('./labelExtractionLlmService.js');
    const buffer = Buffer.from('fake-image-bytes');

    const result = await extractLabelWithLlm(buffer, 'image/jpeg');

    expect(result).toEqual(FAKE_RESPONSE);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.model).toBe('gemini-2.5-flash');
    expect(call.config.responseMimeType).toBe('application/json');
    expect(call.config.responseSchema.required).toContain('confidence');
    expect(call.config.responseSchema.required).toContain('sugars');
    expect(call.config.responseSchema.required).toContain('saturatedFat');
    expect(call.contents[0].parts[0].inlineData).toEqual({
      mimeType: 'image/jpeg',
      data: buffer.toString('base64'),
    });
    expect(call.contents[0].parts[1].text).toMatch(/extracting structured nutrition/i);
  });

  it('uses the provided mime type for non-JPEG uploads', async () => {
    mockGenerateContent.mockResolvedValue({ text: JSON.stringify(FAKE_RESPONSE) });
    const { extractLabelWithLlm } = await import('./labelExtractionLlmService.js');

    await extractLabelWithLlm(Buffer.from('x'), 'image/png');

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.contents[0].parts[0].inlineData.mimeType).toBe('image/png');
  });

  it('throws when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const { extractLabelWithLlm } = await import('./labelExtractionLlmService.js');

    await expect(extractLabelWithLlm(Buffer.from('x'))).rejects.toThrow(/GEMINI_API_KEY/);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('propagates JSON parse errors when Gemini returns malformed output', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'not valid json' });
    const { extractLabelWithLlm } = await import('./labelExtractionLlmService.js');

    await expect(extractLabelWithLlm(Buffer.from('x'))).rejects.toThrow();
  });
});