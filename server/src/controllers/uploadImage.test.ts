import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ── Multer mock ─────────────────────────────────────────────────────────────
// `upload.single('image')` is called at route-registration time (module import),
// so it must return a valid function immediately. We return a stable wrapper that
// delegates to a mutable `multerState.handler` — individual tests swap the handler.
const multerState = vi.hoisted(() => ({
  handler: (_req: any, _res: any, next: any) => next(),
}));

// Fake MulterError class (needs to exist when the vi.mock factory runs)
const FakeMulterError = vi.hoisted(() => {
  return class FakeMulterError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.name = 'MulterError';
      this.code = code;
    }
  };
});

vi.mock('multer', () => {
  const multerFn = () => ({
    single: () => (req: any, res: any, next: any) => multerState.handler(req, res, next),
  });
  multerFn.memoryStorage = () => ({});
  multerFn.MulterError = FakeMulterError;
  return { default: multerFn };
});

// ── File-type mock ───────────────────────────────────────────────────────────
const mockFileTypeFromBuffer = vi.hoisted(() => vi.fn());

vi.mock('file-type', () => ({
  fileTypeFromBuffer: mockFileTypeFromBuffer,
}));

// ── imageService mock ────────────────────────────────────────────────────────
const mockUploadImageToS3 = vi.hoisted(() => vi.fn());

vi.mock('../services/imageService.js', () => ({
  uploadImageToS3: mockUploadImageToS3,
}));

// ── imagePlausibilityService mock ────────────────────────────────────────────
const mockCheckImage = vi.hoisted(() => vi.fn());

vi.mock('../services/imagePlausibilityService.js', () => ({
  checkImage: mockCheckImage,
}));

function okVerdict(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'ok',
    reason: 'looks fine',
    name: 'Detected Name',
    brand: 'Detected Brand',
    genericName: 'detected category',
    ...overrides,
  };
}

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
  requireRegistered: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middlewares/rateLimit.js', () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  userLimiter: (_req: any, _res: any, next: any) => next(),
  syncLimiter: (_req: any, _res: any, next: any) => next(),
}));

