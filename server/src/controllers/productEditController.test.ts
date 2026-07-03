import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockCorrectPendingProduct = vi.hoisted(() => vi.fn());
const mockCreateEdit = vi.hoisted(() => vi.fn());
const mockGetPendingEdit = vi.hoisted(() => vi.fn());
const mockCastEditVote = vi.hoisted(() => vi.fn());
const mockRetractEditVote = vi.hoisted(() => vi.fn());
const mockDismissEdit = vi.hoisted(() => vi.fn());

// Mutable per-test "session" (same pattern as productController.test.ts).
const session = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'test@test.com', isAnonymous: false } as
    | { id: string; email: string | undefined; isAnonymous: boolean }
    | null,
}));

vi.mock('../services/productEditService.js', async () => {
  const actual = await vi.importActual<
    typeof import('./../services/productEditService.js')
  >('../services/productEditService.js');
  return {
    ...actual,
    correctPendingProduct: mockCorrectPendingProduct,
    createEdit: mockCreateEdit,
    getPendingEdit: mockGetPendingEdit,
    castEditVote: mockCastEditVote,
    retractEditVote: mockRetractEditVote,
    dismissEdit: mockDismissEdit,
  };
});

// The edit service (imported for its error classes above) must not drag the
// real prisma/db or S3 stack into this test.
vi.mock('../db.js', () => ({ default: {} }));
vi.mock('../services/imageService.js', () => ({
  resolveImageUrl: (v: string | null) => v,
  uploadImageToS3: vi.fn(),
}));

vi.mock('../middlewares/authMiddleware.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!session.user) {
      return res.status(401).json({ error: 'unauthorised' });
    }
    req.user = session.user;
    next();
  },
  requireRegistered: (req: any, res: any, next: any) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.isAnonymous) {
      return res.status(403).json({ error: 'Registration required' });
    }
    next();
  },
}));

vi.mock('../middlewares/rateLimit.js', () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  userLimiter: (_req: any, _res: any, next: any) => next(),
  syncLimiter: (_req: any, _res: any, next: any) => next(),
}));

import app from '../app.js';
import {
  DuplicateEditVoteError,
  EditNotFoundError,
  PendingEditExistsError,
  ProductIsVerifiedError,
  ProductNotVerifiedError,
  SelfEditVoteError,
} from '../services/productEditService.js';
import { ProductNotFoundError } from '../services/productVerificationService.js';

const BARCODE = '1234567890123';
const EDIT_ID = 'edit-1';

const CORRECTION_BODY = {
  name: 'Corrected Bread',
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
};

function resetSession() {
  session.user = { id: 'user-1', email: 'test@test.com', isAnonymous: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSession();
});

describe('PATCH /api/products/:barcode', () => {
  it('returns 403 for anonymous users', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    const res = await request(app).patch(`/api/products/${BARCODE}`).send(CORRECTION_BODY);
    expect(res.status).toBe(403);
    expect(mockCorrectPendingProduct).not.toHaveBeenCalled();
  });

  it('returns 422 for an invalid payload', async () => {
    const res = await request(app).patch(`/api/products/${BARCODE}`).send({ name: '' });
    expect(res.status).toBe(422);
  });

  it('returns 409 (product_verified) on a VERIFIED product', async () => {
    mockCorrectPendingProduct.mockRejectedValue(new ProductIsVerifiedError(BARCODE));
    const res = await request(app).patch(`/api/products/${BARCODE}`).send(CORRECTION_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('product_verified');
  });

  it('returns the corrected product on success', async () => {
    mockCorrectPendingProduct.mockResolvedValue({
      barcode: BARCODE,
      name: 'Corrected Bread',
      status: 'PENDING_REVIEW',
      image: null,
    });
    const res = await request(app).patch(`/api/products/${BARCODE}`).send(CORRECTION_BODY);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Corrected Bread');
    // Barcode comes from the URL, not the body.
    expect(mockCorrectPendingProduct.mock.calls[0][0].barcode).toBe(BARCODE);
    expect(mockCorrectPendingProduct.mock.calls[0][1]).toBe('user-1');
  });
});

