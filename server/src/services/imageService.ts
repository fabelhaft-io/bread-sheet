import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import config from '../configs/config.js';

let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  if (!s3Client) {
    // LocalStack needs path-style addressing (bucket in the path): the SDK's
    // default virtual-hosted style prefixes the bucket onto the endpoint host
    // (e.g. breadsheet-images-local.localstack), which doesn't resolve inside
    // the Docker network.
    s3Client = new S3Client({ forcePathStyle: config.s3Mode === 'localstack' });
  }
  return s3Client;
}

export type ImageKind = 'product' | 'label';

/**
 * Resolve a stored `Product.image` value to a client-usable URL.
 *
 * The column holds two shapes:
 *   - S3 object keys (`processed/{uuid}.jpg`) for user-uploaded photos —
 *     prefixed with the public asset base from config at read time
 *   - absolute external URLs (Open Food Facts catalogue images) — passed through
 *
 * Only keys are persisted for our own uploads, so the environment-specific
 * base (LocalStack host, S3 region, future CDN) is never frozen into rows.
 */
export function resolveImageUrl(image: string | null | undefined): string | null {
  if (image == null) return null;
  if (/^https?:\/\//.test(image)) return image;
  return `${config.assetBaseUrl}/${image}`;
}

/**
 * Convert image buffer to JPEG (format normalisation only — no resize), upload to
 * `raw/{kind}/{uuid}.jpg`, and return the predicted `processed/{uuid}.jpg` object
 * KEY (not a URL — clients receive URLs via `resolveImageUrl` at read time).
 *
 * Resizing to the final dimension caps (1200 px product / 1600 px label) is
 * handled asynchronously by the S3-triggered Lambda, which writes to `processed/`.
 * The API returns the predicted key immediately without waiting for the Lambda.
 */
export async function uploadImageToS3(
  buffer: Buffer,
  kind: ImageKind,
): Promise<string> {
  // Format normalisation: convert to JPEG so Lambda always receives a consistent
  // input regardless of the original format (PNG, WebP, TIFF, etc.).
  // Quality 95 preserves sufficient detail for Lambda's subsequent resize step.
  const jpegBuffer = await sharp(buffer).jpeg({ quality: 95 }).toBuffer();

  const uuid = uuidv4();
  const rawKey = `raw/${kind}/${uuid}.jpg`;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: config.s3BucketName,
      Key: rawKey,
      Body: jpegBuffer,
      ContentType: 'image/jpeg',
    }),
  );

  return `processed/${uuid}.jpg`;
}