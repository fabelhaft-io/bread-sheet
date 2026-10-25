import prisma from '../db.js';
import { Prisma } from '../generated/prisma_client/client.js';
import {
  ProductEditStatus,
  ProductKind,
  ProductStatus,
  VerificationVote,
} from '../generated/prisma_client/enums.js';
import type { ProductCorrectionInput } from '../validators/productSubmissionValidator.js';
import { ProductNotFoundError, assertProductVisible, visibleProductWhere } from './productVisibility.js';
import { resolveImageUrl } from './imageService.js';

export { ProductNotFoundError };

/**
 * TICKET-P5-006 — Product Editing & Peer-Review of Changes.
 * TICKET-P6-009 — re-keyed from `barcode` to `Product.id`; the editable
 * fields are now partitioned across `Product` and `PackagedProduct` (ADR
 * 0006), so applying a correction or an edit writes both tables in one
 * transaction. The stored `originalValues`/`proposedChanges` JSON stays flat,
 * keyed by field name, regardless of which table the field lives on.
 *
 * Registered users propose corrections to VERIFIED products. Changes are not
 * applied immediately: two other registered users must approve the diff first.
 * The PENDING_REVIEW correction path (`correctPendingProduct`) is the only
 * shortcut, and it only applies while the product hasn't been verified yet.
 */

/** How long a voteless PENDING edit lives before the cleanup job expires it. */
export const EDIT_EXPIRY_YEARS = 2;

/** `Product` columns an edit may change. `image` carries a server-issued upload key. */
export const PRODUCT_EDIT_FIELDS = ['name', 'brand', 'image'] as const;