// ── Prisma stub (needed because app.ts loads all routes) ─────────────────────
const mockAbuseFlagCreate = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({
  default: {
    product: { findUnique: vi.fn(), create: vi.fn() },
    userAbuseFlag: { create: mockAbuseFlagCreate },
  },
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

import app from '../app.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes

// Real multer would parse the multipart body and populate req.body.
// The mock doesn't, so we inject both file and body fields manually.
function stubMulterFile(
  file: Partial<Express.Multer.File> | null,
  kind: string = 'product',
) {
  multerState.handler = (req: any, _res: any, next: any) => {
    if (file) req.file = file;
    req.body = { kind };
    next();
  };
}

function stubMulterError(code: string) {
  multerState.handler = (_req: any, _res: any, next: any) => {
    next(new FakeMulterError(code));
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/products/upload-image', () => {
  beforeEach(() => {
    multerState.handler = (_req: any, _res: any, next: any) => next();
    mockFileTypeFromBuffer.mockReset();
    mockUploadImageToS3.mockReset();
    mockCheckImage.mockReset();
    mockAbuseFlagCreate.mockReset();
    // Default: the plausibility check passes. Rejection tests override this.
    mockCheckImage.mockResolvedValue(okVerdict());
    session.user = { id: 'user-1', email: 'test@test.com', isAnonymous: false };
  });

  it('returns 200 with the S3 URL and photo suggestions on a valid product upload', async () => {
    stubMulterFile({ buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 1024, originalname: 'photo.jpg' });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    mockUploadImageToS3.mockResolvedValue(
      'http://localhost:4566/breadsheet-images-local/processed/uuid.jpg',
    );

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('/processed/');
    expect(res.body).toMatchObject({
      name: 'Detected Name',
      brand: 'Detected Brand',
      genericName: 'detected category',
    });
    expect(mockCheckImage).toHaveBeenCalledWith(FAKE_JPEG, 'image/jpeg', 'product');
    expect(mockUploadImageToS3).toHaveBeenCalledWith(FAKE_JPEG, 'product');
  });

  it('returns 200 with the S3 URL on a valid label image upload', async () => {
    stubMulterFile({ buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 2048, originalname: 'label.jpg' }, 'label');
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    mockUploadImageToS3.mockResolvedValue(
      'http://localhost:4566/breadsheet-images-local/processed/uuid.jpg',
    );

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'label');

    expect(res.status).toBe(200);
    expect(mockUploadImageToS3).toHaveBeenCalledWith(FAKE_JPEG, 'label');
  });

  it('returns 413 when the file exceeds the 8 MB limit', async () => {
    stubMulterError('LIMIT_FILE_SIZE');

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('image_too_large');
    expect(mockUploadImageToS3).not.toHaveBeenCalled();
  });

  it('returns 415 when magic bytes indicate an unsupported format', async () => {
    stubMulterFile({ buffer: Buffer.from('%PDF-1.4'), mimetype: 'application/pdf', size: 512, originalname: 'doc.pdf' });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_format');
    expect(mockUploadImageToS3).not.toHaveBeenCalled();
  });

  it('returns 415 when file-type cannot detect a format (e.g. SVG, plain text)', async () => {
    stubMulterFile({ buffer: Buffer.from('<svg>...'), mimetype: 'image/svg+xml', size: 200, originalname: 'icon.svg' });
    mockFileTypeFromBuffer.mockResolvedValue(undefined); // SVG has no magic bytes

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_format');
  });

  it('returns 400 when no image file is attached', async () => {
    stubMulterFile(null); // multer runs but sets no req.file

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('image_required');
  });

  it('returns 400 when kind is missing or invalid', async () => {
    stubMulterFile(
      { buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 1024, originalname: 'photo.jpg' },
      'thumbnail', // not 'product' or 'label'
    );
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'thumbnail');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_kind');
    expect(mockUploadImageToS3).not.toHaveBeenCalled();
  });

  it('accepts WebP images', async () => {
    const webpBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46]); // RIFF header
    stubMulterFile({ buffer: webpBuffer, mimetype: 'image/webp', size: 512, originalname: 'photo.webp' });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/webp', ext: 'webp' });
    mockUploadImageToS3.mockResolvedValue('http://localhost:4566/breadsheet-images-local/processed/uuid.jpg');

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(200);
    expect(mockUploadImageToS3).toHaveBeenCalledWith(webpBuffer, 'product');
  });

  it('accepts PNG images (converted to JPEG by imageService)', async () => {
    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    stubMulterFile({ buffer: pngBuffer, mimetype: 'image/png', size: 512, originalname: 'photo.png' });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    mockUploadImageToS3.mockResolvedValue('http://localhost:4566/breadsheet-images-local/processed/uuid.jpg');

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('/processed/');
    expect(mockUploadImageToS3).toHaveBeenCalledWith(pngBuffer, 'product');
  });

  it('allows authenticated anonymous users to upload (upload-image does not require registration)', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    stubMulterFile({ buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 1024, originalname: 'photo.jpg' });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    mockUploadImageToS3.mockResolvedValue('http://localhost:4566/breadsheet-images-local/processed/uuid.jpg');

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer anon-token')
      .field('kind', 'product');

    expect(res.status).toBe(200);
    expect(mockUploadImageToS3).toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated session', async () => {
    session.user = null;

    const res = await request(app)
      .post('/api/products/upload-image')
      .field('kind', 'product');

    expect(res.status).toBe(401);
    expect(mockUploadImageToS3).not.toHaveBeenCalled();
  });

  // ── Plausibility / abuse gate (P5-005) ──────────────────────────────────────

  it('returns 422 and does not upload when the photo is not a product', async () => {
    stubMulterFile({ buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 1024, originalname: 'photo.jpg' });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    mockCheckImage.mockResolvedValue(okVerdict({ verdict: 'not_a_product', reason: 'a cat' }));

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('image_rejected');
    expect(res.body.reason).toBeTruthy();
    expect(mockUploadImageToS3).not.toHaveBeenCalled();
    expect(mockAbuseFlagCreate).not.toHaveBeenCalled();
  });

  it('returns 422 advising a retake when the photo is unusable', async () => {
    stubMulterFile({ buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 1024, originalname: 'photo.jpg' });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    mockCheckImage.mockResolvedValue(okVerdict({ verdict: 'unusable', reason: 'too blurry' }));

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('image_rejected');
    expect(mockUploadImageToS3).not.toHaveBeenCalled();
    expect(mockAbuseFlagCreate).not.toHaveBeenCalled();
  });

  it('rejects abusive content, records a UserAbuseFlag, and does not upload', async () => {
    stubMulterFile({ buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 1024, originalname: 'photo.jpg' });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    mockCheckImage.mockResolvedValue(
      okVerdict({ verdict: 'abuse', reason: 'explicit content' }),
    );
    mockAbuseFlagCreate.mockResolvedValue({ id: 'flag-1' });

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'product');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('image_rejected');
    // The specific abuse reason is never forwarded to the client.
    expect(res.body.reason).not.toMatch(/explicit/i);
    expect(mockUploadImageToS3).not.toHaveBeenCalled();
    expect(mockAbuseFlagCreate).toHaveBeenCalledWith({
      data: { userId: 'user-1', reason: 'explicit content' },
    });
  });

  it('gates abusive content on the label slot too', async () => {
    stubMulterFile(
      { buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 1024, originalname: 'label.jpg' },
      'label',
    );
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    mockCheckImage.mockResolvedValue(
      okVerdict({ verdict: 'abuse', reason: 'graphic content' }),
    );
    mockAbuseFlagCreate.mockResolvedValue({ id: 'flag-2' });

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'label');

    expect(res.status).toBe(422);
    expect(mockUploadImageToS3).not.toHaveBeenCalled();
    expect(mockAbuseFlagCreate).toHaveBeenCalledWith({
      data: { userId: 'user-1', reason: 'graphic content' },
    });
  });

  it('does not return photo suggestions for a valid label upload', async () => {
    stubMulterFile(
      { buffer: FAKE_JPEG, mimetype: 'image/jpeg', size: 1024, originalname: 'label.jpg' },
      'label',
    );
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    mockUploadImageToS3.mockResolvedValue(
      'http://localhost:4566/breadsheet-images-local/processed/uuid.jpg',
    );

    const res = await request(app)
      .post('/api/products/upload-image')
      .set('Authorization', 'Bearer token')
      .field('kind', 'label');

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('/processed/');
    expect(res.body.name).toBeUndefined();
    expect(res.body.brand).toBeUndefined();
  });
});