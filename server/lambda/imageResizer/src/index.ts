import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import type { S3Event } from 'aws-lambda';

const s3 = new S3Client({});

// Must stay in sync with imageService.ts (API uploads these dimension caps).
// TICKET-P6-007: 'item' (a custom product's photo — a cocktail, a dish, no
// barcode) resizes exactly like 'product' — there is no reason a custom
// item's listing photo should be capped differently from a packaged one's.
const SIZE_CONFIG: Record<'product' | 'label' | 'item', { maxDim: number; quality: number }> = {
  product: { maxDim: 1200, quality: 85 },
  label:   { maxDim: 1600, quality: 90 },
  item:    { maxDim: 1200, quality: 85 },
};

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const rawKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Key format: raw/{kind}/{uuid}.jpg
    const match = rawKey.match(/^raw\/(product|label|item)\/([^/]+\.jpg)$/);
    if (!match) {
      console.error(`imageResizer: unexpected key format, skipping: ${rawKey}`);
      continue;
    }

    const kind = match[1] as 'product' | 'label' | 'item';
    const filename = match[2];
    const { maxDim, quality } = SIZE_CONFIG[kind];

    const getResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: rawKey }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of getResult.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);

    const processed = await sharp(raw)
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();

    const outputKey = `processed/${filename}`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: outputKey,
      Body: processed,
      ContentType: 'image/jpeg',
    }));

    console.log(`imageResizer: ${rawKey} → ${outputKey} (${processed.length} bytes)`);
  }
};