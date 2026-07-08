import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTxProductFindUnique = vi.hoisted(() => vi.fn());
const mockTxProductUpdate = vi.hoisted(() => vi.fn());
const mockTxVerificationDeleteMany = vi.hoisted(() => vi.fn());
const mockTxEditFindUnique = vi.hoisted(() => vi.fn());
const mockTxEditFindFirst = vi.hoisted(() => vi.fn());
const mockTxEditCreate = vi.hoisted(() => vi.fn());
const mockTxEditUpdate = vi.hoisted(() => vi.fn());
const mockTxVoteCreate = vi.hoisted(() => vi.fn());
const mockTxVoteFindMany = vi.hoisted(() => vi.fn());
const mockTxVoteDeleteMany = vi.hoisted(() => vi.fn());

const mockEditFindFirst = vi.hoisted(() => vi.fn());
const mockEditFindUnique = vi.hoisted(() => vi.fn());
const mockEditUpdateMany = vi.hoisted(() => vi.fn());
const mockDismissalUpsert = vi.hoisted(() => vi.fn());

const mockTransaction = vi.hoisted(() =>
  vi.fn(
    async <T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T> => {
      const tx = {
        product: {
          findUnique: mockTxProductFindUnique,
          update: mockTxProductUpdate,
        },
        productVerification: {
          deleteMany: mockTxVerificationDeleteMany,
        },
        productEdit: {
          findUnique: mockTxEditFindUnique,
          findFirst: mockTxEditFindFirst,
          create: mockTxEditCreate,
          update: mockTxEditUpdate,
        },
        productEditVote: {
          create: mockTxVoteCreate,
          findMany: mockTxVoteFindMany,
          deleteMany: mockTxVoteDeleteMany,
        },
      };
      return fn(tx);
    },
  ),
);

vi.mock('../db.js', () => ({
  default: {
    $transaction: mockTransaction,
    productEdit: {
      findFirst: mockEditFindFirst,
      findUnique: mockEditFindUnique,
      updateMany: mockEditUpdateMany,
    },
    productEditDismissal: {
      upsert: mockDismissalUpsert,
    },
  },
}));

// Minimal stand-in for `Prisma.PrismaClientKnownRequestError` so the service
// can `instanceof`-check simulated unique violations (same pattern as
// productService.test.ts).
const FakePrismaKnownRequestError = vi.hoisted(() => {
  return class FakePrismaKnownRequestError extends Error {
    code: string;
    constructor(message: string, opts: { code: string }) {
      super(message);
      this.code = opts.code;
    }
  };
});

vi.mock('../generated/prisma_client/client.js', () => ({
  Prisma: { PrismaClientKnownRequestError: FakePrismaKnownRequestError },
}));

// Avoid pulling sharp/S3 into this test — resolveImageUrl passthrough is enough.
vi.mock('./imageService.js', () => ({
  resolveImageUrl: (v: string | null) => (v ? `http://assets.test/${v}` : v),
}));

import {
  correctPendingProduct,
  createEdit,
  getPendingEdit,
  castEditVote,
  retractEditVote,
  dismissEdit,
  expireStaleEdits,
  DuplicateEditVoteError,
  EditNotFoundError,
  EditNotPendingError,
  EditVoteNotFoundError,
  NoChangesError,
  PendingEditExistsError,
  ProductIsVerifiedError,
  ProductNotVerifiedError,
  SelfEditVoteError,
} from './productEditService.js';
import {
  ProductNotFoundError,
} from './productVerificationService.js';
import {
  ProductEditStatus,
  ProductStatus,
  VerificationVote,
} from '../generated/prisma_client/enums.js';

const BARCODE = '1234567890123';
const EDIT_ID = 'edit-1';
const AUTHOR = 'author-1';
const REVIEWER = 'reviewer-1';

const VERIFIED_PRODUCT = {
  id: 'product-1',
  barcode: BARCODE,
  status: ProductStatus.VERIFIED,
  name: 'Sourdough Bread',
  brand: 'BakeryCo',
  genericName: 'Bread',
  energyKcal: 250,
  fat: 3.5,
  saturatedFat: 1.2,
  carbohydrates: 45,
  sugars: 5,
  protein: 8,
  salt: 1.2,
  servingSize: '50g',
  ingredients: 'Flour, water, salt, yeast',
  image: 'processed/00000000-0000-4000-8000-000000000000.jpg',
  submittedByUserId: 'submitter-1',
};

