import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTxProductFindUnique = vi.hoisted(() => vi.fn());
const mockTxProductUpdate = vi.hoisted(() => vi.fn());
const mockTxVerificationUpsert = vi.hoisted(() => vi.fn());
const mockTxVerificationFindMany = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() =>
  vi.fn(
    async <T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T> => {
      const tx = {
        product: {
          findUnique: mockTxProductFindUnique,
          update: mockTxProductUpdate,
        },
        productVerification: {
          upsert: mockTxVerificationUpsert,
          findMany: mockTxVerificationFindMany,
        },
      };
      return fn(tx);
    },
  ),
);

vi.mock('../db.js', () => ({
  default: { $transaction: mockTransaction },
}));

import {
  castVote,
  ProductNotFoundError,
  ProductNotPendingError,
  SelfVerificationError,
} from './productVerificationService.js';
import { ProductStatus, VerificationVote } from '../generated/prisma_client/enums.js';

const BARCODE = '1234567890123';
const PRODUCT_ID = 'product-1';
const USER_ID = 'reviewer-1';

const PENDING_PRODUCT = {
  id: PRODUCT_ID,
  barcode: BARCODE,
  status: ProductStatus.PENDING_REVIEW,
  submittedByUserId: 'submitter-1',
};

function makeVotes(...votes: VerificationVote[]) {
  return votes.map((vote) => ({ vote }));
}

describe('castVote', () => {
  beforeEach(() => {
    mockTxProductFindUnique.mockReset();
    mockTxProductUpdate.mockReset();
    mockTxVerificationUpsert.mockReset();
    mockTxVerificationFindMany.mockReset();
    mockTransaction.mockClear();
  });

  it('throws ProductNotFoundError when the barcode does not exist', async () => {
    mockTxProductFindUnique.mockResolvedValue(null);
    await expect(castVote(BARCODE, USER_ID, VerificationVote.APPROVE))
      .rejects.toBeInstanceOf(ProductNotFoundError);
    expect(mockTxVerificationUpsert).not.toHaveBeenCalled();
  });

  it('throws ProductNotPendingError when the product is VERIFIED', async () => {
    mockTxProductFindUnique.mockResolvedValue({ ...PENDING_PRODUCT, status: ProductStatus.VERIFIED });
    await expect(castVote(BARCODE, USER_ID, VerificationVote.APPROVE))
      .rejects.toBeInstanceOf(ProductNotPendingError);
    expect(mockTxVerificationUpsert).not.toHaveBeenCalled();
  });

  it('throws ProductNotPendingError when the product is REJECTED', async () => {
    mockTxProductFindUnique.mockResolvedValue({ ...PENDING_PRODUCT, status: ProductStatus.REJECTED });
    await expect(castVote(BARCODE, USER_ID, VerificationVote.APPROVE))
      .rejects.toBeInstanceOf(ProductNotPendingError);
    expect(mockTxVerificationUpsert).not.toHaveBeenCalled();
  });

  it('throws SelfVerificationError when the caller is the product submitter', async () => {
    mockTxProductFindUnique.mockResolvedValue({ ...PENDING_PRODUCT, submittedByUserId: USER_ID });
    await expect(castVote(BARCODE, USER_ID, VerificationVote.APPROVE))
      .rejects.toBeInstanceOf(SelfVerificationError);
    expect(mockTxVerificationUpsert).not.toHaveBeenCalled();
  });

  it('upserts the vote and returns current approval count below threshold', async () => {
    mockTxProductFindUnique.mockResolvedValue(PENDING_PRODUCT);
    mockTxVerificationUpsert.mockResolvedValue({});
    mockTxVerificationFindMany.mockResolvedValue(makeVotes(VerificationVote.APPROVE));

    const result = await castVote(BARCODE, USER_ID, VerificationVote.APPROVE);

    expect(result).toEqual({ verifications: 1, status: ProductStatus.PENDING_REVIEW });
    expect(mockTxVerificationUpsert).toHaveBeenCalledWith({
      where: { productId_userId: { productId: PRODUCT_ID, userId: USER_ID } },
      update: { vote: VerificationVote.APPROVE },
      create: { productId: PRODUCT_ID, userId: USER_ID, vote: VerificationVote.APPROVE },
    });
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
  });

  it('flips to VERIFIED when 2 approvals, 0 rejections', async () => {
    mockTxProductFindUnique.mockResolvedValue(PENDING_PRODUCT);
    mockTxVerificationUpsert.mockResolvedValue({});
    mockTxVerificationFindMany.mockResolvedValue(
      makeVotes(VerificationVote.APPROVE, VerificationVote.APPROVE),
    );
    mockTxProductUpdate.mockResolvedValue({});

    const result = await castVote(BARCODE, USER_ID, VerificationVote.APPROVE);

    expect(result.status).toBe(ProductStatus.VERIFIED);
    expect(result.verifications).toBe(2);
    expect(mockTxProductUpdate).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID },
      data: { status: ProductStatus.VERIFIED },
    });
  });

  it('flips to VERIFIED when 2 approvals, 1 rejection (net positive)', async () => {
    mockTxProductFindUnique.mockResolvedValue(PENDING_PRODUCT);
    mockTxVerificationUpsert.mockResolvedValue({});
    mockTxVerificationFindMany.mockResolvedValue(
      makeVotes(VerificationVote.APPROVE, VerificationVote.APPROVE, VerificationVote.REJECT),
    );
    mockTxProductUpdate.mockResolvedValue({});

    const result = await castVote(BARCODE, USER_ID, VerificationVote.APPROVE);

    expect(result.status).toBe(ProductStatus.VERIFIED);
    expect(result.verifications).toBe(2);
  });

  it('stays PENDING_REVIEW when 2 approvals and 2 rejections (tied)', async () => {
    mockTxProductFindUnique.mockResolvedValue(PENDING_PRODUCT);
    mockTxVerificationUpsert.mockResolvedValue({});
    mockTxVerificationFindMany.mockResolvedValue(
      makeVotes(
        VerificationVote.APPROVE,
        VerificationVote.APPROVE,
        VerificationVote.REJECT,
        VerificationVote.REJECT,
      ),
    );

    const result = await castVote(BARCODE, USER_ID, VerificationVote.REJECT);

    expect(result.status).toBe(ProductStatus.PENDING_REVIEW);
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
  });

  it('flips to REJECTED when 2 rejections, 1 approval', async () => {
    mockTxProductFindUnique.mockResolvedValue(PENDING_PRODUCT);
    mockTxVerificationUpsert.mockResolvedValue({});
    mockTxVerificationFindMany.mockResolvedValue(
      makeVotes(VerificationVote.REJECT, VerificationVote.REJECT, VerificationVote.APPROVE),
    );
    mockTxProductUpdate.mockResolvedValue({});

    const result = await castVote(BARCODE, USER_ID, VerificationVote.REJECT);

    expect(result.status).toBe(ProductStatus.REJECTED);
    expect(result.verifications).toBe(1);
    expect(mockTxProductUpdate).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID },
      data: { status: ProductStatus.REJECTED },
    });
  });

  it('stays PENDING_REVIEW when 1 approval and 1 rejection (below threshold)', async () => {
    mockTxProductFindUnique.mockResolvedValue(PENDING_PRODUCT);
    mockTxVerificationUpsert.mockResolvedValue({});
    mockTxVerificationFindMany.mockResolvedValue(
      makeVotes(VerificationVote.APPROVE, VerificationVote.REJECT),
    );

    const result = await castVote(BARCODE, USER_ID, VerificationVote.REJECT);

    expect(result.status).toBe(ProductStatus.PENDING_REVIEW);
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
  });
});