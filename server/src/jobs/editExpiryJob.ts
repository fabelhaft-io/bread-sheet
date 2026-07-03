import logger from '../logger.js';
import { expireStaleEdits } from '../services/productEditService.js';

// Once per day. The exact hour is not critical — the expiry window is 2 years —
// so a plain interval (first run at startup, then every 24 h) is sufficient and
// avoids a scheduler dependency. Can be extracted to a Lambda later without
// changing the underlying `expireStaleEdits` logic.
export const EDIT_EXPIRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runOnce(): Promise<void> {
  try {
    const expired = await expireStaleEdits();
    if (expired > 0) {
      logger.info('edit expiry job: expired stale product edits', { expired });
    } else {
      logger.debug('edit expiry job: nothing to expire');
    }
  } catch (err) {
    logger.error('edit expiry job failed', { err });
  }
}

/**
 * Daily cleanup (TICKET-P5-006): voteless PENDING ProductEdits past their
 * `expiresAt` (2 years) flip to EXPIRED so stale proposals stop occupying the
 * one-pending-edit-per-barcode slot. Runs inside the server process.
 *
 * Returns the interval handle so tests (or a graceful shutdown path) can stop it.
 */
export function startEditExpiryJob(): NodeJS.Timeout {
  void runOnce(); // catch up immediately on boot, don't wait a day
  const handle = setInterval(() => void runOnce(), EDIT_EXPIRY_INTERVAL_MS);
  handle.unref(); // never keep the process alive just for the sweeper
  logger.info('edit expiry job scheduled (daily)');
  return handle;
}
