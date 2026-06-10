import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import { extractFromText } from '../services/labelExtractionService.js';
import { extractLabelWithLlm } from '../services/labelExtractionLlmService.js';
import { getVisionMode, ocrLabelImage } from '../services/visionService.js';
import logger from '../logger.js';

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
      const mode = getVisionMode();
      if (mode === 'llm') {
        const label = await extractLabelWithLlm(req.file.buffer, req.file.mimetype);
        logger.info('label-extract: image path', {
          path: 'image',
          mode,
          imageBytes: req.file.size,
          confidence: label.confidence,
          userId: req.user?.id,
        });
        return res.json(label);
      }
      const rawText = await ocrLabelImage(req.file.buffer);
      const label = extractFromText(rawText);
      logger.info('label-extract: image path', {
        path: 'image',
        mode,
        imageBytes: req.file.size,
        ocrTextLength: rawText.trim().length,
        confidence: label.confidence,
        userId: req.user?.id,
      });
      return res.json(label);
    }

    const rawText = (req.body as Record<string, unknown>).rawText;
    if (typeof rawText !== 'string' || rawText.trim().length < MIN_OCR_LENGTH) {
      return res.status(400).json({ error: 'raw_text_too_short' });
    }

    const label = extractFromText(rawText);
    logger.info('label-extract: text path', {
      path: 'text',
      mode: getVisionMode(),
      ocrTextLength: rawText.trim().length,
      confidence: label.confidence,
      userId: req.user?.id,
    });
    res.json(label);
  } catch (err) {
    next(err);
  }
};
