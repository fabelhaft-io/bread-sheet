import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindUnique = vi.hoisted(() => vi.fn());
const mockFindMany = vi.hoisted(() => vi.fn());
const mockCount = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockGroupBy = vi.hoisted(() => vi.fn());
const mockRatingCount = vi.hoisted(() => vi.fn());

const mockTxRatingUpdateMany = vi.hoisted(() => vi.fn());
const mockTxRatingCount = vi.hoisted(() => vi.fn());
const mockTxUserCategoryDelete = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() =>
  vi.fn(async <T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T> => {
    const tx = {
      rating: { updateMany: mockTxRatingUpdateMany, count: mockTxRatingCount },
      userCategory: { delete: mockTxUserCategoryDelete },
    };
    return fn(tx);
  }),
);

vi.mock('../db.js', () => ({
  default: {
    $transaction: mockTransaction,
    userCategory: {
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      count: mockCount,
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
    },
    rating: {
      groupBy: mockGroupBy,
      count: mockRatingCount,
    },
  },
}));

const FakePrismaKnownRequestError = vi.hoisted(() => {
  return class FakePrismaKnownRequestError extends Error {
    code: string;
    constructor(message: string, opts: { code: string }) {
      super(message);
      this.code = opts.code;
    }
  };
});

vi.mock('../generated/prisma_client/client.js', () => ({
  Prisma: { PrismaClientKnownRequestError: FakePrismaKnownRequestError },
}));

import {
  CategoryForbiddenError,
  CategoryNotFoundError,
  DuplicateCategoryNameError,
  SelfMergeError,
  TooManyCategoriesError,
  createCategory,
  deleteCategory,
  listMyCategories,
  mergeCategory,
  renameCategory,
  resolveRatingCategory,
} from './categoryService.js';
import { CategoryValidationError } from '../validators/categoryValidator.js';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const CATEGORY_ID = 'cat-1';

function resetAllMocks() {
  mockFindUnique.mockReset();
  mockFindMany.mockReset();
  mockCount.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
  mockGroupBy.mockReset();
  mockRatingCount.mockReset();
  mockTxRatingUpdateMany.mockReset();
  mockTxRatingCount.mockReset();
  mockTxUserCategoryDelete.mockReset();
  mockTransaction.mockClear();
}

beforeEach(resetAllMocks);

describe('listMyCategories', () => {
  it('returns an empty list when the user has no categories', async () => {
    mockFindMany.mockResolvedValue([]);
    const result = await listMyCategories(USER_ID);
    expect(result).toEqual([]);
    expect(mockGroupBy).not.toHaveBeenCalled();
  });

  it('attaches a rating count per category, defaulting to 0 for an unrated one', async () => {
    const createdAt = new Date('2026-01-01');
    mockFindMany.mockResolvedValue([
      { id: 'cat-wine', userId: USER_ID, name: 'Wine', slug: 'wine', isSeed: true, createdAt },
      { id: 'cat-cigars', userId: USER_ID, name: 'Cigars', slug: 'cigars', isSeed: true, createdAt },
    ]);
    mockGroupBy.mockResolvedValue([{ categoryId: 'cat-wine', _count: { _all: 3 } }]);

    const result = await listMyCategories(USER_ID);

    expect(result).toEqual([
      { id: 'cat-wine', name: 'Wine', slug: 'wine', isSeed: true, createdAt, ratingCount: 3 },
      { id: 'cat-cigars', name: 'Cigars', slug: 'cigars', isSeed: true, createdAt, ratingCount: 0 },
    ]);
  });
});

