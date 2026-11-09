import { api } from '@/lib/api';

import { createCategory, deleteCategory, listMyCategories, mergeCategory, renameCategory } from './api';

jest.mock('@/lib/api');

const mockApi = api as unknown as {
  get: jest.Mock;
  post: jest.Mock;
  patch: jest.Mock;
  delete: jest.Mock;
};

describe('categories api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists my categories', () => {
    listMyCategories();
    expect(mockApi.get).toHaveBeenCalledWith('/api/users/me/categories');
  });

  it('creates by name', () => {
    createCategory({ name: 'Wine' });
    expect(mockApi.post).toHaveBeenCalledWith('/api/users/me/categories', { name: 'Wine' });
  });

  it('creates (find-or-create) by seedSlug', () => {
    createCategory({ seedSlug: 'wine' });
    expect(mockApi.post).toHaveBeenCalledWith('/api/users/me/categories', { seedSlug: 'wine' });
  });

  it('renames', () => {
    renameCategory('c1', 'Reds');
    expect(mockApi.patch).toHaveBeenCalledWith('/api/users/me/categories/c1', { name: 'Reds' });
  });

  it('deletes', () => {
    deleteCategory('c1');
    expect(mockApi.delete).toHaveBeenCalledWith('/api/users/me/categories/c1');
  });

  it('merges into another category', () => {
    mergeCategory('c1', 'c2');
    expect(mockApi.post).toHaveBeenCalledWith('/api/users/me/categories/c1/merge', { intoId: 'c2' });
  });

  it('encodes ids in the URL', () => {
    renameCategory('weird/id', 'Reds');
    expect(mockApi.patch).toHaveBeenCalledWith(
      '/api/users/me/categories/weird%2Fid',
      { name: 'Reds' },
    );
  });
});
