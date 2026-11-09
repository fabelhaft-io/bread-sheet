/**
 * TICKET-P6-007 — the single shared normaliser behind `Product.nameKey`.
 *
 * A custom product's identity is its name alone (ADR 0006 / decision 3 of
 * the ticket): "Negroni", "negroni" and "Négroni " must all resolve to the
 * same row. This is the one place that normalisation happens — both the
 * create path (`POST /api/custom-products`) and the rename paths (`PATCH
 * /products/:productId`, `POST /products/:productId/edits`) call it, so the
 * hand-written partial unique index (`custom_product_name_unique`) and the
 * application-level pre-check it backs are always comparing the same key.
 *
 * Steps: Unicode NFKD decomposition, strip combining marks (diacritics),
 * lowercase, collapse internal whitespace, trim.
 *
 * `\s+` below is the only quantifier and there is nothing adjacent to it that
 * shares its character class, so it cannot backtrack super-linearly; callers
 * are expected to cap the raw input length before this ever runs (the
 * create/edit validators cap `name` at 80 chars measured on the raw string).
 */
export function normalizeProductName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritical marks
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
