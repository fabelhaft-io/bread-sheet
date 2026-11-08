import { Response, NextFunction } from 'express';
import prisma from '../db.js';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import { ProductKind, VerificationVote } from '../generated/prisma_client/enums.js';
import {
  SubmissionValidationError,
  validateProductCorrection,
} from '../validators/productSubmissionValidator.js';
import { validateCustomProductCorrection } from '../validators/customProductValidator.js';
import { validateProductEditChanges } from '../validators/productEditValidator.js';
import {
  correctCustomProduct,
  correctPendingProduct,
  createEdit,
  getPendingEdit,
  castEditVote,
  retractEditVote,
  dismissEdit,
  DuplicateCustomProductNameError,
  DuplicateEditVoteError,
  EditNotFoundError,
  EditNotPendingError,
  EditVoteNotFoundError,
  NoChangesError,
  PackagedFieldNotAllowedError,
  PendingEditExistsError,
  ProductIsVerifiedError,
  ProductNotVerifiedError,
  SelfEditVoteError,
} from '../services/productEditService.js';
import { ProductNotFoundError, visibleProductWhere } from '../services/productVisibility.js';
import { serializeProduct } from '../services/productSerializer.js';

// PATCH /api/products/:productId — in-place correction of a PENDING_REVIEW
// submission. Resets the review cycle (votes cleared, corrector becomes the
// submitter). 409 on VERIFIED products — those go through the edit flow.
export const correctProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const productId = req.params.productId as string;

    // TICKET-P6-007: the correction body shape (and which fields are
    // editable) differs by kind — a CUSTOM product has no PackagedProduct
    // row and only `name`/the photo can change. Look up the kind first so
    // the right validator (and the right 400 vs the full packaged flow) runs.
    const existing = await prisma.product.findFirst({
      where: { id: productId, ...visibleProductWhere() },
      select: { kind: true },
    });
    if (!existing) {
      return res.status(404).json({ error: 'product_not_found' });
    }

    if (existing.kind === ProductKind.CUSTOM) {
      const payload = validateCustomProductCorrection({
        ...(req.body as Record<string, unknown>),
        productId,
      });
      const product = await correctCustomProduct(payload, req.user!.id);
      return res.json(serializeProduct(product, req.user));
    }

    const payload = validateProductCorrection({
      ...(req.body as Record<string, unknown>),
      productId,
    });
    const product = await correctPendingProduct(payload, req.user!.id);
    res.json(serializeProduct(product, req.user));
  } catch (err) {
    if (err instanceof SubmissionValidationError) {
      return res
        .status(422)
        .json({ error: err.message, reason: err.message, field: err.field });
    }
    if (err instanceof PackagedFieldNotAllowedError) {
      return res.status(400).json({ message: err.message });
    }
    if (err instanceof DuplicateCustomProductNameError) {
      return res
        .status(409)
        .json({ code: err.code, productId: err.productId, message: err.message });
    }
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof ProductIsVerifiedError) return res.status(409).json({ error: err.code });
    next(err);
  }
};

// POST /api/products/:productId/edits — propose a change to a VERIFIED product.
export const createProductEdit = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const changes = validateProductEditChanges(req.body);
    const edit = await createEdit(req.params.productId as string, req.user!.id, changes);
    res.status(201).json({
      editId: edit.id,
      productId: edit.productId,
      status: edit.status,
      proposedChanges: edit.proposedChanges,
    });
  } catch (err) {
    if (err instanceof SubmissionValidationError || err instanceof NoChangesError) {
      const field = err instanceof SubmissionValidationError ? err.field : undefined;
      return res.status(422).json({ error: err.message, reason: err.message, field });
    }
    if (err instanceof PackagedFieldNotAllowedError) {
      return res.status(400).json({ message: err.message });
    }
    if (err instanceof DuplicateCustomProductNameError) {
      return res
        .status(409)
        .json({ code: err.code, productId: err.productId, message: err.message });
    }
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof ProductNotVerifiedError || err instanceof PendingEditExistsError) {
      return res.status(409).json({ error: err.code });
    }
    next(err);
  }
};

// GET /api/products/:productId/edits/pending — current pending edit (or null).
// Drives the review banner and populates the diff screen.
export const getPendingProductEdit = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const edit = await getPendingEdit(req.params.productId as string, req.user!.id);
    res.json({ edit });
  } catch (err) {
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    next(err);
  }
};

// POST /api/products/edits/:editId/votes — body { vote: "APPROVE" | "REJECT" }.
export const voteOnProductEdit = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const vote = (req.body as Record<string, unknown>)?.vote;
    if (vote !== VerificationVote.APPROVE && vote !== VerificationVote.REJECT) {
      return res.status(400).json({ error: 'invalid_vote' });
    }
    const result = await castEditVote(req.params.editId as string, req.user!.id, vote);
    res.json(result);
  } catch (err) {
    if (err instanceof EditNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof EditNotPendingError || err instanceof DuplicateEditVoteError) {
      return res.status(409).json({ error: err.code });
    }
    if (err instanceof SelfEditVoteError) return res.status(403).json({ error: err.code });
    next(err);
  }
};

// DELETE /api/products/edits/:editId/votes — retract the caller's vote while
// the edit is still PENDING.
export const retractVoteOnProductEdit = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await retractEditVote(req.params.editId as string, req.user!.id);
    res.json(result);
  } catch (err) {
    if (err instanceof EditNotFoundError || err instanceof EditVoteNotFoundError) {
      return res.status(404).json({ error: err.code });
    }
    if (err instanceof EditNotPendingError) return res.status(409).json({ error: err.code });
    next(err);
  }
};

// POST /api/products/edits/:editId/dismissals — hide the review banner for the
// caller, across devices. Idempotent; not a vote.
export const dismissProductEdit = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    await dismissEdit(req.params.editId as string, req.user!.id);
    // 200 + JSON body (not 204) — the client's json() helper expects a body.
    res.json({ dismissed: true });
  } catch (err) {
    if (err instanceof EditNotFoundError) return res.status(404).json({ error: err.code });
    next(err);
  }
};
