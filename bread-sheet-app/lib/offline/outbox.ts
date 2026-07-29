import type { RatingEntry } from '@/features/ratings/types';
import { ApiError, NetworkError, api } from '@/lib/api';

import { upsertCachedRating } from './caches';
import { peekCache, readCache, writeCache } from './store';

/**
 * Persisted write queue for ratings (P8-004).
 *
 * Only ratings are queued, and that is a deliberate limit. A rating is owned by
 * exactly one user and `POST /api/ratings` upserts on `(userId, productId)`, so
 * replaying one is idempotent and last-write-wins is *correct* — the queued
 * value is the user's latest intent, and there is no server state that could
 * disagree. Product submissions, edits and peer votes have no such property:
 * they hinge on state that is invisible offline (the image plausibility gate,
 * the one-pending-edit `409`, the self-vote `403`), so those flows stay
 * online-only and simply report that the user is offline.
 */

export const OUTBOX_DOC = 'outbox';

/** First retry delay; doubles per attempt up to {@link MAX_BACKOFF_MS}. */
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 30 * 60_000;

export interface OutboxRating {
  barcode: string;
  taste: number;
  comment: string | null;
  /** Epoch millis the user submitted; preserved across collapses. */
  queuedAt: number;
  attempts: number;
  /** Epoch millis before which a flush skips this item. */
  nextAttemptAt: number;
}

/** An item the server rejected for good — reported once, then forgotten. */
export interface OutboxFailure {
  barcode: string;
  message: string;
}

export interface FlushResult {
  /** Barcodes accepted by the server during this flush. */
  synced: string[];
  /** Items dropped because retrying could not help. */
  dropped: OutboxFailure[];
  /** The queue as it stands afterwards. */
  remaining: OutboxRating[];
}

/** Delay before retry number `attemptsSoFar + 1`: 30s, 1m, 2m … capped. */
function backoffFor(attemptsSoFar: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attemptsSoFar, MAX_BACKOFF_MS);
}

/**
 * A 4xx that is not about authentication or throttling means the request is
 * wrong, not early — replaying it forever would just hide the problem.
 */
function isPermanent(err: unknown): err is ApiError {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 401 || err.status === 408 || err.status === 429) return false;
  return err.status >= 400 && err.status < 500;
}

/** Synchronous view of the queue, for first-frame "not yet synced" markers. */
export function peekOutbox(): OutboxRating[] {
  return peekCache<OutboxRating[]>(OUTBOX_DOC) ?? [];
}

export async function readOutbox(): Promise<OutboxRating[]> {
  return (await readCache<OutboxRating[]>(OUTBOX_DOC)) ?? [];
}

export async function clearOutbox(): Promise<void> {
  await writeCache<OutboxRating[]>(OUTBOX_DOC, []);
}

/**
 * Queue a rating, replacing any earlier queued rating for the same barcode.
 * Collapsing is what makes "the user fiddled with the slider five times while
 * offline" cost one request instead of five, and the last value is the one they
 * meant.
 */
export async function enqueueRating(input: {
  barcode: string;
  taste: number;
  comment: string | null;
}): Promise<OutboxRating[]> {
  const queue = await readOutbox();
  const previous = queue.find((item) => item.barcode === input.barcode);
  const item: OutboxRating = {
    barcode: input.barcode,
    taste: input.taste,
    comment: input.comment,
    queuedAt: previous?.queuedAt ?? Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
  };
  const next = [...queue.filter((entry) => entry.barcode !== input.barcode), item];
  await writeCache(OUTBOX_DOC, next);
  return next;
}

let inFlight: Promise<FlushResult> | null = null;

/**
 * Send everything that is due. Concurrent callers (foreground event and screen
 * mount often coincide) share one pass rather than racing each other.
 */
export function flushOutbox(): Promise<FlushResult> {
  inFlight ??= runFlush().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runFlush(): Promise<FlushResult> {
  const queue = await readOutbox();
  if (queue.length === 0) return { synced: [], dropped: [], remaining: [] };

  const now = Date.now();
  const synced: string[] = [];
  const dropped: OutboxFailure[] = [];
  const remaining: OutboxRating[] = [];

  for (const item of queue) {
    if (item.nextAttemptAt > now) {
      remaining.push(item);
      continue;
    }
    try {
      const saved = await api.post<RatingEntry>('/api/ratings', {
        barcode: item.barcode,
        taste: item.taste,
        comment: item.comment ?? undefined,
      });
      synced.push(item.barcode);
      // Replace the optimistic local entry with what the server stored, so ids
      // and timestamps stop being made up.
      if (saved?.product?.barcode) await upsertCachedRating(saved);
    } catch (err) {
      if (err instanceof NetworkError) {
        // Still offline — stop early, the rest of the queue would fail too.
        remaining.push(item, ...queue.slice(queue.indexOf(item) + 1));
        break;
      }
      if (isPermanent(err)) {
        dropped.push({ barcode: item.barcode, message: err.message });
        continue;
      }
      remaining.push({
        ...item,
        attempts: item.attempts + 1,
        nextAttemptAt: Date.now() + backoffFor(item.attempts),
      });
    }
  }

  await writeCache(OUTBOX_DOC, remaining);
  return { synced, dropped, remaining };
}

/** Reset the shared flush guard. Tests only. */
export function __resetOutboxFlushForTests(): void {
  inFlight = null;
}
