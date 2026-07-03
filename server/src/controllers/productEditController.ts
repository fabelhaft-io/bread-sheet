import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import { VerificationVote } from '../generated/prisma_client/enums.js';
import {
  SubmissionValidationError,
  validateProductCorrection,
} from '../validators/productSubmissionValidator.js';
import { validateProductEditChanges } from '../validators/productEditValidator.js';
import {
  correctPendingProduct,
  createEdit,
  getPendingEdit,
  castEditVote,
  retractEditVote,
  dismissEdit,
  DuplicateEditVoteError,
  EditNotFoundError,
  EditNotPendingError,
  EditVoteNotFoundError,
  NoChangesError,
  PendingEditExistsError,
  ProductIsVerifiedError,
  ProductNotVerifiedError,
  SelfEditVoteError,
} from '../services/productEditService.js';
import { ProductNotFoundError } from '../services/productVerificationService.js';
import { resolveImageUrl } from '../services/imageService.js';

// PATCH /api/products/:barcode — in-place correction of a PENDING_REVIEW
// submission. Resets the review cycle (votes cleared, corrector becomes the
// submitter). 409 on VERIFIED products — those go through the edit flow.
export const correctProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const payload = validateProductCorrection({
      ...(req.body as Record<string, unknown>),
      barcode: req.params.barcode,
    });
    const product = await correctPendingProduct(payload, req.user!.id);
    res.json({ ...product, image: resolveImageUrl(product.image) });
  } catch (err) {
    if (err instanceof SubmissionValidationError) {
      return res
        .status(422)
        .json({ error: err.message, reason: err.message, field: err.field });
    }
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof ProductIsVerifiedError) return res.status(409).json({ error: err.code });
    next(err);
  }
};

// POST /api/products/:barcode/edits — propose a change to a VERIFIED product.
export const createProductEdit = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const changes = validateProductEditChanges(req.body);
    const edit = await createEdit(req.params.barcode as string, req.user!.id, changes);
    res.status(201).json({
      editId: edit.id,
      barcode: edit.barcode,
      status: edit.status,
      proposedChanges: edit.proposedChanges,
    });
  } catch (err) {
    if (err instanceof SubmissionValidationError || err instanceof NoChangesError) {
      const field = err instanceof SubmissionValidationError ? err.field : undefined;
      return res.status(422).json({ error: err.message, reason: err.message, field });
    }
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof ProductNotVerifiedError || err instanceof PendingEditExistsError) {
      return res.status(409).json({ error: err.code });
    }
    next(err);
  }
};

// GET /api/products/:barcode/edits/pending — current pending edit (or null).
// Drives the review banner and populates the diff screen.
export const getPendingProductEdit = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const edit = await getPendingEdit(req.params.barcode as string, req.user!.id);
    res.json({ edit });
  } catch (err) {
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
