import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());
const s3CtorCalls = vi.hoisted(() => ({ opts: [] as Array<{ forcePathStyle?: boolean }> }));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = mockSend;
    constructor(opts: { forcePathStyle?: boolean }) {
      s3CtorCalls.opts.push(opts);
    }
  }
  class PutObjectCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  return { S3Client, PutObjectCommand };
});

const JPEG_OUTPUT = vi.hoisted(() => Buffer.from('normalised-jpeg'));

vi.mock('sharp', () => ({
  default: () => ({
    jpeg: () => ({ toBuffer: async () => JPEG_OUTPUT }),
  }),
}));

describe('imageService', () => {
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue({});
    s3CtorCalls.opts.length = 0;
    vi.resetModules();
    delete process.env.S3_MODE;
    process.env.S3_BUCKET_NAME = 'test-bucket';
    process.env.ASSET_BASE_URL = 'http://assets.test/test-bucket';
  });

  describe('uploadImageToS3', () => {
    it('uses path-style addressing when S3_MODE=localstack', async () => {
      process.env.S3_MODE = 'localstack';
      const { uploadImageToS3 } = await import('./imageService.js');

      await uploadImageToS3(Buffer.from('raw'), 'product');

      expect(s3CtorCalls.opts).toEqual([{ forcePathStyle: true }]);
    });

    it('uses default (virtual-hosted) addressing when S3_MODE=aws', async () => {
      process.env.S3_MODE = 'aws';
      const { uploadImageToS3 } = await import('./imageService.js');

      await uploadImageToS3(Buffer.from('raw'), 'product');

      expect(s3CtorCalls.opts).toEqual([{ forcePathStyle: false }]);
    });

    it('uploads the normalised JPEG to raw/{kind}/ and returns the processed object KEY', async () => {
      process.env.S3_MODE = 'localstack';
      const { uploadImageToS3 } = await import('./imageService.js');

      const key = await uploadImageToS3(Buffer.from('raw'), 'label');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const put = mockSend.mock.calls[0][0].input;
      expect(put.Bucket).toBe('test-bucket');
      expect(put.Key).toMatch(/^raw\/label\/[0-9a-f-]{36}\.jpg$/);
      expect(put.Body).toBe(JPEG_OUTPUT);
      expect(put.ContentType).toBe('image/jpeg');

      // Returns a key, never a URL — environment-specific bases are applied at
      // read time by resolveImageUrl, so keys are what gets persisted.
      const uuid = (put.Key as string).match(/raw\/label\/(.+)\.jpg/)![1];
      expect(key).toBe(`processed/${uuid}.jpg`);
    });
  });

  describe('resolveImageUrl', () => {
    it('prefixes stored S3 keys with ASSET_BASE_URL', async () => {
      process.env.S3_MODE = 'localstack';
      const { resolveImageUrl } = await import('./imageService.js');

      expect(resolveImageUrl('processed/abc-123.jpg')).toBe(
        'http://assets.test/test-bucket/processed/abc-123.jpg',
      );
    });

    it('passes absolute URLs through untouched (Open Food Facts images)', async () => {
      process.env.S3_MODE = 'localstack';
      const { resolveImageUrl } = await import('./imageService.js');

      expect(resolveImageUrl('https://images.openfoodfacts.org/p/123.jpg')).toBe(
        'https://images.openfoodfacts.org/p/123.jpg',
      );
      expect(resolveImageUrl('http://example.com/x.jpg')).toBe('http://example.com/x.jpg');
    });

    it('returns null for null/undefined', async () => {
      process.env.S3_MODE = 'localstack';
      const { resolveImageUrl } = await import('./imageService.js');

      expect(resolveImageUrl(null)).toBeNull();
      expect(resolveImageUrl(undefined)).toBeNull();
    });

    it('tolerates a trailing slash on ASSET_BASE_URL', async () => {
      process.env.S3_MODE = 'localstack';
      process.env.ASSET_BASE_URL = 'http://assets.test/test-bucket/';
      const { resolveImageUrl } = await import('./imageService.js');

      expect(resolveImageUrl('processed/abc.jpg')).toBe(
        'http://assets.test/test-bucket/processed/abc.jpg',
      );
    });
  });
});
