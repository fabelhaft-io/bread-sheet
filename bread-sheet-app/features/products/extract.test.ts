import { extractFromLabelImage } from './extract';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest
        .fn()
        .mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

jest.mock('./api', () => ({
  extractLabelFromText: jest.fn(),
  extractLabelFromImage: jest.fn(),
}));

jest.mock('./ocr', () => ({
  recogniseLabelText: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const api = require('./api');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ocr = require('./ocr');

describe('extractFromLabelImage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the text path when on-device OCR yields >= MIN_OCR_LENGTH chars', async () => {
    ocr.recogniseLabelText.mockResolvedValue({
      rawText: 'a'.repeat(80),
      unavailable: false,
    });
    const payload = {
      name: 'Bread',
      brand: null,
      genericName: null,
      energyKcal: 250,
      fat: null,
      saturatedFat: null,
      carbohydrates: null,
      sugars: null,
      protein: null,
      salt: null,
      servingSize: null,
      ingredients: null,
      confidence: 'high' as const,
    };
    api.extractLabelFromText.mockResolvedValue(payload);

    const outcome = await extractFromLabelImage('file:///tmp/label.jpg');
    expect(outcome).toEqual({ kind: 'ok', path: 'text', data: payload });
    expect(api.extractLabelFromText).toHaveBeenCalled();
    expect(api.extractLabelFromImage).not.toHaveBeenCalled();
  });

  it('falls back to the image path when OCR is below the threshold', async () => {
    ocr.recogniseLabelText.mockResolvedValue({
      rawText: 'short',
      unavailable: false,
    });
    const payload = {
      name: 'Bread',
      brand: null,
      genericName: null,
      energyKcal: null,
      fat: null,
      saturatedFat: null,
      carbohydrates: null,
      sugars: null,
      protein: null,
      salt: null,
      servingSize: null,
      ingredients: null,
      confidence: 'medium' as const,
    };
    api.extractLabelFromImage.mockResolvedValue(payload);

    const outcome = await extractFromLabelImage('file:///tmp/label.jpg');
    expect(outcome).toEqual({ kind: 'ok', path: 'image', data: payload });
    expect(api.extractLabelFromText).not.toHaveBeenCalled();
    expect(api.extractLabelFromImage).toHaveBeenCalled();
  });

  it('returns a skipped outcome when both paths fail', async () => {
    ocr.recogniseLabelText.mockResolvedValue({
      rawText: '',
      unavailable: true,
    });
    api.extractLabelFromImage.mockRejectedValue(new Error('net'));

    const outcome = await extractFromLabelImage('file:///tmp/label.jpg');
    expect(outcome).toEqual({ kind: 'skipped', reason: 'ocr_unavailable' });
  });
});
