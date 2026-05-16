import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

const s3Client = new S3Client({});

export type ImageKind = 'product' | 'label';

const RESIZE_CONFIG: Record<ImageKind, { maxDim: number; quality: number }> = { // In-Sync with App Client!
  product: { maxDim: 1200, quality: 85 },
  label:   { maxDim: 1600, quality: 90 },
};

/**
 * Resize an image buffer to the kind-appropriate dimensions, convert to JPEG,
 * upload to S3 under `submissions/<uuid>.jpg`, and return the public URL.
 */
export async function uploadImageToS3(
  buffer: Buffer,
  kind: ImageKind,
): Promise<string> {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error('FATAL: S3_BUCKET_NAME environment variable is required.');

  const { maxDim, quality } = RESIZE_CONFIG[kind];

  const resized = await sharp(buffer)
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();

  const key = `submissions/${uuidv4()}.jpg`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: resized,
      ContentType: 'image/jpeg',
    }),
  );

  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!endpoint) throw new Error('FATAL: AWS_ENDPOINT_URL environment variable is required.');
  return `${endpoint}/${bucket}/${key}`;
}