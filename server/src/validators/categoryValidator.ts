import { isValidUuid } from './idValidator.js';
import { isSeedSlug } from '../constants/categorySeeds.js';

/**
 * TICKET-P6-003 — validators for the `/api/users/me/categories` family and
 * the optional category fields on `POST /api/ratings`.
 */

export class CategoryValidationError extends Error {
  readonly code = 'category_validation_error';
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_NAME_LENGTH = 24;

/**
 * 1–24 chars after trimming, with the cap measured on the RAW string before
 * trimming (CLAUDE.md convention — padding can't rescue an over-long name).
 */
export function validateCategoryName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CategoryValidationError('name', 'name must be a string');
  }
  if (value.length === 0) {
    throw new CategoryValidationError('name', 'name is required');
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new CategoryValidationError(
      'name',
      `name must be at most ${MAX_NAME_LENGTH} characters`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CategoryValidationError('name', 'name is required');
  }
  return trimmed;
}

export type CategoryCreateInput = { name: string } | { seedSlug: string };

// Exactly the wire shape in the API contract: `{ name }` XOR `{ seedSlug }`.
const CREATE_KEYS = new Set(['name', 'seedSlug']);

export function validateCategoryCreate(body: unknown): CategoryCreateInput {
  if (!body || typeof body !== 'object') {
    throw new CategoryValidationError('body', 'Request body required');
  }
  const b = body as Record<string, unknown>;

  for (const key of Object.keys(b)) {
    if (!CREATE_KEYS.has(key)) {
      throw new CategoryValidationError(key, `${key} is not a recognised field`);
    }
  }

  const hasName = b.name !== undefined && b.name !== null;
  const hasSeedSlug = b.seedSlug !== undefined && b.seedSlug !== null;

  if (hasName === hasSeedSlug) {
    throw new CategoryValidationError('body', 'Provide exactly one of name or seedSlug');
  }

  if (hasSeedSlug) {
    if (typeof b.seedSlug !== 'string' || b.seedSlug.length > 64 || !isSeedSlug(b.seedSlug)) {
      throw new CategoryValidationError('seedSlug', 'seedSlug is not a recognised seed');
    }
    return { seedSlug: b.seedSlug };
  }

  return { name: validateCategoryName(b.name) };
}

export interface CategoryRenameInput {
  name: string;
}

const RENAME_KEYS = new Set(['name']);

export function validateCategoryRename(body: unknown): CategoryRenameInput {
  if (!body || typeof body !== 'object') {
    throw new CategoryValidationError('body', 'Request body required');
  }
  const b = body as Record<string, unknown>;

  for (const key of Object.keys(b)) {
    if (!RENAME_KEYS.has(key)) {
      throw new CategoryValidationError(key, `${key} is not a recognised field`);
    }
  }

  return { name: validateCategoryName(b.name) };
}

export interface CategoryMergeInput {
  intoId: string;
}

const MERGE_KEYS = new Set(['intoId']);

export function validateCategoryMerge(body: unknown): CategoryMergeInput {
  if (!body || typeof body !== 'object') {
    throw new CategoryValidationError('body', 'Request body required');
  }
  const b = body as Record<string, unknown>;

  for (const key of Object.keys(b)) {
    if (!MERGE_KEYS.has(key)) {
      throw new CategoryValidationError(key, `${key} is not a recognised field`);
    }
  }

  if (!isValidUuid(b.intoId)) {
    throw new CategoryValidationError('intoId', 'intoId must be a valid id');
  }

  return { intoId: b.intoId };
}

/**
 * The optional category fields on `POST /api/ratings` — `categoryId`
 * (caller's own category, or `null` to explicitly clear one) XOR `seedSlug`
 * (find-or-create in the same request). Both omitted (`undefined`) means
 * "leave the rating's category untouched" — see
 * `services/categoryService.ts#resolveRatingCategory` for why that matters
 * for the offline rating outbox's last-write-wins replay.
 */
export type RatingCategoryInput =
  | { kind: 'unset' }
  | { kind: 'clear' }
  | { kind: 'id'; categoryId: string }
  | { kind: 'seed'; seedSlug: string };

export function validateRatingCategoryFields(body: Record<string, unknown>): RatingCategoryInput {
  const hasCategoryId = 'categoryId' in body && body.categoryId !== undefined;
  const hasSeedSlug = 'seedSlug' in body && body.seedSlug !== undefined;

  if (hasCategoryId && hasSeedSlug) {
    throw new CategoryValidationError('body', 'Provide at most one of categoryId or seedSlug');
  }

  if (hasCategoryId) {
    if (body.categoryId === null) {
      return { kind: 'clear' };
    }
    if (!isValidUuid(body.categoryId)) {
      throw new CategoryValidationError('categoryId', 'categoryId must be a valid id or null');
    }
    return { kind: 'id', categoryId: body.categoryId };
  }

  if (hasSeedSlug) {
    if (
      typeof body.seedSlug !== 'string' ||
      body.seedSlug.length > 64 ||
      !isSeedSlug(body.seedSlug)
    ) {
      throw new CategoryValidationError('seedSlug', 'seedSlug is not a recognised seed');
    }
    return { kind: 'seed', seedSlug: body.seedSlug };
  }

  return { kind: 'unset' };
}
