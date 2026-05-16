import { Request, Response, NextFunction } from 'express';
import prisma from '../db.js';
import {
  createSubmittedProduct,
  fetchFromOpenFoodFacts,
  ProductAlreadyVerifiedError,
  ProductPendingByAnotherUserError,
  ProductPreviouslyRejectedError,
} from '../services/productService.js';
import logger from '../logger.js';
import {AuthRequest} from "../middlewares/authMiddleware.js";
import {
  SubmissionValidationError,
  validateProductSubmission,
} from '../validators/productSubmissionValidator.js';

// Barcodes are EAN-8, UPC-A (12 digits), or EAN-13 — all numeric.
const BARCODE_RE = /^\d{8,13}$/;

// GET /api/products/:barcode
export const getProductByBarcode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const barcode = req.params.barcode as string;

    if (!BARCODE_RE.test(barcode)) {
      return res.status(400).json({ message: 'Invalid barcode format' });
    }

    // 1. Check local cache first
    const cached = await prisma.product.findUnique({ where: { barcode } });
    if (cached) {
      logger.info(`Product cache hit: ${barcode}`);
      return res.json(cached);
    }

    // 2. Fetch from Open Food Facts
    const data = await fetchFromOpenFoodFacts(barcode);
    if (!data) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // 3. Cache in DB and return
    const product = await prisma.product.create({ data });
    logger.info(`Product fetched and cached: ${barcode}`);
    res.json(product);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

// POST /api/products
export const submitProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const payload = validateProductSubmission(req.body);
    const userId = req.user!.id; // this ony works for auth paths with registered users

    const result = await createSubmittedProduct(payload, userId);
    res.status(result.action === 'created' ? 201 : 200).json(result.product);

  } catch (err) {
    if (err instanceof SubmissionValidationError) {
      return res.status(422).json({
        error: err.message,
        reason: err.message,
        field: err.field,
      });
    }
    if (err instanceof ProductPreviouslyRejectedError) {
      return res.status(409).json({ error: err.code });
    }
    if (
      err instanceof ProductAlreadyVerifiedError ||
      err instanceof ProductPendingByAnotherUserError
    ) {
      return res.status(409).json({ error: err.code });
    }
    next(err); // anything unexpected goes to the central errorHandler
  }
};
