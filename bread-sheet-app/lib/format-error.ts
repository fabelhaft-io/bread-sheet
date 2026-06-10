import { ApiError } from './api';

/**
 * Turn any thrown value into a short, user-facing message.
 *
 * Rules:
 *   - For an `ApiError`, branch on the HTTP status:
 *       401 / 403 — auth / permission copy
 *       404       — not found copy
 *       409       — conflict copy
 *       429       — rate-limit copy
 *       5xx       — generic "something went wrong" copy
 *     For 4xx codes not in this list, the server-provided message is
 *     reused (validators on the server are responsible for writing safe
 *     copy for those).
 *   - For a plain `Error` we use a generic network/unknown message — the
 *     raw `.message` (e.g. `Network request failed`, `JSON parse error`)
 *     is rarely something we want to show users.
 *   - For anything else, a final fallback.
 *
 * `fallback` lets the caller customise the copy for unknown / 5xx errors —
 * e.g. a rating screen can pass "Could not submit your rating." instead of
 * the generic default.
 */
export function formatApiError(err: unknown, fallback?: string): string {
  const FALLBACK = fallback ?? 'Something went wrong. Please try again.';

  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return 'Your session has expired. Please sign in again.';
      case 403:
        // The server's message for 403 is usually short and safe to show
        // ("Registration required", "You do not have permission to do that.")
        return err.message?.trim() ? err.message : 'You do not have permission to do that.';
      case 404:
        return 'We could not find what you were looking for.';
      case 409:
        return err.message?.trim() ? err.message : 'That conflicts with the current state. Please refresh.';
      case 415:
        return 'That file type is not supported.';
      case 422:
        return err.message?.trim() ? err.message : 'The request could not be processed.';
      case 429:
        return 'You are doing that too often. Please try again in a moment.';
      default:
        if (err.status >= 500) return FALLBACK;
        // Generic 4xx — server message is the source of truth for safe copy.
        return err.message?.trim() ? err.message : FALLBACK;
    }
  }

  // Network errors / aborted fetches / unexpected runtime exceptions.
  if (err instanceof Error) {
    return FALLBACK;
  }

  return FALLBACK;
}
