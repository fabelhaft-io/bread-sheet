import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import { SubmissionValidationError } from '../validators/productSubmissionValidator.js';
import { validateCustomProductCreate } from '../validators/customProductValidator.js';
import {
  createCustomProduct,
  DuplicateCustomProductNameError,
  PackagedFieldNotAllowedError,
} from '../services/customProductService.js';
import logger from '../logger.js';

// POST /api/custom-products — body `{ name, imageKey? }` (TICKET-P6-007).
// Creates a `Product` row with `kind: CUSTOM`, `status: PENDING_REVIEW`, no
// `PackagedProduct`. requireRegistered on the route: anonymous sessions 403.
export const createCustomProductHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const payload = validateCustomProductCreate(req.body);
    const result = await createCustomProduct(payload, req.user!.id);
    res.status(201).json({ id: result.id, status: result.status });
  } catch (err) {
    if (err instanceof PackagedFieldNotAllowedError) {
      return res.status(400).json({ message: err.message });
    }
    if (err instanceof SubmissionValidationError) {
      return res.status(400).json({ message: err.message, field: err.field });
    }
    if (err instanceof DuplicateCustomProductNameError) {
      return res
        .status(409)
        .json({ code: err.code, productId: err.productId, message: err.message });
    }
    logger.error(err);
    next(err);
  }
};