/** `PackagedProduct` columns an edit may change. No label fields exist for CUSTOM products. */
export const PACKAGED_EDIT_FIELDS = [
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

export const EDITABLE_FIELDS = [
  ...PRODUCT_EDIT_FIELDS,
  ...PACKAGED_EDIT_FIELDS,
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type EditChanges = Partial<Record<EditableField, string | number | null>>;

export class ProductNotVerifiedError extends Error {
  readonly code = 'product_not_verified';
  constructor(productId: string) {
    super(`Product ${productId} is not VERIFIED; use the correction flow instead`);
  }
}

export class ProductIsVerifiedError extends Error {
  readonly code = 'product_verified';
  constructor(productId: string) {
    super(`Product ${productId} is VERIFIED; propose an edit instead`);
  }
}

export class PendingEditExistsError extends Error {
  readonly code = 'edit_pending';
  constructor(productId: string) {
    super(`Product ${productId} already has an edit under review`);
  }
}

export class EditNotFoundError extends Error {
  readonly code = 'edit_not_found';
  constructor(editId: string) {
    super(`Edit ${editId} not found`);
  }
}

export class EditNotPendingError extends Error {
  readonly code = 'edit_not_pending';
  constructor(editId: string) {
    super(`Edit ${editId} is no longer pending`);
  }
}

export class SelfEditVoteError extends Error {
  readonly code = 'self_edit_vote';
  constructor() {
    super('Authors cannot vote on their own edit');
  }
}

export class DuplicateEditVoteError extends Error {
  readonly code = 'duplicate_vote';
  constructor() {
    super('You have already voted on this edit');
  }
}

export class EditVoteNotFoundError extends Error {
  readonly code = 'vote_not_found';
  constructor() {
    super('No vote to retract');
  }
}

export class NoChangesError extends Error {
  readonly code = 'no_changes';
  constructor() {
    super('The proposed edit does not change any field');
  }
}

type MergedRecord = Record<EditableField, string | number | null> & { id: string };

interface ProductWithPackaged {
  id: string;
  kind: string;
  name: string;
  brand: string | null;
  image: string | null;
  packaged: Record<string, unknown> | null;
}

/** Merges a product's own columns with its `packaged` relation into one flat record keyed by `EditableField`. */
function mergeEditableFields(product: ProductWithPackaged): MergedRecord {
  const packaged = product.packaged ?? {};
  const merged: Record<string, unknown> = {
    id: product.id,
    name: product.name,
    brand: product.brand,
    image: product.image,
  };
  for (const field of PACKAGED_EDIT_FIELDS) {
    merged[field] = (packaged as Record<string, unknown>)[field] ?? null;
  }
  return merged as MergedRecord;
}

function snapshotEditableFields(merged: MergedRecord): EditChanges {
  const snapshot: EditChanges = {};
  for (const field of EDITABLE_FIELDS) snapshot[field] = merged[field] ?? null;
  return snapshot;
}

/**
 * Narrows a stored `proposedChanges` JSON object into the `Product` and
 * `PackagedProduct` update inputs it spans. The runtime shape is guaranteed
 * by the edit validator at proposal time; the cast re-asserts what the JSON
 * column's static type cannot carry.
 */
function splitChanges(changes: EditChanges): {
  productChanges: Prisma.ProductUncheckedUpdateInput;
  packagedChanges: Prisma.PackagedProductUncheckedUpdateInput;
} {
  const productChanges: Record<string, string | number | null> = {};
  const packagedChanges: Record<string, string | number | null> = {};

  for (const field of PRODUCT_EDIT_FIELDS) {
    if (field in changes) productChanges[field] = changes[field] ?? null;
  }
  for (const field of PACKAGED_EDIT_FIELDS) {
    if (field in changes) packagedChanges[field] = changes[field] ?? null;
  }
  // `name` is a non-nullable column; the validator enforces a non-empty string.
  if ('name' in productChanges && typeof productChanges.name !== 'string') {
    delete productChanges.name;
  }

  return {
    productChanges: productChanges as Prisma.ProductUncheckedUpdateInput,
    packagedChanges: packagedChanges as Prisma.PackagedProductUncheckedUpdateInput,
  };
}

/** Drops fields whose proposed value equals the current merged value. */
function effectiveDiff(merged: MergedRecord, changes: EditChanges): EditChanges {
  const diff: EditChanges = {};
  for (const field of EDITABLE_FIELDS) {
    if (!(field in changes)) continue;
    const proposed = changes[field] ?? null;
    const current = merged[field] ?? null;
    if (proposed !== current) diff[field] = proposed;
  }
  return diff;
}

// ---------------------------------------------------------------------------
// PENDING_REVIEW correction path (PATCH /products/:productId)
// ---------------------------------------------------------------------------

/**
 * In-place correction of a not-yet-verified submission. Resets the review cycle:
 * all existing verification votes are deleted and the corrector becomes the new
 * submitter. Only valid while the product is PENDING_REVIEW. Writes `Product`
 * and (for a PACKAGED product) `PackagedProduct` in one transaction.
 */
export async function correctPendingProduct(
  payload: ProductCorrectionInput,
  userId: string,
) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: payload.productId, ...visibleProductWhere() },
      include: { packaged: true },
    });

    if (!product) throw new ProductNotFoundError(payload.productId);
    if (product.status !== ProductStatus.PENDING_REVIEW) {
      throw new ProductIsVerifiedError(payload.productId);
    }

    // Review cycle restarts from zero.
    await tx.productVerification.deleteMany({ where: { productId: product.id } });

    const updatedProduct = await tx.product.update({
      where: { id: product.id },
      data: {
        name: payload.name,
        brand: payload.brand,
        // No key sent = photo not replaced = keep the current image.
        ...(payload.productImageKey ? { image: payload.productImageKey } : {}),
        submittedByUserId: userId,
        status: ProductStatus.PENDING_REVIEW,
      },
    });

    const updatedPackaged =
      product.kind === ProductKind.PACKAGED
        ? await tx.packagedProduct.update({
            where: { productId: product.id },
            data: {
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
            },
          })
        : null;

    // TODO(P5-006-followup): in-app notification to the original submitter when
    // product.submittedByUserId !== userId — deferred until notification
    // infrastructure exists (decided 2026-07-03).

    return { ...updatedProduct, packaged: updatedPackaged };
  });
}

