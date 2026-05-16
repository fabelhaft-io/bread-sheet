import { ImageAnnotatorClient } from '@google-cloud/vision';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

function getMode(): 'mock' | 'live' | 'tesseract' {
  const m = process.env.VISION_MODE ?? 'mock';
  if (m === 'live' || m === 'tesseract') return m;
  return 'mock';
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

function fixturesDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '../__fixtures__/vision');
}

async function ocrMock(buffer: Buffer): Promise<string> {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const fixturePath = path.join(fixturesDir(), `${hash}.txt`);
  if (!existsSync(fixturePath)) {
    throw new Error(
      `[visionService mock] Fixture missing for hash "${hash}". ` +
        `Add ${fixturePath} with the expected raw OCR text.`,
    );
  }
  return readFileSync(fixturePath, 'utf-8');
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
