import prisma from '../db.js';
import { Prisma } from '../generated/prisma_client/client.js';
import { ProductKind, ProductStatus } from '../generated/prisma_client/enums.js';
import { INVISIBLE_PRODUCT_STATUS, type VisibilityUser } from './productVisibility.js';
import { resolveImageUrl } from './imageService.js';
import { isValidUuid } from '../validators/idValidator.js';

/**
 * TICKET-P6-008 Slice B — `GET /api/products/search`.
 *
 * Visibility is enforced in the `WHERE` clause of the raw query below using
 * `productVisibility`'s `INVISIBLE_PRODUCT_STATUS` constant — the one place
 * the rule lives (see that module's docstring) — not a second copy of the
 * `REJECTED` predicate. `visibleProductWhere()`'s Prisma `where` object
 * itself can't be reused here: `$queryRaw` needs a SQL fragment, not a
 * Prisma Client filter object, because ranking by `pg_trgm`'s `similarity()`
 * and tie-breaking by a `Rating` COUNT aren't expressible through the query
 * builder.
 */

export const SEARCH_PAGE_SIZE = 20;

// Project convention (CLAUDE.md): cap raw input length before any parsing,
// measured on the raw string — `.trim().length` would report near-zero for a
// body that is almost entirely whitespace, which is the attack shape.
const MAX_RAW_QUERY_LENGTH = 100;
const MIN_TRIMMED_QUERY_LENGTH = 2;

export class SearchValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SearchValidationError';
  }
}

/**
 * Validates and trims `q`. Never used to build a regex or SQL fragment —
 * the trimmed string is only ever passed on as a bound parameter.
 */
export function parseSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new SearchValidationError('query_required', 'q is required');
  }
  // Measured BEFORE trimming.
  if (raw.length > MAX_RAW_QUERY_LENGTH) {
    throw new SearchValidationError(
      'query_too_long',
      `q must be at most ${MAX_RAW_QUERY_LENGTH} characters`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_TRIMMED_QUERY_LENGTH) {
    throw new SearchValidationError(
      'query_too_short',
      `q must be at least ${MIN_TRIMMED_QUERY_LENGTH} characters after trimming`,
    );
  }
  return trimmed;
}

/**
 * Opaque cursor over the (similarity DESC, ratingCount DESC, id ASC)
 * ordering — the same ordering the query is sorted by, so keyset pagination
 * stays stable under concurrent writes (no OFFSET). Bound to the exact query
 * string it was issued for: reusing a cursor against a different `q` is
 * rejected rather than silently producing a nonsensical page, since the
 * ranking values it encodes only mean anything for that one query.
 */
interface SearchCursor {
  q: string;
  s: number;
  r: number;
  id: string;
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function isSearchCursorShape(value: unknown): value is SearchCursor {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.q === 'string' &&
    typeof v.s === 'number' &&
    Number.isFinite(v.s) &&
    typeof v.r === 'number' &&
    Number.isInteger(v.r) &&
    v.r >= 0 &&
    typeof v.id === 'string' &&
    isValidUuid(v.id)
  );
}

/** Returns `undefined` for "no cursor" (first page); throws on anything malformed. */
export function decodeSearchCursor(
  raw: unknown,
  query: string,
): SearchCursor | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > 2048) {
    throw new SearchValidationError('invalid_cursor', 'cursor is malformed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new SearchValidationError('invalid_cursor', 'cursor is malformed');
  }

  if (!isSearchCursorShape(parsed)) {
    throw new SearchValidationError('invalid_cursor', 'cursor is malformed');
  }
  if (parsed.q !== query) {
    throw new SearchValidationError(
      'invalid_cursor',
      'cursor does not match this query',
    );
  }
  return parsed;
}

interface SearchRow {
  id: string;
  kind: ProductKind;
  name: string;
  brand: string | null;
  image: string | null;
  status: ProductStatus;
  similarity: number;
  ratingCount: number;
}

export interface SearchResultItem {
  id: string;
  kind: ProductKind;
  name: string;
  brand: string | null;
  image: string | null;
  unverified: boolean;
  similarity: number;
}

export interface SearchResult {
  results: SearchResultItem[];
  nextCursor: string | null;
}

/**
 * `rawQuery`/`rawCursor` are whatever arrived on `req.query` — validated and
 * decoded here so the controller stays a thin HTTP adapter. Throws
 * `SearchValidationError` for the controller to map to `400`.
 */
export async function searchProducts(
  _user: VisibilityUser | undefined,
  rawQuery: unknown,
  rawCursor: unknown,
): Promise<SearchResult> {
  const query = parseSearchQuery(rawQuery);
  const cursor = decodeSearchCursor(rawCursor, query);

  // Keyset predicate for ORDER BY similarity DESC, ratingCount DESC, id ASC:
  // strictly-after the cursor row in that exact ordering.
  const cursorCondition = cursor
    ? Prisma.sql`AND (
        m.similarity < ${cursor.s}
        OR (m.similarity = ${cursor.s} AND m."ratingCount" < ${cursor.r})
        OR (m.similarity = ${cursor.s} AND m."ratingCount" = ${cursor.r} AND m.id > ${cursor.id})
      )`
    : Prisma.empty;

  // `query` and `INVISIBLE_PRODUCT_STATUS` are only ever bound as parameters
  // (the `${}` interpolations below) — never spliced into the SQL text.
  // Matching uses pg_trgm's `%` operator rather than ILIKE so "nutela" finds
  // "Nutella": `%` respects the session's `pg_trgm.similarity_threshold` GUC
  // (default 0.3), and similarity('nutela', 'nutella') ≈ 0.667, comfortably
  // above it (see docs/architecture/backend.md for the measured value).
  const rows = await prisma.$queryRaw<SearchRow[]>`
    WITH matches AS (
      SELECT
        p.id,
        p.kind,
        p.name,
        p.brand,
        p.image,
        p.status,
        similarity(p.name, ${query}) AS similarity,
        (
          SELECT COUNT(*)::int FROM "Rating" r WHERE r."productId" = p.id
        ) AS "ratingCount"
      FROM "Product" p
      WHERE p.status <> ${INVISIBLE_PRODUCT_STATUS}
        AND (
          p.name % ${query}
          OR (p.brand IS NOT NULL AND p.brand % ${query})
        )
    )
    SELECT m.id, m.kind, m.name, m.brand, m.image, m.status, m.similarity, m."ratingCount"
    FROM matches m
    WHERE true ${cursorCondition}
    ORDER BY m.similarity DESC, m."ratingCount" DESC, m.id ASC
    LIMIT ${SEARCH_PAGE_SIZE + 1}
  `;

  const hasMore = rows.length > SEARCH_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, SEARCH_PAGE_SIZE) : rows;

  const results: SearchResultItem[] = page.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    brand: row.brand,
    image: resolveImageUrl(row.image),
    unverified: row.status !== ProductStatus.VERIFIED,
    similarity: row.similarity,
  }));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1]!;
    nextCursor = encodeSearchCursor({
      q: query,
      s: last.similarity,
      r: last.ratingCount,
      id: last.id,
    });
  }

  return { results, nextCursor };
}
