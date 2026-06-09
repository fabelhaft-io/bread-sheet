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
 * Convert image buffer to JPEG (format normalisation only — no resize), upload to
 * `raw/{kind}/{uuid}.jpg`, and return the predicted `processed/{uuid}.jpg` URL.
 *
 * Resizing to the final dimension caps (1200 px product / 1600 px label) is
 * handled asynchronously by the S3-triggered Lambda, which writes to `processed/`.
 * The API returns the predicted URL immediately without waiting for the Lambda.
 */
export async function uploadImageToS3(
  buffer: Buffer,
  kind: ImageKind,
): Promise<string> {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error('FATAL: S3_BUCKET_NAME environment variable is required.');

  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!endpoint) throw new Error('FATAL: AWS_ENDPOINT_URL environment variable is required.');

  // Format normalisation: convert to JPEG so Lambda always receives a consistent
  // input regardless of the original format (PNG, WebP, TIFF, etc.).
  // Quality 95 preserves sufficient detail for Lambda's subsequent resize step.
  const jpegBuffer = await sharp(buffer).jpeg({ quality: 95 }).toBuffer();

  const uuid = uuidv4();
  const rawKey = `raw/${kind}/${uuid}.jpg`;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: rawKey,
      Body: jpegBuffer,
      ContentType: 'image/jpeg',
    }),
  );

  return `${endpoint}/${bucket}/processed/${uuid}.jpg`;
}