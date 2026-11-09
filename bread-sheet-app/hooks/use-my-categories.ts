import { listMyCategories } from '@/features/categories/api';
import type { UserCategory } from '@/features/categories/types';
import { categoriesCache } from '@/lib/offline/caches';

import { useCachedResource } from './use-cached-resource';

/**
 * The caller's own categories (TICKET-P6-003), stale-while-revalidate over
 * the on-disk cache — same pattern `app/(tabs)/index.tsx` uses for the
 * ratings list. Backs both the rating screen's category picker and the
 * Manage Categories screen, so a rename/merge/delete that one of them
 * performs is visible to the other on next read without extra plumbing.
 */
export function useMyCategories(userId: string | null) {
  const { data, isLoading, isOffline, error, refresh } = useCachedResource<UserCategory[]>({
    key: userId ? `categories:${userId}` : null,
    cache: categoriesCache,
    fetcher: listMyCategories,
  });

  return { categories: data ?? [], isLoading, isOffline, error, refresh };
}