// ---------------------------------------------------------------------------
// Edit proposals (VERIFIED products)
// ---------------------------------------------------------------------------

export async function createEdit(
  productId: string,
  userId: string,
  changes: EditChanges,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, ...visibleProductWhere() },
        include: { packaged: true },
      });

      if (!product) throw new ProductNotFoundError(productId);
      if (product.status !== ProductStatus.VERIFIED) {
        throw new ProductNotVerifiedError(productId);
      }

      const pending = await tx.productEdit.findFirst({
        where: { productId, status: ProductEditStatus.PENDING },
        select: { id: true },
      });
      if (pending) throw new PendingEditExistsError(productId);

      const merged = mergeEditableFields(product);
      const diff = effectiveDiff(merged, changes);
      if (Object.keys(diff).length === 0) throw new NoChangesError();

      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + EDIT_EXPIRY_YEARS);

      return tx.productEdit.create({
        data: {
          productId,
          authorUserId: userId,
          originalValues: snapshotEditableFields(merged) as Prisma.InputJsonObject,
          proposedChanges: diff as Prisma.InputJsonObject,
          expiresAt,
        },
      });
    });
  } catch (err) {
    // The partial unique index (one_pending_edit_per_product) is the source of
    // truth for the "one pending edit per product" rule; surface a race that
    // slipped past the findFirst as the same 409.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new PendingEditExistsError(productId);
    }
    throw err;
  }
}

export interface PendingEditView {
  editId: string;
  productId: string;
  originalValues: EditChanges;
  proposedChanges: EditChanges;
  approvals: number;
  rejections: number;
  createdAt: Date;
  viewer: {
    isAuthor: boolean;
    vote: VerificationVote | null;
    dismissed: boolean;
  };
}

/** Resolve stored image keys to client-usable URLs inside a values object. */
function resolveImagesIn(values: EditChanges): EditChanges {
  if (!('image' in values)) return values;
  return {
    ...values,
    image: resolveImageUrl((values.image as string | null) ?? null),
  };
}

export async function getPendingEdit(
  productId: string,
  userId: string,
): Promise<PendingEditView | null> {
  // Every product read goes through the visibility rule — a REJECTED
  // product's pending-edit lookup 404s like every other product read.
  await assertProductVisible(undefined, productId);

  const edit = await prisma.productEdit.findFirst({
    where: { productId, status: ProductEditStatus.PENDING },
    include: {
      votes: { select: { userId: true, vote: true } },
      dismissals: { where: { userId }, select: { id: true } },
    },
  });
  if (!edit) return null;

  const approvals = edit.votes.filter((v) => v.vote === VerificationVote.APPROVE).length;
  const rejections = edit.votes.filter((v) => v.vote === VerificationVote.REJECT).length;
  const ownVote = edit.votes.find((v) => v.userId === userId)?.vote ?? null;

  return {
    editId: edit.id,
    productId: edit.productId,
    originalValues: resolveImagesIn(edit.originalValues as EditChanges),
    proposedChanges: resolveImagesIn(edit.proposedChanges as EditChanges),
    approvals,
    rejections,
    createdAt: edit.createdAt,
    viewer: {
      isAuthor: edit.authorUserId === userId,
      vote: ownVote,
      dismissed: edit.dismissals.length > 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Voting + resolution
// ---------------------------------------------------------------------------

export interface EditVoteResult {
  approvals: number;
  rejections: number;
  status: ProductEditStatus;
}

/**
 * Records a vote and resolves the edit when a side reaches 2:
 * 2 approvals → proposed changes are applied to `Product` and (if any changed
 * field is packaged-only) `PackagedProduct` in one transaction (same
 * `Product.id`, so all Rating rows stay attached), `lastModifiedByUserId` is
 * set to the edit author (`submittedByUserId` untouched), edit flips to
 * APPLIED. 2 rejections → edit flips to REJECTED, changes discarded. Mixed
 * 1–1 waits for a third voter.
 */
export async function castEditVote(
  editId: string,
  userId: string,
  vote: VerificationVote,
): Promise<EditVoteResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const edit = await tx.productEdit.findUnique({ where: { id: editId } });

      if (!edit) throw new EditNotFoundError(editId);
      if (edit.status !== ProductEditStatus.PENDING) throw new EditNotPendingError(editId);
      if (edit.authorUserId === userId) throw new SelfEditVoteError();

      // Deliberately `create`, not upsert — a second vote by the same user is a
      // 409 (spec), unlike product verification where re-votes overwrite.
      await tx.productEditVote.create({ data: { editId, userId, vote } });

      const votes = await tx.productEditVote.findMany({ where: { editId } });
      const approvals = votes.filter((v) => v.vote === VerificationVote.APPROVE).length;
      const rejections = votes.filter((v) => v.vote === VerificationVote.REJECT).length;

      let status: ProductEditStatus = edit.status;

      if (approvals >= 2 && approvals > rejections) {
        status = ProductEditStatus.APPLIED;
        const { productChanges, packagedChanges } = splitChanges(
          edit.proposedChanges as EditChanges,
        );
        await tx.product.update({
          where: { id: edit.productId },
          data: { ...productChanges, lastModifiedByUserId: edit.authorUserId },
        });
        if (Object.keys(packagedChanges).length > 0) {
          await tx.packagedProduct.update({
            where: { productId: edit.productId },
            data: packagedChanges,
          });
        }
        await tx.productEdit.update({ where: { id: editId }, data: { status } });
        // TODO(P6-005): enqueue OFF sync for the changed fields here.
        // TODO(P5-006-followup): in-app notification to the edit author.
      } else if (rejections >= 2 && rejections > approvals) {
        status = ProductEditStatus.REJECTED;
        await tx.productEdit.update({ where: { id: editId }, data: { status } });
        // TODO(P5-006-followup): in-app notification to the edit author.
      }

      return { approvals, rejections, status };
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new DuplicateEditVoteError();
    }
    throw err;
  }
}

