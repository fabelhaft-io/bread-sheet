/**
 * Shared validator for `Product.id` (and other server-generated UUID ids)
 * wherever they arrive as a route param or a request-body field (TICKET-P6-009).
 *
 * Fixed-length character classes only, no adjacent quantifiers of the same
 * class — this cannot backtrack super-linearly regardless of input length,
 * so it needs no separate length cap before matching (length is bounded by
 * construction), though callers still guard the type at the door.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && UUID_RE.test(value);
}
