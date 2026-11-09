import { normalizeSearchText } from '@/features/search/match';

/**
 * "Did you mean…?" near-match for a newly-typed custom category name
 * (TICKET-P6-003), checked against the user's own categories and the seed
 * list before creating. A nudge, not a gate — rejecting the suggestion still
 * creates the new category.
 *
 * Plain string operations, never a regex over user input: `levenshtein`
 * below is ordinary nested-loop arithmetic, not pattern matching, and both
 * its inputs are already capped at
 * `CATEGORY_NAME_MAX_RAW_CHARS` (24) by `validateCategoryName` before this
 * ever runs, so the O(n·m) cost is bounded by construction.
 */

/** Ordinary edit distance — bounded by the 24-char cap on both inputs. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Normalised similarity in `[0, 1]`: `1` is an exact match (case/diacritic
 * insensitive, via the same normalisation `features/search/match.ts` uses),
 * `0` shares nothing.
 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeSearchText(a.trim());
  const y = normalizeSearchText(b.trim());
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(x, y) / maxLen;
}

/** Below this similarity, two names are considered unrelated. */
export const CATEGORY_NEAR_MATCH_THRESHOLD = 0.7;

export interface NearMatchCandidate {
  name: string;
}

/**
 * The closest candidate to `query`, or `null` if nothing clears
 * {@link CATEGORY_NEAR_MATCH_THRESHOLD}. Candidates are typically the user's
 * own categories concatenated with the seed list; takes the best score
 * rather than assuming any particular ordering.
 */
export function findNearMatch<T extends NearMatchCandidate>(
  query: string,
  candidates: readonly T[],
): T | null {
  if (!query.trim()) return null;
  let best: T | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = nameSimilarity(query, candidate.name);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best && bestScore >= CATEGORY_NEAR_MATCH_THRESHOLD ? best : null;
}
