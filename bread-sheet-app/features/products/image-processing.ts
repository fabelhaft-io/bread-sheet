import { log } from '@/lib/log';

import {
  LABEL_IMAGE_JPEG_QUALITY,
  MAX_IMAGE_BYTES,
  MAX_LABEL_IMAGE_LONGEST_EDGE,
  MAX_PRODUCT_IMAGE_LONGEST_EDGE,
  PRODUCT_IMAGE_JPEG_QUALITY,
} from './constants';

/**
 * Client-side image processing for the Add Product flow (TICKET-P5-002).
 *
 * Every image gets resized to a longest-edge cap and re-encoded as JPEG
 * before leaving the device. The Lambda resize (P5-003) is the definitive
 * one, but doing it here too keeps upload payloads small on slow mobile
 * connections and lets us enforce the 2 MB client cap pre-flight.
 */

export type ImageKind = 'product' | 'label';

export interface ProcessedImage {
  /** Resized, re-encoded JPEG ready for preview or upload. */
  uri: string;
  /** Size in bytes after processing; `null` when the platform can't report it. */
  size: number | null;
}

export class ImageTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super('Photo is too large — please try again in better lighting or closer to the subject.');
    this.name = 'ImageTooLargeError';
  }
}

/**
 * Resize + recompress an image. Returns the processed URI that should be
 * used for both the in-app preview *and* the upload — the spec requires
 * the preview to already reflect the compressed version so users notice
 * quality problems before they submit.
 */
export async function processCaptureForUpload(
  uri: string,
  kind: ImageKind,
): Promise<ProcessedImage> {
  const longestEdge =
    kind === 'product' ? MAX_PRODUCT_IMAGE_LONGEST_EDGE : MAX_LABEL_IMAGE_LONGEST_EDGE;
  const quality = kind === 'product' ? PRODUCT_IMAGE_JPEG_QUALITY : LABEL_IMAGE_JPEG_QUALITY;

  const manipulator = await importImageManipulator();
  let processedUri = uri;
  if (manipulator) {
    // Detect orientation so the cap applies to the actual longest edge.
    // Resizing by width alone would leave portrait images taller than intended.
    const dims = await getImageDimensions(uri);
    const resizeAction =
      dims === null || dims.width >= dims.height
        ? { resize: { width: longestEdge } }
        : { resize: { height: longestEdge } };

    const result = await manipulator.manipulateAsync(
      uri,
      [resizeAction],
      { compress: quality, format: manipulator.SaveFormat.JPEG },
    );
    processedUri = result.uri;
  }

  // File size is best-effort — not every platform exposes it synchronously.
  const size = await safeFileSize(processedUri);

  log.debug(
    `[image] processed capture — kind=${kind} resized=${manipulator ? 'yes' : 'no (module unavailable, original passed through)'} longestEdge=${longestEdge} quality=${quality} sizeBytes=${size ?? 'unknown'}`,
  );

  if (size !== null && size > MAX_IMAGE_BYTES) {
    throw new ImageTooLargeError(size);
  }

  return { uri: processedUri, size };
}

/**
 * Best-effort file size lookup via `expo-file-system`. Returns `null` if the
 * module is unavailable (jest-expo) or the URI isn't readable.
 */
async function safeFileSize(uri: string): Promise<number | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-file-system/legacy');
    const fs = (mod?.default ?? mod) as {
      getInfoAsync: (uri: string, opts?: { size?: boolean }) => Promise<{ size?: number }>;
    };
    if (!fs || typeof fs.getInfoAsync !== 'function') return null;
    const info = await fs.getInfoAsync(uri, { size: true });
    return typeof info.size === 'number' ? info.size : null;
  } catch {
    return null;
  }
}

type ImageManipulatorModule = {
  manipulateAsync: (
    uri: string,
    actions: { resize: { width?: number; height?: number } }[],
    options: { compress: number; format: unknown },
  ) => Promise<{ uri: string }>;
  SaveFormat: { JPEG: unknown };
};

/**
 * Best-effort image dimension lookup via React Native's Image.getSize.
 * Returns null if unavailable (jest-expo) so callers can fall back to
 * width-based resize (safe but slightly over-sized for portrait images).
 */
async function getImageDimensions(
  uri: string,
): Promise<{ width: number; height: number } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Image } = require('react-native') as typeof import('react-native');
    return await new Promise((resolve, reject) =>
      Image.getSize(uri, (w, h) => resolve({ width: w, height: h }), reject),
    );
  } catch {
    return null;
  }
}

async function importImageManipulator(): Promise<ImageManipulatorModule | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-image-manipulator');
    return (mod?.default ?? mod) as ImageManipulatorModule | null;
  } catch {
    return null;
  }
}
