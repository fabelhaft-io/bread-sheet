import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import { extractFromText } from '../services/labelExtractionService.js';
import { ocrLabelImage } from '../services/visionService.js';

const MIN_OCR_LENGTH = 50;

// POST /api/products/extract-label
export const extractLabel = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (req.is('multipart/form-data')) {
      if (!req.file) {
        return res.status(400).json({ error: 'image_required' });
      }
      const rawText = await ocrLabelImage(req.file.buffer);
      return res.json(extractFromText(rawText));
    }

    const rawText = (req.body as Record<string, unknown>).rawText;
    if (typeof rawText !== 'string' || rawText.trim().length < MIN_OCR_LENGTH) {
      return res.status(400).json({ error: 'raw_text_too_short' });
    }

    res.json(extractFromText(rawText));
  } catch (err) {
    next(err);
  }
};
