import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ── labelExtractionService mock ──────────────────────────────────────────────
const mockExtractFromText = vi.hoisted(() => vi.fn());

vi.mock('../services/labelExtractionService.js', () => ({
  extractFromText: mockExtractFromText,
}));

// ── Auth / rate-limit stubs ──────────────────────────────────────────────────
const session = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'test@test.com', isAnonymous: false } as
    | { id: string; email: string | undefined; isAnonymous: boolean }
    | null,
}));

vi.mock('../middlewares/authMiddleware.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!session.user) return res.status(401).json({ error: 'unauthorised' });
    req.user = session.user;
    next();
  },
  requireRegistered: (req: any, res: any, next: any) => {
    if (req.user?.isAnonymous) return res.status(403).json({ error: 'registration_required' });
    next();
  },
}));

vi.mock('../middlewares/rateLimit.js', () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  userLimiter: (_req: any, _res: any, next: any) => next(),
  syncLimiter: (_req: any, _res: any, next: any) => next(),
}));

// ── Prisma + product service stubs (loaded transitively by app.ts) ────────────
vi.mock('../db.js', () => ({
  default: { product: { findUnique: vi.fn(), create: vi.fn() } },
}));

vi.mock('../services/productService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/productService.js')>(
    '../services/productService.js',
  );
  return { ...actual, fetchFromOpenFoodFacts: vi.fn(), createSubmittedProduct: vi.fn() };
});

vi.mock('../validators/productSubmissionValidator.js', async () => {
  const actual = await vi.importActual<
    typeof import('../validators/productSubmissionValidator.js')
  >('../validators/productSubmissionValidator.js');
  return { ...actual, validateProductSubmission: vi.fn() };
});

// ── multer stub (used by productRoutes) ──────────────────────────────────────
vi.mock('multer', () => {
  const multerFn = () => ({
    single: () => (_req: any, _res: any, next: any) => next(),
  });
  multerFn.memoryStorage = () => ({});
  multerFn.MulterError = class MulterError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  };
  return { default: multerFn };
});

vi.mock('file-type', () => ({ fileTypeFromBuffer: vi.fn() }));
vi.mock('../services/imageService.js', () => ({ uploadImageToS3: vi.fn() }));

import app from '../app.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const LONG_TEXT = 'a'.repeat(50);

const FAKE_LABEL = {
  name: null,
  brand: null,
  genericName: null,
  energyKcal: 295,
  carbohydrates: 45.2,
  fat: 10.5,
  protein: 8.4,
  salt: 0.5,
  servingSize: '30g',
  ingredients: 'Wheat flour, sugar, palm oil',
  confidence: 'high' as const,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/products/extract-label', () => {
  beforeEach(() => {
    mockExtractFromText.mockReset();
    session.user = { id: 'user-1', email: 'test@test.com', isAnonymous: false };
  });

  it('returns 200 with the extracted label for valid JSON text', async () => {
    mockExtractFromText.mockReturnValue(FAKE_LABEL);

    const res = await request(app)
      .post('/api/products/extract-label')
      .set('Authorization', 'Bearer token')
      .send({ rawText: LONG_TEXT });

    expect(res.status).toBe(200);
    expect(res.body.energyKcal).toBe(295);
    expect(res.body.confidence).toBe('high');
    expect(mockExtractFromText).toHaveBeenCalledWith(LONG_TEXT);
  });

  it('returns 200 with all-null confidence:low when parser finds nothing', async () => {
    const nullLabel = {
      name: null, brand: null, genericName: null,
      energyKcal: null, carbohydrates: null, fat: null,
      protein: null, salt: null, servingSize: null,
      ingredients: null, confidence: 'low' as const,
    };
    mockExtractFromText.mockReturnValue(nullLabel);

    const res = await request(app)
      .post('/api/products/extract-label')
      .set('Authorization', 'Bearer token')
      .send({ rawText: LONG_TEXT });

    expect(res.status).toBe(200);
    expect(res.body.confidence).toBe('low');
    expect(res.body.energyKcal).toBeNull();
  });

  it('returns 400 when rawText is missing', async () => {
    const res = await request(app)
      .post('/api/products/extract-label')
      .set('Authorization', 'Bearer token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('raw_text_too_short');
    expect(mockExtractFromText).not.toHaveBeenCalled();
  });

  it('returns 400 when rawText is shorter than 50 characters', async () => {
    const res = await request(app)
      .post('/api/products/extract-label')
      .set('Authorization', 'Bearer token')
      .send({ rawText: 'too short' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('raw_text_too_short');
    expect(mockExtractFromText).not.toHaveBeenCalled();
  });

  it('returns 400 when rawText is whitespace-only under 50 printable chars', async () => {
    const res = await request(app)
      .post('/api/products/extract-label')
      .set('Authorization', 'Bearer token')
      .send({ rawText: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('raw_text_too_short');
  });

  it('returns 501 for multipart/form-data requests', async () => {
    const res = await request(app)
      .post('/api/products/extract-label')
      .set('Authorization', 'Bearer token')
      .set('Content-Type', 'multipart/form-data; boundary=----boundary')
      .send(
        '------boundary\r\nContent-Disposition: form-data; name="rawText"\r\n\r\ntest\r\n------boundary--',
      );

    expect(res.status).toBe(501);
    expect(res.body.error).toBe('image_path_not_implemented');
    expect(mockExtractFromText).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated session', async () => {
    session.user = null;

    const res = await request(app)
      .post('/api/products/extract-label')
      .send({ rawText: LONG_TEXT });

    expect(res.status).toBe(401);
    expect(mockExtractFromText).not.toHaveBeenCalled();
  });

  it('returns 403 when the user is anonymous', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };

    const res = await request(app)
      .post('/api/products/extract-label')
      .set('Authorization', 'Bearer token')
      .send({ rawText: LONG_TEXT });

    expect(res.status).toBe(403);
    expect(mockExtractFromText).not.toHaveBeenCalled();
  });
});