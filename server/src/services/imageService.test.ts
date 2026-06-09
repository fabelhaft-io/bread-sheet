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
    process.env.AWS_ENDPOINT_URL = 'http://localstack:4566';
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

    it('uploads the normalised JPEG to raw/{kind}/ and returns the processed URL', async () => {
      process.env.S3_MODE = 'localstack';
      const { uploadImageToS3 } = await import('./imageService.js');

      const url = await uploadImageToS3(Buffer.from('raw'), 'label');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const put = mockSend.mock.calls[0][0].input;
      expect(put.Bucket).toBe('test-bucket');
      expect(put.Key).toMatch(/^raw\/label\/[0-9a-f-]{36}\.jpg$/);
      expect(put.Body).toBe(JPEG_OUTPUT);
      expect(put.ContentType).toBe('image/jpeg');

      const uuid = (put.Key as string).match(/raw\/label\/(.+)\.jpg/)![1];
      expect(url).toBe(`http://localstack:4566/test-bucket/processed/${uuid}.jpg`);
    });
  });
});
