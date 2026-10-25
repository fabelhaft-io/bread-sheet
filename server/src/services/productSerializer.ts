import { resolveImageUrl } from './imageService.js';
import { ProductStatus } from '../generated/prisma_client/enums.js';
import type { VisibilityUser } from './productVisibility.js';

/**
 * TICKET-P6-009 decision 2 — an explicit allowlist, not a spread.
 *
 * The pre-split `getProductByBarcode` spread the whole Prisma row
 * (`...cached`), so every new column was public by default — an internal
 * column (P6-007's `nameKey`, P6-005's OFF-sync state) would have reached
 * clients by accident and become an API contract nobody chose. This is the
 * single place that decides what a product response looks like.
 */

const PACKAGED_ALLOWLIST = [
  'gtin',
  'genericName',
  'energyKcal',
  'fat',
  'saturatedFat',
  'carbohydrates',
  'sugars',
  'protein',
  'salt',
  'servingSize',
  'ingredients',
] as const;

export interface SerializablePackaged {
  gtin: string;
  genericName: string | null;
  energyKcal: number | null;
  fat: number | null;
  saturatedFat: number | null;
  carbohydrates: number | null;
  sugars: number | null;
  protein: number | null;
  salt: number | null;
  servingSize: string | null;
  ingredients: string | null;
}

export interface SerializableProduct {
  id: string;
  kind: string;
  name: string;
  brand: string | null;
  image: string | null;
  description: string | null;
  status: ProductStatus;
  submittedByUserId: string | null;
  packaged: SerializablePackaged | null;
}

export type SerializedPackaged = Pick<
  SerializablePackaged,
  (typeof PACKAGED_ALLOWLIST)[number]
>;

export interface SerializedProduct {
  id: string;
  kind: string;
  name: string;
  brand: string | null;
  image: string | null;
  description: string | null;
  status: ProductStatus;
  unverified: boolean;
  submittedByUserId?: string | null;
  packaged: SerializedPackaged | null;
  submission?: {
    name: string;
    brand: string | null;
  } & Partial<Omit<SerializedPackaged, 'gtin'>>;
}

function serializePackaged(
  packaged: SerializablePackaged | null,
): SerializedPackaged | null {
  if (!packaged) return null;
  const out = {} as Record<string, unknown>;
  for (const field of PACKAGED_ALLOWLIST) {
    out[field] = packaged[field] ?? null;
  }
  return out as SerializedPackaged;
}

/**
 * Serializes a `Product` row (with its `packaged` relation already loaded,
 * or `null` for a CUSTOM product) into the one shape every product-reading
 * endpoint returns: `{ id, kind, name, brand, image, description, status,
 * unverified, submittedByUserId?, packaged, submission? }`.
 */
export function serializeProduct(
  product: SerializableProduct,
  user?: VisibilityUser,
): SerializedProduct {
  const unverified = product.status !== ProductStatus.VERIFIED;
  const packaged = serializePackaged(product.packaged);

  const serialized: SerializedProduct = {
    id: product.id,
    kind: product.kind,
    name: product.name,
    brand: product.brand,
    image: resolveImageUrl(product.image),
    description: product.description,
    status: product.status,
    unverified,
    packaged,
  };

  // `submittedByUserId` exists for the registered client's "don't show me a
  // banner for my own submission" check (P5-007). Anonymous users cannot
  // submit, so it has no purpose for them — and it would hand a user UUID,
  // linked to a piece of content, to an unauthenticated session
  // (docs/architecture/data.md §5.4).
  if (!user?.isAnonymous) {
    serialized.submittedByUserId = product.submittedByUserId;
  }

  if (unverified) {
    serialized.submission = {
      name: product.name,
      brand: product.brand,
      ...(packaged
        ? {
            genericName: packaged.genericName,
            energyKcal: packaged.energyKcal,
            fat: packaged.fat,
            saturatedFat: packaged.saturatedFat,
            carbohydrates: packaged.carbohydrates,
            sugars: packaged.sugars,
            protein: packaged.protein,
            salt: packaged.salt,
            servingSize: packaged.servingSize,
            ingredients: packaged.ingredients,
          }
        : {}),
    };
  }

  return serialized;
}
