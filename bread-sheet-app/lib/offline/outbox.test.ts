import type { RatingEntry } from '@/features/ratings/types';
import { ApiError, NetworkError, api } from '@/lib/api';

import { ratingsCache } from './caches';
import {
  BASE_BACKOFF_MS,
  __resetOutboxFlushForTests,
  enqueueRating,
  flushOutbox,
  peekOutbox,
  readOutbox,
} from './outbox';
import { __resetOfflineStoreForTests, setActiveCacheUser } from './store';

jest.mock('@/lib/api');

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

const mockPost = api.post as jest.Mock;

function savedRating(
  productId: string,
  taste: number,
  kind: 'PACKAGED' | 'CUSTOM' = 'PACKAGED',
  category: RatingEntry['category'] = null,
): RatingEntry {
  return {
    id: `r-${productId}`,
    score: taste,
    taste,
    comment: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    product: { id: productId, kind, name: kind === 'CUSTOM' ? 'Negroni' : 'Bread', brand: null, image: null },
    category,
  };
}

describe('rating outbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    files.clear();
    __resetOfflineStoreForTests();
    __resetOutboxFlushForTests();
    setActiveCacheUser('u1');
  });

  it('queues a rating and exposes it synchronously', async () => {
    await enqueueRating({ productId: '111', taste: 7, comment: 'nice' });
    expect(peekOutbox()).toHaveLength(1);
    expect(peekOutbox()[0]).toMatchObject({ productId: '111', taste: 7, comment: 'nice' });
  });

  it('collapses repeated offline edits of the same product to the latest value', async () => {
    await enqueueRating({ productId: '111', taste: 3, comment: null });
    await enqueueRating({ productId: '111', taste: 6, comment: null });
    await enqueueRating({ productId: '111', taste: 9, comment: 'final' });

    const queue = await readOutbox();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ taste: 9, comment: 'final' });
  });

  // TICKET-P6-003: categorising offline carries through the whole queue,
  // whether the user picked an existing own category (`categoryId`) or a
  // seed this device could not materialise while offline (`seedSlug`).
  it('carries categoryId through the queue', async () => {
    await enqueueRating({ productId: '111', taste: 7, comment: null, categoryId: 'cat-1' });
    expect(peekOutbox()[0]).toMatchObject({ productId: '111', categoryId: 'cat-1' });
  });

  it('carries seedSlug through the queue', async () => {
    await enqueueRating({ productId: '111', taste: 7, comment: null, seedSlug: 'wine' });
    expect(peekOutbox()[0]).toMatchObject({ productId: '111', seedSlug: 'wine' });
  });

  it('carries an explicit categoryId: null (clearing) through the queue', async () => {
    await enqueueRating({ productId: '111', taste: 7, comment: null, categoryId: null });
    expect(peekOutbox()[0].categoryId).toBeNull();
  });

  // Each enqueue call carries the *complete* current intent (not a partial
  // patch), so the collapse-to-latest behaviour above already keeps category
  // changes correct with no extra merge logic.
  it('collapsing repeated offline edits keeps the latest category intent, not the first', async () => {
    await enqueueRating({ productId: '111', taste: 3, comment: null, categoryId: 'cat-1' });
    await enqueueRating({ productId: '111', taste: 6, comment: null, seedSlug: 'wine' });
    await enqueueRating({ productId: '111', taste: 9, comment: null, categoryId: null });

    const queue = await readOutbox();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ taste: 9, categoryId: null });
    expect(queue[0].seedSlug).toBeUndefined();
  });

  it('includes categoryId/seedSlug on the POST when flushed', async () => {
    mockPost.mockImplementation((_path: string, body: { productId: string; taste: number }) =>
      Promise.resolve(savedRating(body.productId, body.taste)),
    );
    await enqueueRating({ productId: '111', taste: 7, comment: null, seedSlug: 'wine' });

    await flushOutbox();

    expect(mockPost).toHaveBeenCalledWith('/api/ratings', {
      productId: '111',
      taste: 7,
      comment: undefined,
      categoryId: undefined,
      seedSlug: 'wine',
    });
  });

  it('keeps the original queue time when an item is replaced', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await enqueueRating({ productId: '111', taste: 3, comment: null });
    nowSpy.mockReturnValue(5_000);
    await enqueueRating({ productId: '111', taste: 8, comment: null });
    nowSpy.mockRestore();

    expect((await readOutbox())[0].queuedAt).toBe(1_000);
  });

  it('posts every due item and empties the queue on success', async () => {
    mockPost.mockImplementation((_path: string, body: { productId: string; taste: number }) =>
      Promise.resolve(savedRating(body.productId, body.taste)),
    );
    await enqueueRating({ productId: '111', taste: 7, comment: null });
    await enqueueRating({ productId: '222', taste: 4, comment: null });

    const result = await flushOutbox();

    expect(result.synced).toEqual(['111', '222']);
    expect(result.remaining).toHaveLength(0);
    expect(mockPost).toHaveBeenCalledWith('/api/ratings', {
      productId: '111',
      taste: 7,
      comment: undefined,
    });
  });

  it('writes the server’s version of a synced rating into the ratings cache', async () => {
    mockPost.mockResolvedValue(savedRating('111', 7));
    await enqueueRating({ productId: '111', taste: 7, comment: null });

    await flushOutbox();

    expect((await ratingsCache.read())?.[0]).toMatchObject({ id: 'r-111', taste: 7 });
  });

  it('keeps the item queued and backs off on a transient failure', async () => {
    mockPost.mockRejectedValue(new ApiError(503, 'Service unavailable', {}));
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await enqueueRating({ productId: '111', taste: 7, comment: null });

    const result = await flushOutbox();

    expect(result.dropped).toHaveLength(0);
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0].attempts).toBe(1);
    expect(result.remaining[0].nextAttemptAt).toBe(1_000 + BASE_BACKOFF_MS);
    (Date.now as jest.Mock).mockRestore();
  });

  it('skips an item whose back-off has not elapsed', async () => {
    mockPost.mockRejectedValue(new ApiError(500, 'boom', {}));
    await enqueueRating({ productId: '111', taste: 7, comment: null });
    await flushOutbox();
    __resetOutboxFlushForTests();
    mockPost.mockClear();

    const result = await flushOutbox();

    expect(mockPost).not.toHaveBeenCalled();
    expect(result.remaining).toHaveLength(1);
  });

  it('drops an item on a permanent 4xx and reports it', async () => {
    mockPost.mockRejectedValue(new ApiError(400, 'taste must be between 0 and 10', {}));
    await enqueueRating({ productId: '111', taste: 7, comment: null });

    const result = await flushOutbox();

    expect(result.dropped).toEqual([
      { productId: '111', message: 'taste must be between 0 and 10' },
    ]);
    expect(result.remaining).toHaveLength(0);
  });

  // Neither status says the *request* is wrong: 401 clears once the token
  // refreshes, 429 once the window rolls over. Dropping would lose a rating.
  it.each([401, 429])('retries rather than drops on %i', async (status) => {
    mockPost.mockRejectedValue(new ApiError(status, 'nope', {}));
    await enqueueRating({ productId: '111', taste: 7, comment: null });

    const result = await flushOutbox();

    expect(result.dropped).toHaveLength(0);
    expect(result.remaining).toHaveLength(1);
  });

  it('stops at the first network failure and keeps the rest of the queue intact', async () => {
    mockPost.mockRejectedValue(new NetworkError());
    await enqueueRating({ productId: '111', taste: 7, comment: null });
    await enqueueRating({ productId: '222', taste: 4, comment: null });

    const result = await flushOutbox();

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(result.synced).toHaveLength(0);
    expect(result.remaining.map((item) => item.productId)).toEqual(['111', '222']);
  });

  // TICKET-P6-007: the outbox is keyed by productId alone and knows nothing
  // about `kind` — a CUSTOM product's rating must queue and sync exactly
  // like a PACKAGED one's.
  it('queues and syncs a rating for a CUSTOM product the same as a PACKAGED one', async () => {
    mockPost.mockImplementation((_path: string, body: { productId: string; taste: number }) =>
      Promise.resolve(savedRating(body.productId, body.taste, 'CUSTOM')),
    );
    await enqueueRating({ productId: 'custom-1', taste: 9, comment: 'great cocktail' });
    expect(peekOutbox()).toMatchObject([{ productId: 'custom-1', taste: 9 }]);

    const result = await flushOutbox();

    expect(result.synced).toEqual(['custom-1']);
    expect(result.remaining).toHaveLength(0);
    expect((await ratingsCache.read())?.[0]).toMatchObject({
      id: 'r-custom-1',
      product: { id: 'custom-1', kind: 'CUSTOM' },
    });
  });

  it('survives a restart — the queue is read back from disk', async () => {
    await enqueueRating({ productId: '111', taste: 7, comment: 'kept' });
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');

    expect(await readOutbox()).toMatchObject([{ productId: '111', taste: 7, comment: 'kept' }]);
  });
});
