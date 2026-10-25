import prisma from '../db.js';
import { ProductStatus, VerificationVote } from '../generated/prisma_client/enums.js';
import { ProductNotFoundError, visibleProductWhere } from './productVisibility.js';

export { ProductNotFoundError };

export class ProductNotPendingError extends Error {
  readonly code = 'product_not_pending';
  constructor(productId: string) {
    super(`Product ${productId} is not in PENDING_REVIEW state`);
  }
}

export class SelfVerificationError extends Error {
  readonly code = 'self_verification';
  constructor() {
    super('Submitters cannot verify their own product');
  }
}

export interface CastVoteResult {
  verifications: number;
  status: ProductStatus;
}

export async function castVote(
  productId: string,
  userId: string,
  vote: VerificationVote,
): Promise<CastVoteResult> {
  return prisma.$transaction(async (tx) => {
    // `visibleProductWhere` filters out REJECTED rows, so a vote on an
    // already-rejected product 404s (ADR 0006 visibility rule) rather than
    // falling through to the "not pending" 409 below.
    const product = await tx.product.findFirst({
      where: { id: productId, ...visibleProductWhere() },
    });

    if (!product) throw new ProductNotFoundError(productId);
    if (product.status !== ProductStatus.PENDING_REVIEW) throw new ProductNotPendingError(productId);
    if (product.submittedByUserId === userId) throw new SelfVerificationError();

    await tx.productVerification.upsert({
      where: { productId_userId: { productId: product.id, userId } },
      update: { vote },
      create: { productId: product.id, userId, vote },
    });

    const votes = await tx.productVerification.findMany({
      where: { productId: product.id },
    });

    const approvals = votes.filter((v) => v.vote === VerificationVote.APPROVE).length;
    const rejections = votes.filter((v) => v.vote === VerificationVote.REJECT).length;

    let newStatus: ProductStatus = product.status;

    if (approvals >= 2 && approvals > rejections) {
      newStatus = ProductStatus.VERIFIED;
      await tx.product.update({ where: { id: product.id }, data: { status: ProductStatus.VERIFIED } });
      // TODO(P5-003-followup): enqueue OFF sync here
    } else if (rejections >= 2 && rejections > approvals) {
      newStatus = ProductStatus.REJECTED;
      await tx.product.update({ where: { id: product.id }, data: { status: ProductStatus.REJECTED } });
    }

    return { verifications: approvals, status: newStatus };
  });
}
