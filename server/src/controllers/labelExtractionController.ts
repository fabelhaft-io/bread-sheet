import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import { extractFromText } from '../services/labelExtractionService.js';

const MIN_OCR_LENGTH = 50;

// POST /api/products/extract-label
export const extractLabel = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (req.is('multipart/form-data')) {
      return res.status(501).json({ error: 'image_path_not_implemented' });
    }

    const rawText = (req.body as Record<string, unknown>).rawText;
    if (typeof rawText !== 'string' || rawText.trim().length < MIN_OCR_LENGTH) {
      return res.status(400).json({ error: 'raw_text_too_short' });
    }

    const label = extractFromText(rawText);
    res.json(label);
  } catch (err) {
    next(err);
  }
};