const PENDING_EDIT = {
  id: EDIT_ID,
  barcode: BARCODE,
  authorUserId: AUTHOR,
  originalValues: { name: 'Sourdough Bread' },
  proposedChanges: { name: 'Sourdough Loaf' },
  status: ProductEditStatus.PENDING,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  expiresAt: new Date('2028-07-01T00:00:00Z'),
};

const CORRECTION_PAYLOAD = {
  barcode: BARCODE,
  name: 'Corrected Bread',
  brand: 'BakeryCo',
  genericName: null,
  energyKcal: 260,
  fat: null,
  saturatedFat: null,
  carbohydrates: null,
  sugars: null,
  protein: null,
  salt: null,
  servingSize: null,
  ingredients: null,
  productImageKey: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── correctPendingProduct (PATCH path) ──────────────────────────────────────

describe('correctPendingProduct', () => {
  it('throws ProductNotFoundError for an unknown barcode', async () => {
    mockTxProductFindUnique.mockResolvedValue(null);
    await expect(correctPendingProduct(CORRECTION_PAYLOAD, REVIEWER)).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });

  it('throws ProductIsVerifiedError when the product is VERIFIED (use the edit flow)', async () => {
    mockTxProductFindUnique.mockResolvedValue(VERIFIED_PRODUCT);
    await expect(correctPendingProduct(CORRECTION_PAYLOAD, REVIEWER)).rejects.toBeInstanceOf(
      ProductIsVerifiedError,
    );
  });

  it('updates in place, clears verifications, and reassigns the submitter', async () => {
    const pending = { ...VERIFIED_PRODUCT, status: ProductStatus.PENDING_REVIEW };
    mockTxProductFindUnique.mockResolvedValue(pending);
    mockTxProductUpdate.mockImplementation(async ({ data }) => ({ ...pending, ...data }));

    const result = await correctPendingProduct(CORRECTION_PAYLOAD, REVIEWER);

    expect(mockTxVerificationDeleteMany).toHaveBeenCalledWith({
      where: { productId: pending.id },
    });
    const updateArgs = mockTxProductUpdate.mock.calls[0][0];
    expect(updateArgs.data.submittedByUserId).toBe(REVIEWER);
    expect(updateArgs.data.status).toBe(ProductStatus.PENDING_REVIEW);
    expect(updateArgs.data.name).toBe('Corrected Bread');
    // No new image key -> the image column must not be touched.
    expect('image' in updateArgs.data).toBe(false);
    expect(result.submittedByUserId).toBe(REVIEWER);
  });

  it('replaces the image when a new productImageKey is provided', async () => {
    const pending = { ...VERIFIED_PRODUCT, status: ProductStatus.PENDING_REVIEW };
    mockTxProductFindUnique.mockResolvedValue(pending);
    mockTxProductUpdate.mockImplementation(async ({ data }) => ({ ...pending, ...data }));

    const key = 'processed/11111111-1111-4111-8111-111111111111.jpg';
    await correctPendingProduct({ ...CORRECTION_PAYLOAD, productImageKey: key }, REVIEWER);

    expect(mockTxProductUpdate.mock.calls[0][0].data.image).toBe(key);
  });
});

// ─── createEdit ──────────────────────────────────────────────────────────────

describe('createEdit', () => {
  it('throws ProductNotFoundError for an unknown barcode', async () => {
    mockTxProductFindUnique.mockResolvedValue(null);
    await expect(createEdit(BARCODE, AUTHOR, { name: 'X' })).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });

  it('throws ProductNotVerifiedError on a PENDING_REVIEW product', async () => {
    mockTxProductFindUnique.mockResolvedValue({
      ...VERIFIED_PRODUCT,
      status: ProductStatus.PENDING_REVIEW,
    });
    await expect(createEdit(BARCODE, AUTHOR, { name: 'X' })).rejects.toBeInstanceOf(
      ProductNotVerifiedError,
    );
  });

  it('throws PendingEditExistsError when another edit is already pending', async () => {
    mockTxProductFindUnique.mockResolvedValue(VERIFIED_PRODUCT);
    mockTxEditFindFirst.mockResolvedValue({ id: 'existing-edit' });
    await expect(createEdit(BARCODE, AUTHOR, { name: 'X' })).rejects.toBeInstanceOf(
      PendingEditExistsError,
    );
  });

  it('throws NoChangesError when every proposed value equals the current one', async () => {
    mockTxProductFindUnique.mockResolvedValue(VERIFIED_PRODUCT);
    mockTxEditFindFirst.mockResolvedValue(null);
    await expect(
      createEdit(BARCODE, AUTHOR, { name: 'Sourdough Bread', salt: 1.2 }),
    ).rejects.toBeInstanceOf(NoChangesError);
  });

  it('stores only the effective diff plus a full snapshot of the editable fields', async () => {
    mockTxProductFindUnique.mockResolvedValue(VERIFIED_PRODUCT);
    mockTxEditFindFirst.mockResolvedValue(null);
    mockTxEditCreate.mockImplementation(async ({ data }) => ({ id: EDIT_ID, ...data }));

    await createEdit(BARCODE, AUTHOR, {
      name: 'Sourdough Bread', // unchanged -> dropped
      brand: 'New Bakery', // changed
      salt: 1.5, // changed
    });

    const created = mockTxEditCreate.mock.calls[0][0].data;
    expect(created.proposedChanges).toEqual({ brand: 'New Bakery', salt: 1.5 });
    expect(created.originalValues.name).toBe('Sourdough Bread');
    expect(created.originalValues.image).toBe(VERIFIED_PRODUCT.image);
    expect(created.authorUserId).toBe(AUTHOR);
    // Expiry sits ~2 years out.
    const years =
      (created.expiresAt.getTime() - Date.now()) / (365.25 * 24 * 60 * 60 * 1000);
    expect(years).toBeGreaterThan(1.9);
    expect(years).toBeLessThan(2.1);
  });

  it('maps a P2002 race on the partial unique index to PendingEditExistsError', async () => {
    mockTxProductFindUnique.mockResolvedValue(VERIFIED_PRODUCT);
    mockTxEditFindFirst.mockResolvedValue(null);
    mockTxEditCreate.mockRejectedValue(
      new FakePrismaKnownRequestError('unique violation', { code: 'P2002' }),
    );
    await expect(createEdit(BARCODE, AUTHOR, { name: 'X' })).rejects.toBeInstanceOf(
      PendingEditExistsError,
    );
  });
});

// ─── getPendingEdit ──────────────────────────────────────────────────────────

describe('getPendingEdit', () => {
  it('returns null when there is no pending edit', async () => {
    mockEditFindFirst.mockResolvedValue(null);
    expect(await getPendingEdit(BARCODE, REVIEWER)).toBeNull();
  });

  it('returns tallies and viewer flags, resolving image keys to URLs', async () => {
    mockEditFindFirst.mockResolvedValue({
      ...PENDING_EDIT,
      originalValues: { name: 'Old', image: 'processed/abc.jpg' },
      proposedChanges: { name: 'New' },
      votes: [
        { userId: 'other-1', vote: VerificationVote.APPROVE },
        { userId: REVIEWER, vote: VerificationVote.REJECT },
      ],
      dismissals: [],
    });

    const view = await getPendingEdit(BARCODE, REVIEWER);

    expect(view).toMatchObject({
      editId: EDIT_ID,
      approvals: 1,
      rejections: 1,
      viewer: { isAuthor: false, vote: VerificationVote.REJECT, dismissed: false },
    });
    expect(view!.originalValues.image).toBe('http://assets.test/processed/abc.jpg');
  });

  it('flags the author and dismissals', async () => {
    mockEditFindFirst.mockResolvedValue({
      ...PENDING_EDIT,
      votes: [],
      dismissals: [{ id: 'dismissal-1' }],
    });

    const view = await getPendingEdit(BARCODE, AUTHOR);
    expect(view!.viewer).toEqual({ isAuthor: true, vote: null, dismissed: true });
  });
});

// ─── castEditVote + resolution ───────────────────────────────────────────────

describe('castEditVote', () => {
  it('throws EditNotFoundError for an unknown edit', async () => {
    mockTxEditFindUnique.mockResolvedValue(null);
    await expect(
      castEditVote(EDIT_ID, REVIEWER, VerificationVote.APPROVE),
    ).rejects.toBeInstanceOf(EditNotFoundError);
  });

  it('throws EditNotPendingError on a resolved edit', async () => {
    mockTxEditFindUnique.mockResolvedValue({
      ...PENDING_EDIT,
      status: ProductEditStatus.APPLIED,
    });
    await expect(
      castEditVote(EDIT_ID, REVIEWER, VerificationVote.APPROVE),
    ).rejects.toBeInstanceOf(EditNotPendingError);
  });

  it('rejects the author voting on their own edit', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    await expect(
      castEditVote(EDIT_ID, AUTHOR, VerificationVote.APPROVE),
    ).rejects.toBeInstanceOf(SelfEditVoteError);
  });

  it('maps a duplicate vote (P2002) to DuplicateEditVoteError', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    mockTxVoteCreate.mockRejectedValue(
      new FakePrismaKnownRequestError('unique violation', { code: 'P2002' }),
    );
    await expect(
      castEditVote(EDIT_ID, REVIEWER, VerificationVote.APPROVE),
    ).rejects.toBeInstanceOf(DuplicateEditVoteError);
  });

  it('keeps the edit PENDING after a single approval', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    mockTxVoteCreate.mockResolvedValue({});
    mockTxVoteFindMany.mockResolvedValue([{ vote: VerificationVote.APPROVE }]);

    const result = await castEditVote(EDIT_ID, REVIEWER, VerificationVote.APPROVE);

    expect(result).toEqual({ approvals: 1, rejections: 0, status: ProductEditStatus.PENDING });
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
    expect(mockTxEditUpdate).not.toHaveBeenCalled();
  });

  it('waits for a third voter on a 1–1 tie', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    mockTxVoteCreate.mockResolvedValue({});
    mockTxVoteFindMany.mockResolvedValue([
      { vote: VerificationVote.APPROVE },
      { vote: VerificationVote.REJECT },
    ]);

    const result = await castEditVote(EDIT_ID, REVIEWER, VerificationVote.REJECT);

    expect(result.status).toBe(ProductEditStatus.PENDING);
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
  });

  it('applies the edit on the second approval: product updated, lastModifiedByUserId set', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    mockTxVoteCreate.mockResolvedValue({});
    mockTxVoteFindMany.mockResolvedValue([
      { vote: VerificationVote.APPROVE },
      { vote: VerificationVote.APPROVE },
    ]);
    mockTxProductUpdate.mockResolvedValue({});
    mockTxEditUpdate.mockResolvedValue({});

    const result = await castEditVote(EDIT_ID, REVIEWER, VerificationVote.APPROVE);

    expect(result.status).toBe(ProductEditStatus.APPLIED);
    // Product is updated by barcode with ONLY the proposed changes + audit field.
    // submittedByUserId is untouched (original-author attribution preserved),
    // and Product.id is never part of the update -> ratings stay attached.
    expect(mockTxProductUpdate).toHaveBeenCalledWith({
      where: { barcode: BARCODE },
      data: { name: 'Sourdough Loaf', lastModifiedByUserId: AUTHOR },
    });
    expect(mockTxEditUpdate).toHaveBeenCalledWith({
      where: { id: EDIT_ID },
      data: { status: ProductEditStatus.APPLIED },
    });
  });

  it('rejects the edit on the second rejection without touching the product', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    mockTxVoteCreate.mockResolvedValue({});
    mockTxVoteFindMany.mockResolvedValue([
      { vote: VerificationVote.REJECT },
      { vote: VerificationVote.REJECT },
    ]);
    mockTxEditUpdate.mockResolvedValue({});

    const result = await castEditVote(EDIT_ID, REVIEWER, VerificationVote.REJECT);

    expect(result.status).toBe(ProductEditStatus.REJECTED);
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
    expect(mockTxEditUpdate).toHaveBeenCalledWith({
      where: { id: EDIT_ID },
      data: { status: ProductEditStatus.REJECTED },
    });
  });

  it('resolves 2 approvals vs 1 rejection as APPLIED', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    mockTxVoteCreate.mockResolvedValue({});
    mockTxVoteFindMany.mockResolvedValue([
      { vote: VerificationVote.APPROVE },
      { vote: VerificationVote.REJECT },
      { vote: VerificationVote.APPROVE },
    ]);
    mockTxProductUpdate.mockResolvedValue({});
    mockTxEditUpdate.mockResolvedValue({});

    const result = await castEditVote(EDIT_ID, REVIEWER, VerificationVote.APPROVE);
    expect(result.status).toBe(ProductEditStatus.APPLIED);
  });
});

