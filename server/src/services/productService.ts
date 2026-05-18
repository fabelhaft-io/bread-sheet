import { ProductStatus } from '../generated/prisma_client/enums.js';
import prisma from '../db.js';
import { Prisma } from '../generated/prisma_client/client.js';
const OFF_API = 'https://world.openfoodfacts.org/api/v2/product';

interface OFFResponse {
  status: number;
  product?: {
    product_name?: string;
    brands?: string;
    image_url?: string;
    generic_name?: string;
  };
}

export interface ProductData {
  barcode: string;
  name: string;
  brand: string | null;
  image: string | null;
  description: string | null;
}

// Returns null if the product does not exist in OFF.
// Throws if the OFF API itself is unavailable or returns an error.
export async function fetchFromOpenFoodFacts(
  barcode: string,
): Promise<ProductData | null> {
  const res = await fetch(
    `${OFF_API}/${barcode}?fields=product_name,brands,image_url,generic_name`,
    {
      signal: AbortSignal.timeout(5000),
    },
  );

  // OFF returns 404 when the barcode is not in its catalogue. That's an expected
  // outcome — surface it as `null` so the caller can fall through to the
  // user-submission flow. Other non-OK statuses (5xx, etc.) are genuine failures.
  if (res.status === 404) return null;

  if (!res.ok) {
    throw new Error(
      `Open Food Facts API error: ${res.status} ${res.statusText}`,
    );
  }

  const data = (await res.json()) as OFFResponse;

  if (data.status !== 1 || !data.product) return null;

  const { product } = data;

  return {
    barcode,
    name: product.product_name?.trim() || 'Unknown Product',
    brand: product.brands?.trim() || null,
    image: product.image_url || null,
    description: product.generic_name?.trim() || null,
  };
}

export interface ProductSubmissionInput {
  barcode: string;
  name: string;
  brand: string | null;
  genericName: string | null;
  energyKcal: number | null;
  carbohydrates: number | null;
  fat: number | null;
  protein: number | null;
  salt: number | null;
  servingSize: string | null;
  productImageUrl: string;
  ingredients: string | null;
}

export type SubmissionAction = 'created' | 'updated';

export interface CreateSubmittedProductResult {
  action: SubmissionAction;
  product: {
    barcode: string;
    status: ProductStatus;
  };
}

export class ProductAlreadyVerifiedError extends Error {
  readonly code = 'product_already_verified';
  constructor(public readonly barcode: string) {
    super(`Product ${barcode} is already verified`);
  }
}

export class ProductPendingByAnotherUserError extends Error {
  readonly code = 'submission_pending';
  constructor(public readonly barcode: string) {
    super(`Product ${barcode} has a pending submission by another user`);
  }
}

export class ProductPreviouslyRejectedError extends Error {
  readonly code = 'product_previously_rejected';
  constructor(public readonly barcode: string) {
    super(`Product ${barcode} was rejected; original submitter cannot re-submit`);
  }
}

// Persist user-generated product submission
export async function createSubmittedProduct(
  payload: ProductSubmissionInput,
  userId: string,
): Promise<CreateSubmittedProductResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({
        where: { barcode: payload.barcode },
      });

      if (existing && existing.status === ProductStatus.VERIFIED) {
        throw new ProductAlreadyVerifiedError(payload.barcode);
      }

      // Branch 2: barcode was REJECTED by peers.
      // Other users may overwrite with a fresh submission; the original submitter is blocked
      if (existing && existing.status === ProductStatus.REJECTED) {
        if (existing.submittedByUserId === userId) {
          throw new ProductPreviouslyRejectedError(payload.barcode);
        }

        // reset votes
        await tx.productVerification.deleteMany({
          where: { productId: existing.id },
        });

        // Re-use the same Product row (preserves the `id` and any historical
        // ratings on it) but reset every other field to the new submitter's data.
        const resubmitted = await tx.product.update({
          where: { id: existing.id },
          data: {
            ...mapPayloadToProduct(payload),
            status: ProductStatus.PENDING_REVIEW,
            submittedByUserId: userId,
          },
        });

        return {
          action: 'updated' as const,
          product: { barcode: resubmitted.barcode, status: resubmitted.status },
        };
      }

      // Branch 3: barcode has a pending submission from someone else → 409
      if (
        existing &&
        existing.status === ProductStatus.PENDING_REVIEW &&
        existing.submittedByUserId !== userId
      ) {
        throw new ProductPendingByAnotherUserError(payload.barcode);
      }

      // Branch 4: same user re-submitting their own pending product → UPDATE
      if (
        existing &&
        existing.status === ProductStatus.PENDING_REVIEW &&
        existing.submittedByUserId === userId
      ) {
        // reset votes
        await tx.productVerification.deleteMany({
          where: { productId: existing.id },
        });

        const updated = await tx.product.update({
          where: { id: existing.id },
          data: mapPayloadToProduct(payload),
        });
        return {
          action: 'updated' as const,
          product: { barcode: updated.barcode, status: updated.status },
        };
      }

      // Branch 5: brand-new barcode → CREATE
      const created = await tx.product.create({
        data: {
          barcode: payload.barcode,
          ...mapPayloadToProduct(payload),
          status: ProductStatus.PENDING_REVIEW,
          submittedByUserId: userId,
        },
      });
      return {
        action: 'created' as const,
        product: { barcode: created.barcode, status: created.status },
      };
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ProductPendingByAnotherUserError(payload.barcode);
    }
    throw err;
  }
}

function mapPayloadToProduct(payload: ProductSubmissionInput) {
  return {
    name: payload.name,
    brand: payload.brand,
    image: payload.productImageUrl, // wire `productImageUrl` → schema `image`
    genericName: payload.genericName,
    energyKcal: payload.energyKcal,
    carbohydrates: payload.carbohydrates,
    fat: payload.fat,
    protein: payload.protein,
    salt: payload.salt,
    servingSize: payload.servingSize,
    ingredients: payload.ingredients,
  };
}