import prisma from '../db.js';
import { Prisma } from '../generated/prisma_client/client.js';
import { ProductStatus } from '../generated/prisma_client/enums.js';

/**
 * TICKET-P6-009 / ADR 0006 — one visibility rule, one implementation.
 *
 * Every read of `Product` (both PACKAGED and CUSTOM kinds) goes through this
 * module instead of re-typing a `where` clause. Today the rule is P5-007's:
 * `REJECTED` is invisible to every caller, registered or anonymous.
 * Catalogue-only queries (OFF sync, OFF backfill) filter on `kind: PACKAGED`
 * explicitly instead of using this helper — that is a different axis
 * (manufactured-article-ness), not visibility.
 */

export class ProductNotFoundError extends Error {
  readonly code = 'product_not_found';
  constructor(public readonly productId: string) {
    super(`Product ${productId} not found`);
  }
}

export interface VisibilityUser {
  isAnonymous?: boolean;
}

/** The P5-007 rule, unchanged by the split: `REJECTED` is invisible. */
export function visibleProductWhere(
  _user?: VisibilityUser,
): Prisma.ProductWhereInput {
  return { status: { not: ProductStatus.REJECTED } };
}

/**
 * The same rule as `visibleProductWhere`, as a predicate over an
 * already-fetched row instead of a Prisma `where` clause. For the handful of
 * read paths that must distinguish "truly missing" from "exists but
 * invisible" (e.g. `getProductByGtin`, which must not fall through to an
 * Open Food Facts re-fetch — and a `P2002` on an existing GTIN — for a
 * `REJECTED` row), fetch unfiltered and check this instead of re-typing
 * `status === 'REJECTED'` inline.
 */
export function isProductVisible(
  product: { status: ProductStatus },
  _user?: VisibilityUser,
): boolean {
  return product.status !== ProductStatus.REJECTED;
}

/**
 * Throws `ProductNotFoundError` (→ 404 in every controller) unless `id`
 * resolves to a product visible to `user` — i.e. it exists and is not
 * REJECTED.
 */
export async function assertProductVisible(
  user: VisibilityUser | undefined,
  id: string,
): Promise<void> {
  const product = await prisma.product.findFirst({
    where: { id, ...visibleProductWhere(user) },
    select: { id: true },
  });
  if (!product) throw new ProductNotFoundError(id);
}