// ─── retractEditVote ─────────────────────────────────────────────────────────

describe('retractEditVote', () => {
  it('throws EditNotFoundError for an unknown edit', async () => {
    mockTxEditFindUnique.mockResolvedValue(null);
    await expect(retractEditVote(EDIT_ID, REVIEWER)).rejects.toBeInstanceOf(EditNotFoundError);
  });

  it('throws EditNotPendingError when the edit is resolved', async () => {
    mockTxEditFindUnique.mockResolvedValue({
      ...PENDING_EDIT,
      status: ProductEditStatus.REJECTED,
    });
    await expect(retractEditVote(EDIT_ID, REVIEWER)).rejects.toBeInstanceOf(EditNotPendingError);
  });

  it('throws EditVoteNotFoundError when the caller has no vote', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    mockTxVoteDeleteMany.mockResolvedValue({ count: 0 });
    await expect(retractEditVote(EDIT_ID, REVIEWER)).rejects.toBeInstanceOf(
      EditVoteNotFoundError,
    );
  });

  it('deletes the vote and returns the fresh tally', async () => {
    mockTxEditFindUnique.mockResolvedValue(PENDING_EDIT);
    mockTxVoteDeleteMany.mockResolvedValue({ count: 1 });
    mockTxVoteFindMany.mockResolvedValue([{ vote: VerificationVote.REJECT }]);

    const result = await retractEditVote(EDIT_ID, REVIEWER);

    expect(mockTxVoteDeleteMany).toHaveBeenCalledWith({
      where: { editId: EDIT_ID, userId: REVIEWER },
    });
    expect(result).toEqual({ approvals: 0, rejections: 1, status: ProductEditStatus.PENDING });
  });
});