describe('POST /api/products/:barcode/edits', () => {
  it('returns 403 for anonymous users', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    const res = await request(app)
      .post(`/api/products/${BARCODE}/edits`)
      .send({ name: 'New Name' });
    expect(res.status).toBe(403);
  });

  it('returns 409 (edit_pending) when an edit is already under review', async () => {
    mockCreateEdit.mockRejectedValue(new PendingEditExistsError(BARCODE));
    const res = await request(app)
      .post(`/api/products/${BARCODE}/edits`)
      .send({ name: 'New Name' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('edit_pending');
  });

  it('returns 409 (product_not_verified) on a PENDING_REVIEW product', async () => {
    mockCreateEdit.mockRejectedValue(new ProductNotVerifiedError(BARCODE));
    const res = await request(app)
      .post(`/api/products/${BARCODE}/edits`)
      .send({ name: 'New Name' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('product_not_verified');
  });

  it('returns 404 for an unknown product', async () => {
    mockCreateEdit.mockRejectedValue(new ProductNotFoundError(BARCODE));
    const res = await request(app)
      .post(`/api/products/${BARCODE}/edits`)
      .send({ name: 'New Name' });
    expect(res.status).toBe(404);
  });

  it('returns 422 for a payload with no editable fields', async () => {
    const res = await request(app).post(`/api/products/${BARCODE}/edits`).send({});
    expect(res.status).toBe(422);
    expect(mockCreateEdit).not.toHaveBeenCalled();
  });

  it('creates the edit and returns 201', async () => {
    mockCreateEdit.mockResolvedValue({
      id: EDIT_ID,
      barcode: BARCODE,
      status: 'PENDING',
      proposedChanges: { name: 'New Name' },
    });
    const res = await request(app)
      .post(`/api/products/${BARCODE}/edits`)
      .send({ name: 'New Name' });
    expect(res.status).toBe(201);
    expect(res.body.editId).toBe(EDIT_ID);
    expect(mockCreateEdit).toHaveBeenCalledWith(BARCODE, 'user-1', { name: 'New Name' });
  });
});

describe('GET /api/products/:barcode/edits/pending', () => {
  it('returns { edit: null } when nothing is pending', async () => {
    mockGetPendingEdit.mockResolvedValue(null);
    const res = await request(app).get(`/api/products/${BARCODE}/edits/pending`);
    expect(res.status).toBe(200);
    expect(res.body.edit).toBeNull();
  });

  it('returns the pending edit view', async () => {
    mockGetPendingEdit.mockResolvedValue({
      editId: EDIT_ID,
      barcode: BARCODE,
      originalValues: { name: 'Old' },
      proposedChanges: { name: 'New' },
      approvals: 1,
      rejections: 0,
      createdAt: new Date().toISOString(),
      viewer: { isAuthor: false, vote: null, dismissed: false },
    });
    const res = await request(app).get(`/api/products/${BARCODE}/edits/pending`);
    expect(res.status).toBe(200);
    expect(res.body.edit.editId).toBe(EDIT_ID);
  });
});

describe('POST /api/products/edits/:editId/votes', () => {
  it('returns 400 for an invalid vote value', async () => {
    const res = await request(app)
      .post(`/api/products/edits/${EDIT_ID}/votes`)
      .send({ vote: 'MAYBE' });
    expect(res.status).toBe(400);
    expect(mockCastEditVote).not.toHaveBeenCalled();
  });

  it('returns 403 when the author votes on their own edit', async () => {
    mockCastEditVote.mockRejectedValue(new SelfEditVoteError());
    const res = await request(app)
      .post(`/api/products/edits/${EDIT_ID}/votes`)
      .send({ vote: 'APPROVE' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('self_edit_vote');
  });

  it('returns 409 on a duplicate vote', async () => {
    mockCastEditVote.mockRejectedValue(new DuplicateEditVoteError());
    const res = await request(app)
      .post(`/api/products/edits/${EDIT_ID}/votes`)
      .send({ vote: 'APPROVE' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate_vote');
  });

  it('returns the tally on success', async () => {
    mockCastEditVote.mockResolvedValue({ approvals: 2, rejections: 0, status: 'APPLIED' });
    const res = await request(app)
      .post(`/api/products/edits/${EDIT_ID}/votes`)
      .send({ vote: 'APPROVE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approvals: 2, rejections: 0, status: 'APPLIED' });
    expect(mockCastEditVote).toHaveBeenCalledWith(EDIT_ID, 'user-1', 'APPROVE');
  });
});

describe('DELETE /api/products/edits/:editId/votes', () => {
  it('returns 404 for an unknown edit', async () => {
    mockRetractEditVote.mockRejectedValue(new EditNotFoundError(EDIT_ID));
    const res = await request(app).delete(`/api/products/edits/${EDIT_ID}/votes`);
    expect(res.status).toBe(404);
  });

  it('returns the tally after retraction', async () => {
    mockRetractEditVote.mockResolvedValue({ approvals: 0, rejections: 0, status: 'PENDING' });
    const res = await request(app).delete(`/api/products/edits/${EDIT_ID}/votes`);
    expect(res.status).toBe(200);
    expect(mockRetractEditVote).toHaveBeenCalledWith(EDIT_ID, 'user-1');
  });
});

describe('POST /api/products/edits/:editId/dismissals', () => {
  it('returns 403 for anonymous users', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    const res = await request(app).post(`/api/products/edits/${EDIT_ID}/dismissals`).send({});
    expect(res.status).toBe(403);
  });

  it('records the dismissal', async () => {
    mockDismissEdit.mockResolvedValue(undefined);
    const res = await request(app).post(`/api/products/edits/${EDIT_ID}/dismissals`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dismissed: true });
    expect(mockDismissEdit).toHaveBeenCalledWith(EDIT_ID, 'user-1');
  });
});
