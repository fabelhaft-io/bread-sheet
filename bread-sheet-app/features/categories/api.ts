import { api } from '@/lib/api';

import type { CreateCategoryPayload, UserCategory } from './types';

/**
 * API helpers for the category endpoints (TICKET-P6-003). Each maps 1:1 to a
 * backend route; screens and components call these rather than `lib/api`
 * directly, mirroring `features/products/api.ts`.
 *
 * `requireAuth` only on every one of these — not `requireRegistered` — so an
 * anonymous session can create and use categories exactly like a registered
 * one (confirmed in the ticket: a category is private by construction, so
 * none of the accountability arguments behind `requireRegistered` apply).
 */

/** The caller's own categories, with rating counts. Unused seeds are not included. */
export function listMyCategories() {
  return api.get<UserCategory[]>('/api/users/me/categories');
}

/** Find-or-create: `{ name }` for a brand-new custom category, `{ seedSlug }` to materialise a seed. */
export function createCategory(payload: CreateCategoryPayload) {
  return api.post<UserCategory>('/api/users/me/categories', payload);
}

/** Rename — free and retroactive, no per-rating writes. */
export function renameCategory(id: string, name: string) {
  return api.patch<UserCategory>(`/api/users/me/categories/${encodeURIComponent(id)}`, { name });
}

/**
 * Deletes the category; its ratings survive, uncategorised. `204 No
 * Content` — `lib/api.ts`'s `request()` resolves this to `undefined`
 * rather than attempting to parse an empty body.
 */
export function deleteCategory(id: string) {
  return api.delete<void>(`/api/users/me/categories/${encodeURIComponent(id)}`);
}

/**
 * Reassigns `id`'s ratings onto `intoId`, then deletes `id`. Resolves to
 * the target category's updated serialized form (its `ratingCount` now
 * includes the reassigned ratings) — not a bare `{ merged: boolean }`.
 */
export function mergeCategory(id: string, intoId: string) {
  return api.post<UserCategory>(
    `/api/users/me/categories/${encodeURIComponent(id)}/merge`,
    { intoId },
  );
}