describe('createCategory', () => {
  it('creates a custom category, slugifying + case-folding the name', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({
      id: 'cat-new',
      userId: USER_ID,
      name: 'Négroni ',
      slug: 'negroni',
      isSeed: false,
      createdAt: new Date('2026-01-01'),
    });

    const result = await createCategory(USER_ID, { name: 'Négroni ' });

    expect(mockCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, name: 'Négroni ', slug: 'negroni', isSeed: false },
    });
    expect(result).toMatchObject({ id: 'cat-new', slug: 'negroni', ratingCount: 0 });
  });

  it('materialises exactly one row for a seed slug, using the seed canonical name', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({
      id: 'cat-wine',
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });

    const result = await createCategory(USER_ID, { seedSlug: 'wine' });

    expect(mockCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, name: 'Wine', slug: 'wine', isSeed: true },
    });
    expect(result.isSeed).toBe(true);
  });

  it('find-or-create: returns the existing row unchanged when the slug already exists', async () => {
    const existing = {
      id: 'cat-wine',
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    };
    mockFindUnique.mockResolvedValue(existing);
    mockRatingCount.mockResolvedValue(5);

    const result = await createCategory(USER_ID, { seedSlug: 'wine' });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'cat-wine', ratingCount: 5 });
  });

  it('throws TooManyCategoriesError at the 40-category cap', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockCount.mockResolvedValue(40);

    await expect(createCategory(USER_ID, { name: 'One More' })).rejects.toBeInstanceOf(
      TooManyCategoriesError,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a race on (userId, slug) is resolved by returning the winning row, not a 409', async () => {
    mockFindUnique.mockResolvedValueOnce(null); // initial find-or-create check: miss
    mockCount.mockResolvedValue(0);
    mockCreate.mockRejectedValue(
      new FakePrismaKnownRequestError('unique violation', { code: 'P2002' }),
    );
    mockFindUnique.mockResolvedValueOnce({
      id: 'cat-winner',
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    mockRatingCount.mockResolvedValue(0);

    const result = await createCategory(USER_ID, { seedSlug: 'wine' });
    expect(result.id).toBe('cat-winner');
  });

  it('rejects a name that slugifies to nothing (e.g. only punctuation)', async () => {
    await expect(createCategory(USER_ID, { name: '!!!' })).rejects.toBeInstanceOf(
      CategoryValidationError,
    );
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

describe('renameCategory', () => {
  it('renames and re-slugifies a category the user owns', async () => {
    mockFindUnique.mockResolvedValue({
      id: CATEGORY_ID,
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    mockUpdate.mockResolvedValue({
      id: CATEGORY_ID,
      userId: USER_ID,
      name: 'Fine Wine',
      slug: 'fine-wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    mockRatingCount.mockResolvedValue(2);

    const result = await renameCategory(USER_ID, CATEGORY_ID, 'Fine Wine');

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: CATEGORY_ID },
      data: { name: 'Fine Wine', slug: 'fine-wine' },
    });
    expect(result).toMatchObject({ name: 'Fine Wine', slug: 'fine-wine', ratingCount: 2 });
  });

  it('throws CategoryNotFoundError for an unknown id', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(renameCategory(USER_ID, CATEGORY_ID, 'New Name')).rejects.toBeInstanceOf(
      CategoryNotFoundError,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws CategoryForbiddenError for another user's category", async () => {
    mockFindUnique.mockResolvedValue({
      id: CATEGORY_ID,
      userId: OTHER_USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    await expect(renameCategory(USER_ID, CATEGORY_ID, 'New Name')).rejects.toBeInstanceOf(
      CategoryForbiddenError,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('a rename that collides with another of the caller\'s own categories is 409 duplicate_category', async () => {
    mockFindUnique.mockResolvedValue({
      id: CATEGORY_ID,
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    mockUpdate.mockRejectedValue(
      new FakePrismaKnownRequestError('unique violation', { code: 'P2002' }),
    );
    mockFindUnique.mockResolvedValueOnce({
      id: CATEGORY_ID,
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    mockFindUnique.mockResolvedValueOnce({ id: 'cat-cigars', name: 'Cigars' });

    let caught: unknown;
    try {
      await renameCategory(USER_ID, CATEGORY_ID, 'Cigars');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DuplicateCategoryNameError);
    expect((caught as DuplicateCategoryNameError).categoryId).toBe('cat-cigars');
  });
});

describe('deleteCategory', () => {
  it('deletes a category the user owns (ratings are not touched here — onDelete: SetNull)', async () => {
    mockFindUnique.mockResolvedValue({
      id: CATEGORY_ID,
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    mockDelete.mockResolvedValue({});

    await deleteCategory(USER_ID, CATEGORY_ID);

    expect(mockDelete).toHaveBeenCalledWith({ where: { id: CATEGORY_ID } });
  });

  it('throws CategoryForbiddenError for another user\'s category and does not delete', async () => {
    mockFindUnique.mockResolvedValue({
      id: CATEGORY_ID,
      userId: OTHER_USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    await expect(deleteCategory(USER_ID, CATEGORY_ID)).rejects.toBeInstanceOf(
      CategoryForbiddenError,
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('mergeCategory', () => {
  it('reassigns ratings from source to target, then deletes the source, in one transaction', async () => {
    mockFindUnique.mockImplementation(({ where: { id } }: { where: { id: string } }) => {
      if (id === 'cat-source') {
        return Promise.resolve({
          id: 'cat-source',
          userId: USER_ID,
          name: 'Wines',
          slug: 'wines',
          isSeed: false,
          createdAt: new Date('2026-01-01'),
        });
      }
      return Promise.resolve({
        id: 'cat-target',
        userId: USER_ID,
        name: 'Wine',
        slug: 'wine',
        isSeed: true,
        createdAt: new Date('2026-01-01'),
      });
    });
    mockTxRatingUpdateMany.mockResolvedValue({ count: 2 });
    mockTxUserCategoryDelete.mockResolvedValue({});
    mockTxRatingCount.mockResolvedValue(2);

    const result = await mergeCategory(USER_ID, 'cat-source', 'cat-target');

    expect(mockTxRatingUpdateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, categoryId: 'cat-source' },
      data: { categoryId: 'cat-target' },
    });
    expect(mockTxUserCategoryDelete).toHaveBeenCalledWith({ where: { id: 'cat-source' } });
    expect(result).toMatchObject({ id: 'cat-target', ratingCount: 2 });
  });

  it('throws SelfMergeError when source and target are the same id', async () => {
    await expect(mergeCategory(USER_ID, CATEGORY_ID, CATEGORY_ID)).rejects.toBeInstanceOf(
      SelfMergeError,
    );
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("throws CategoryForbiddenError when the target belongs to another user", async () => {
    mockFindUnique.mockImplementation(({ where: { id } }: { where: { id: string } }) => {
      if (id === 'cat-source') {
        return Promise.resolve({ id: 'cat-source', userId: USER_ID, name: 'A', slug: 'a', isSeed: false, createdAt: new Date() });
      }
      return Promise.resolve({ id: 'cat-target', userId: OTHER_USER_ID, name: 'B', slug: 'b', isSeed: false, createdAt: new Date() });
    });

    await expect(mergeCategory(USER_ID, 'cat-source', 'cat-target')).rejects.toBeInstanceOf(
      CategoryForbiddenError,
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe('resolveRatingCategory', () => {
  it("{ kind: 'unset' } resolves to { kind: 'unset' } (no DB call)", async () => {
    const result = await resolveRatingCategory(USER_ID, { kind: 'unset' });
    expect(result).toEqual({ kind: 'unset' });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("{ kind: 'clear' } resolves to { kind: 'set', categoryId: null }", async () => {
    const result = await resolveRatingCategory(USER_ID, { kind: 'clear' });
    expect(result).toEqual({ kind: 'set', categoryId: null });
  });

  it("{ kind: 'id' } resolves after an ownership check", async () => {
    mockFindUnique.mockResolvedValue({
      id: CATEGORY_ID,
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    const result = await resolveRatingCategory(USER_ID, { kind: 'id', categoryId: CATEGORY_ID });
    expect(result).toEqual({ kind: 'set', categoryId: CATEGORY_ID });
  });

  it("{ kind: 'id' } throws CategoryForbiddenError for another user's category", async () => {
    mockFindUnique.mockResolvedValue({
      id: CATEGORY_ID,
      userId: OTHER_USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });
    await expect(
      resolveRatingCategory(USER_ID, { kind: 'id', categoryId: CATEGORY_ID }),
    ).rejects.toBeInstanceOf(CategoryForbiddenError);
  });

  it("{ kind: 'seed' } find-or-creates the seed for this user", async () => {
    mockFindUnique.mockResolvedValue(null);
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({
      id: 'cat-wine',
      userId: USER_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date('2026-01-01'),
    });

    const result = await resolveRatingCategory(USER_ID, { kind: 'seed', seedSlug: 'wine' });
    expect(result).toEqual({ kind: 'set', categoryId: 'cat-wine' });
  });
});
