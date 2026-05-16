import { ImageAnnotatorClient } from '@google-cloud/vision';
import path from 'path';

const VALID_VISION_MODES = ['mock', 'live', 'tesseract'] as const;
type VisionMode = (typeof VALID_VISION_MODES)[number];

function getMode(): VisionMode {
  const m = process.env.VISION_MODE;
  if (!m) {
    throw new Error(
      'Missing required environment variable: VISION_MODE. Valid values: mock | live | tesseract',
    );
  }
  if (!VALID_VISION_MODES.includes(m as VisionMode)) {
    throw new Error(
      `Invalid VISION_MODE "${m}". Must be one of: ${VALID_VISION_MODES.join(' | ')}`,
    );
  }
  return m as VisionMode;
}

// Lazily constructed and memoized — never instantiated in mock/tesseract mode.
// Auth is handled entirely by ADC: in prod GOOGLE_APPLICATION_CREDENTIALS points
// to a Workload Identity Federation credential config mounted via ConfigMap.
let _client: ImageAnnotatorClient | null = null;

function getVisionClient(): ImageAnnotatorClient {
  if (_client) return _client;
  _client = new ImageAnnotatorClient();
  return _client;
}

// Fixed OCR text returned in mock mode regardless of image content.
const MOCK_OCR_TEXT = [
  'Nutritional information per 100g',
  'Energy 1234 kJ / 295 kcal',
  'Fat 12.5g',
  'of which saturates 2.1g',
  'Carbohydrates 45g',
  'of which sugars 8g',
  'Protein 8g',
  'Salt 0.5g',
  'Serving size: 30g',
  'Ingredients: Oats (60%), sugar, sunflower oil, salt, natural flavouring.',
].join('\n');

async function ocrMock(_buffer: Buffer): Promise<string> {
  return MOCK_OCR_TEXT;
}

async function ocrLive(buffer: Buffer): Promise<string> {
  const client = getVisionClient();
  const [result] = await client.documentTextDetection({ image: { content: buffer } });
  return result.fullTextAnnotation?.text ?? '';
}

async function ocrTesseract(buffer: Buffer): Promise<string> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const { tmpdir } = await import('os');
  const { writeFileSync, readFileSync, unlinkSync } = await import('fs');

  const execFileAsync = promisify(execFile);
  const base = `vision-${Date.now()}`;
  const tmpIn = path.join(tmpdir(), `${base}.jpg`);
  const tmpOutBase = path.join(tmpdir(), base);

  try {
    writeFileSync(tmpIn, buffer);
    await execFileAsync('tesseract', [tmpIn, tmpOutBase, '-l', 'eng+deu']);
    return readFileSync(`${tmpOutBase}.txt`, 'utf-8');
  } finally {
    for (const f of [tmpIn, `${tmpOutBase}.txt`]) {
      try {
        unlinkSync(f);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

export async function ocrLabelImage(buffer: Buffer): Promise<string> {
  switch (getMode()) {
    case 'live':
      return ocrLive(buffer);
    case 'tesseract':
      return ocrTesseract(buffer);
    default:
      return ocrMock(buffer);
  }
}