// ─── dismissEdit ─────────────────────────────────────────────────────────────

describe('dismissEdit', () => {
  it('throws EditNotFoundError for an unknown edit', async () => {
    mockEditFindUnique.mockResolvedValue(null);
    await expect(dismissEdit(EDIT_ID, REVIEWER)).rejects.toBeInstanceOf(EditNotFoundError);
  });

  it('upserts the dismissal (idempotent)', async () => {
    mockEditFindUnique.mockResolvedValue({ id: EDIT_ID });
    mockDismissalUpsert.mockResolvedValue({});

    await dismissEdit(EDIT_ID, REVIEWER);

    expect(mockDismissalUpsert).toHaveBeenCalledWith({
      where: { editId_userId: { editId: EDIT_ID, userId: REVIEWER } },
      update: {},
      create: { editId: EDIT_ID, userId: REVIEWER },
    });
  });
});

// ─── expireStaleEdits ────────────────────────────────────────────────────────

describe('expireStaleEdits', () => {
  it('expires voteless PENDING edits past their expiresAt', async () => {
    mockEditUpdateMany.mockResolvedValue({ count: 3 });
    const now = new Date('2026-07-03T00:00:00Z');

    const count = await expireStaleEdits(now);

    expect(count).toBe(3);
    expect(mockEditUpdateMany).toHaveBeenCalledWith({
      where: {
        status: ProductEditStatus.PENDING,
        expiresAt: { lt: now },
        votes: { none: {} },
      },
      data: { status: ProductEditStatus.EXPIRED },
    });
  });
});
