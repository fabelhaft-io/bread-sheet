import { ProductKind, ProductStatus } from '../generated/prisma_client/enums.js';
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
  gtin: string;
  name: string;
  brand: string | null;
  image: string | null;
  description: string | null;
}

// Returns null if the GTIN does not exist in OFF.
// Throws if the OFF API itself is unavailable or returns an error.
export async function fetchFromOpenFoodFacts(
  gtin: string,
): Promise<ProductData | null> {
  const res = await fetch(
    `${OFF_API}/${gtin}?fields=product_name,brands,image_url,generic_name`,
    {
      signal: AbortSignal.timeout(5000),
    },
  );

  // OFF returns 404 when the GTIN is not in its catalogue. That's an expected
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
    gtin,
    name: product.product_name?.trim() || 'Unknown Product',
    brand: product.brands?.trim() || null,
    image: product.image_url || null,
    description: product.generic_name?.trim() || null,
  };
}

export interface ProductSubmissionInput {
  gtin: string;
  name: string;
  brand: string | null;
  genericName: string | null;
  energyKcal: number | null;
  fat: number | null;
  saturatedFat: number | null;
  carbohydrates: number | null;
  sugars: number | null;
  protein: number | null;
  salt: number | null;
  servingSize: string | null;
  /** S3 object key (`processed/{uuid}.jpg`) issued by POST /upload-image. */
  productImageKey: string;
  ingredients: string | null;
}

export type SubmissionAction = 'created' | 'updated';

export interface CreateSubmittedProductResult {
  action: SubmissionAction;
  product: {
    id: string;
    gtin: string;
    status: ProductStatus;
  };
}

export class ProductAlreadyVerifiedError extends Error {
  readonly code = 'product_already_verified';
  constructor(public readonly gtin: string) {
    super(`Product ${gtin} is already verified`);
  }
}

export class ProductPendingByAnotherUserError extends Error {
  readonly code = 'submission_pending';
  constructor(public readonly gtin: string) {
    super(`Product ${gtin} has a pending submission by another user`);
  }
}

export class ProductPreviouslyRejectedError extends Error {
  readonly code = 'product_previously_rejected';
  constructor(public readonly gtin: string) {
    super(`Product ${gtin} was rejected; original submitter cannot re-submit`);
  }
}

// Persist a user-generated PACKAGED product submission. Writes the `Product`
// and `PackagedProduct` rows in one transaction (ADR 0006): a failure leaves
// neither behind.
export async function createSubmittedProduct(
  payload: ProductSubmissionInput,
  userId: string,
): Promise<CreateSubmittedProductResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existingPackaged = await tx.packagedProduct.findUnique({
        where: { gtin: payload.gtin },
        include: { product: true },
      });
      const existing = existingPackaged?.product ?? null;

      if (existing && existing.status === ProductStatus.VERIFIED) {
        throw new ProductAlreadyVerifiedError(payload.gtin);
      }

      // Branch 2: GTIN was REJECTED by peers.
      // Other users may overwrite with a fresh submission; the original submitter is blocked
      if (existing && existing.status === ProductStatus.REJECTED) {
        if (existing.submittedByUserId === userId) {
          throw new ProductPreviouslyRejectedError(payload.gtin);
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
            ...toProductData(payload),
            status: ProductStatus.PENDING_REVIEW,
            submittedByUserId: userId,
          },
        });
        await tx.packagedProduct.update({
          where: { productId: existing.id },
          data: toPackagedData(payload),
        });

        return {
          action: 'updated' as const,
          product: { id: resubmitted.id, gtin: payload.gtin, status: resubmitted.status },
        };
      }

      // Branch 3: GTIN has a pending submission from someone else → 409
      if (
        existing &&
        existing.status === ProductStatus.PENDING_REVIEW &&
        existing.submittedByUserId !== userId
      ) {
        throw new ProductPendingByAnotherUserError(payload.gtin);
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
          data: toProductData(payload),
        });
        await tx.packagedProduct.update({
          where: { productId: existing.id },
          data: toPackagedData(payload),
        });
        return {
          action: 'updated' as const,
          product: { id: updated.id, gtin: payload.gtin, status: updated.status },
        };
      }

      // Branch 5: brand-new GTIN → CREATE both rows
      const created = await tx.product.create({
        data: {
          kind: ProductKind.PACKAGED,
          ...toProductData(payload),
          status: ProductStatus.PENDING_REVIEW,
          submittedByUserId: userId,
        },
      });
      await tx.packagedProduct.create({
        data: {
          productId: created.id,
          gtin: payload.gtin,
          ...toPackagedData(payload),
        },
      });
      return {
        action: 'created' as const,
        product: { id: created.id, gtin: payload.gtin, status: created.status },
      };
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ProductPendingByAnotherUserError(payload.gtin);
    }
    throw err;
  }
}

function toProductData(payload: ProductSubmissionInput) {
  return {
    name: payload.name,
    brand: payload.brand,
    image: payload.productImageKey, // wire `productImageKey` → schema `image` (key, resolved to a URL at read time)
  };
}

function toPackagedData(payload: ProductSubmissionInput) {
  return {
    genericName: payload.genericName,
    energyKcal: payload.energyKcal,
    fat: payload.fat,
    saturatedFat: payload.saturatedFat,
    carbohydrates: payload.carbohydrates,
    sugars: payload.sugars,
    protein: payload.protein,
    salt: payload.salt,
    servingSize: payload.servingSize,
    ingredients: payload.ingredients,
  };
}
