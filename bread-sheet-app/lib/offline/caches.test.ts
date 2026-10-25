import type { ProductDetail } from '@/features/products/types';
import type { RatingEntry } from '@/features/ratings/types';

import {
  PRODUCT_CACHE_LIMIT,
  findCachedRating,
  peekProductIdByGtin,
  productCache,
  ratingsCache,
  readProductIdByGtin,
  upsertCachedRating,
} from './caches';
import { __resetOfflineStoreForTests, setActiveCacheUser } from './store';

jest.mock('expo-file-system/legacy', () => {
  const files = new Map<string, string>();
  return {
    __files: files,
    documentDirectory: 'file:///documents/',
    getInfoAsync: jest.fn(async (uri: string) => ({ exists: files.has(uri) })),
    readAsStringAsync: jest.fn(async (uri: string) => {
      const value = files.get(uri);
      if (value === undefined) throw new Error(`ENOENT: ${uri}`);
      return value;
    }),
    writeAsStringAsync: jest.fn(async (uri: string, contents: string) => {
      files.set(uri, contents);
    }),
    deleteAsync: jest.fn(async (uri: string) => {
      for (const key of [...files.keys()]) if (key.startsWith(uri)) files.delete(key);
    }),
    makeDirectoryAsync: jest.fn(async () => {}),
    readDirectoryAsync: jest.fn(async () => []),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const files = (require('expo-file-system/legacy') as { __files: Map<string, string> }).__files;

function product(id: string, gtin?: string): ProductDetail {
  return {
    id,
    kind: 'PACKAGED',
    name: `Product ${id}`,
    brand: null,
    image: null,
    description: null,
    packaged: gtin
      ? {
          gtin,
          genericName: null,
          energyKcal: null,
          fat: null,
          saturatedFat: null,
          carbohydrates: null,
          sugars: null,
          protein: null,
          salt: null,
          servingSize: null,
          ingredients: null,
        }
      : null,
  };
}

function rating(productId: string, taste: number): RatingEntry {
  return {
    id: `r-${productId}`,
    score: taste,
    taste,
    comment: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    product: { id: productId, kind: 'PACKAGED', name: `Product ${productId}`, brand: null, image: null },
  };
}

describe('offline caches', () => {
  beforeEach(() => {
    files.clear();
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');
  });

  describe('product cache', () => {
    it('round-trips a product by id', async () => {
      await productCache('111').write(product('111'));
      expect(await productCache('111').read()).toEqual(product('111'));
      expect(await productCache('222').read()).toBeNull();
    });

    it('indexes the product by its gtin so a scan can resolve offline', async () => {
      await productCache('p1').write(product('p1', '4006381333931'));

      expect(peekProductIdByGtin('4006381333931')).toBe('p1');
      expect(await readProductIdByGtin('4006381333931')).toBe('p1');
      expect(peekProductIdByGtin('0000000000000')).toBeNull();
    });

    it('caps at the LRU limit, evicting the least recently written', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      for (let i = 0; i < PRODUCT_CACHE_LIMIT + 5; i += 1) {
        nowSpy.mockReturnValue(1_000 + i);
        await productCache(`id-${i}`).write(product(`id-${i}`, `gtin-${i}`));
      }
      nowSpy.mockRestore();

      // The five oldest are gone; the newest survive.
      expect(await productCache('id-0').read()).toBeNull();
      expect(await productCache('id-4').read()).toBeNull();
      expect(await productCache('id-5').read()).not.toBeNull();
      expect(await productCache(`id-${PRODUCT_CACHE_LIMIT + 4}`).read()).not.toBeNull();

      // Evicted ids' gtin-index entries go with them — a stale index entry
      // would resolve to a product no longer on disk.
      expect(peekProductIdByGtin('gtin-0')).toBeNull();
      expect(peekProductIdByGtin(`gtin-${PRODUCT_CACHE_LIMIT + 4}`)).toBe(
        `id-${PRODUCT_CACHE_LIMIT + 4}`,
      );
    });

    it('keeps a product alive when it is re-written after others', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValue(1);
      await productCache('keep-me').write(product('keep-me'));
      for (let i = 0; i < PRODUCT_CACHE_LIMIT; i += 1) {
        nowSpy.mockReturnValue(10 + i);
        await productCache(`filler-${i}`).write(product(`filler-${i}`));
      }
      nowSpy.mockReturnValue(10_000);
      await productCache('keep-me').write(product('keep-me'));
      nowSpy.mockRestore();

      expect(await productCache('keep-me').read()).not.toBeNull();
    });
  });

  describe('ratings cache', () => {
    it('finds the caller’s rating for a product id', () => {
      const list = [rating('111', 7), rating('222', 3)];
      expect(findCachedRating(list, '222')?.taste).toBe(3);
      expect(findCachedRating(list, '333')).toBeNull();
      expect(findCachedRating(null, '111')).toBeNull();
    });

    it('upserts a rating to the front of the list without duplicating', async () => {
      await ratingsCache.write([rating('111', 7), rating('222', 3)]);
      await upsertCachedRating(rating('222', 9));

      const stored = await ratingsCache.read();
      expect(stored).toHaveLength(2);
      expect(stored?.[0].product.id).toBe('222');
      expect(stored?.[0].taste).toBe(9);
    });

    it('adds a rating when the cache is empty', async () => {
      await upsertCachedRating(rating('111', 5));
      expect(await ratingsCache.read()).toHaveLength(1);
    });
  });
});
