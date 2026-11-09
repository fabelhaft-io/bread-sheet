import prisma from '../db.js';
import { Prisma } from '../generated/prisma_client/client.js';
import { ProductKind, ProductStatus } from '../generated/prisma_client/enums.js';
import { normalizeProductName } from './nameNormalization.js';
import { PackagedFieldNotAllowedError } from '../validators/customProductValidator.js';

/**
 * TICKET-P6-007 — custom products (`Product.kind === CUSTOM`, no
 * `PackagedProduct` row — ADR 0006). Shares the same lifecycle as a
 * user-submitted packaged product (creation → PENDING_REVIEW, peer
 * verification, editing) with one difference: identity is the name alone,
 * enforced by the hand-written partial unique index
 * `custom_product_name_unique` (see the `custom_products` migration) on top
 * of the pre-check this module exposes.
 *
 * The **editable fields for a custom product are `name` and the photo**
 * (ADR 0006 / the ticket's decision 2) — never `brand` (always null; a
 * custom product has no brand) and never any `PackagedProduct`-only field
 * (there is no row to hold them). `PackagedFieldNotAllowedError` (defined in
 * `../validators/customProductValidator.js`, re-exported here so every other
 * caller — `productEditController`, `productEditService` — has one import
 * path) is thrown by the validators and by `productEditService`'s
 * CUSTOM-aware checks wherever a caller supplies a field outside that set.
 */

export { PackagedFieldNotAllowedError };

export class DuplicateCustomProductNameError extends Error {
  readonly code = 'duplicate_name';
  constructor(
    message: string,
    public readonly productId: string,
  ) {
    super(message);
  }
}

/**
 * Narrow structural type — only the one method actually used — so this
 * accepts both the top-level `prisma` client and a `$transaction` callback's
 * `tx` (and a minimal test double) without requiring either to implement
 * every `Product` delegate method.
 */
type ProductReadClient = { product: Pick<typeof prisma.product, 'findFirst'> };

/**
 * Finds a visible (non-REJECTED) CUSTOM product sharing `nameKey`, excluding
 * `excludeId` (used by a rename check, which must not collide with itself).
 * Shared by the create path (post-P2002 lookup) and by `productEditService`'s
 * rename checks on both the PATCH correction and the edit-proposal flows, so
 * every caller agrees on exactly what counts as "the same name".
 */
export async function findCustomProductNameCollision(
  client: ProductReadClient,
  nameKey: string,
  excludeId?: string,
) {
  return client.product.findFirst({
    where: {
      nameKey,
      kind: ProductKind.CUSTOM,
      status: { not: ProductStatus.REJECTED },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
}

export interface CreateCustomProductInput {
  name: string;
  imageKey: string | null;
}

export interface CreateCustomProductResult {
  id: string;
  status: ProductStatus;
}

/**
 * POST /api/custom-products. Creates a `Product` row with `kind: CUSTOM`,
 * `status: PENDING_REVIEW`, no `PackagedProduct` row, and `brand: null`
 * (identity is the name alone). Races on the same normalised name are
 * resolved by the database (`custom_product_name_unique`): the loser's
 * insert throws P2002, caught here and turned into a friendly `409
 * duplicate_name` carrying the id of the row that won the race.
 */
export async function createCustomProduct(
  input: CreateCustomProductInput,
  userId: string,
): Promise<CreateCustomProductResult> {
  const nameKey = normalizeProductName(input.name);

  try {
    const product = await prisma.product.create({
      data: {
        kind: ProductKind.CUSTOM,
        name: input.name,
        brand: null,
        image: input.imageKey,
        status: ProductStatus.PENDING_REVIEW,
        submittedByUserId: userId,
        nameKey,
      },
    });
    return { id: product.id, status: product.status };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await findCustomProductNameCollision(prisma, nameKey);
      if (existing) {
        throw new DuplicateCustomProductNameError(
          `A custom product named "${input.name}" already exists`,
          existing.id,
        );
      }
    }
    throw err;
  }
}