export async function retractEditVote(
  editId: string,
  userId: string,
): Promise<EditVoteResult> {
  return prisma.$transaction(async (tx) => {
    const edit = await tx.productEdit.findUnique({ where: { id: editId } });

    if (!edit) throw new EditNotFoundError(editId);
    if (edit.status !== ProductEditStatus.PENDING) throw new EditNotPendingError(editId);

    const deleted = await tx.productEditVote.deleteMany({
      where: { editId, userId },
    });
    if (deleted.count === 0) throw new EditVoteNotFoundError();

    const votes = await tx.productEditVote.findMany({ where: { editId } });
    return {
      approvals: votes.filter((v) => v.vote === VerificationVote.APPROVE).length,
      rejections: votes.filter((v) => v.vote === VerificationVote.REJECT).length,
      status: edit.status,
    };
  });
}

/**
 * Server-side "Dismiss" on the review banner — hides it for this user across
 * devices and reinstalls. Idempotent; does not count as a vote.
 */
export async function dismissEdit(editId: string, userId: string): Promise<void> {
  const edit = await prisma.productEdit.findUnique({
    where: { id: editId },
    select: { id: true },
  });
  if (!edit) throw new EditNotFoundError(editId);

  await prisma.productEditDismissal.upsert({
    where: { editId_userId: { editId, userId } },
    update: {},
    create: { editId, userId },
  });
}

// ---------------------------------------------------------------------------
// Expiry (scheduled cleanup)
// ---------------------------------------------------------------------------

/**
 * Flips voteless PENDING edits past their `expiresAt` (2 years) to EXPIRED so
 * stale proposals stop blocking the one-pending-edit-per-product slot.
 * Returns the number of edits expired.
 */
export async function expireStaleEdits(now: Date = new Date()): Promise<number> {
  const result = await prisma.productEdit.updateMany({
    where: {
      status: ProductEditStatus.PENDING,
      expiresAt: { lt: now },
      votes: { none: {} },
    },
    data: { status: ProductEditStatus.EXPIRED },
  });
  return result.count;
}
