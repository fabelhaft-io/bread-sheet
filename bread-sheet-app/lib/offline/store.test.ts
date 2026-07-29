import { readDirectoryAsync, writeAsStringAsync } from 'expo-file-system/legacy';

import {
  CACHE_SCHEMA_VERSION,
  __resetOfflineStoreForTests,
  clearAllCaches,
  peekCache,
  readCache,
  removeCache,
  setActiveCacheUser,
  writeCache,
} from './store';

/**
 * In-memory stand-in for the document directory. Modelling real read/write
 * behaviour (rather than asserting on call arguments) is what lets these tests
 * make claims about namespacing and schema wipes.
 */
jest.mock('expo-file-system/legacy', () => {
  const files = new Map<string, string>();
  return {
    __files: files,
    documentDirectory: 'file:///documents/',
    getInfoAsync: jest.fn(async (uri: string) => ({
      exists: files.has(uri) || [...files.keys()].some((key) => key.startsWith(uri)),
    })),
    readAsStringAsync: jest.fn(async (uri: string) => {
      const value = files.get(uri);
      if (value === undefined) throw new Error(`ENOENT: ${uri}`);
      return value;
    }),
    writeAsStringAsync: jest.fn(async (uri: string, contents: string) => {
      files.set(uri, contents);
    }),
    deleteAsync: jest.fn(async (uri: string) => {
      for (const key of [...files.keys()]) {
        if (key === uri || key.startsWith(uri)) files.delete(key);
      }
    }),
    makeDirectoryAsync: jest.fn(async () => {}),
    readDirectoryAsync: jest.fn(async (uri: string) => {
      const entries = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(uri)) entries.add(key.slice(uri.length).split('/')[0]);
      }
      return [...entries];
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const files = (require('expo-file-system/legacy') as { __files: Map<string, string> }).__files;

const uriFor = (userId: string, name: string, version = CACHE_SCHEMA_VERSION) =>
  `file:///documents/offline/v${version}/${userId}/${name}.json`;

describe('offline store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    files.clear();
    __resetOfflineStoreForTests();
  });

  it('round-trips a document for the active user', async () => {
    setActiveCacheUser('u1');
    await writeCache('ratings', [{ id: 'r1' }]);
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');

    expect(await readCache('ratings')).toEqual([{ id: 'r1' }]);
  });

  it('namespaces documents per user id so one account never sees another’s', async () => {
    setActiveCacheUser('u1');
    await writeCache('ratings', ['first user']);

    setActiveCacheUser('u2');
    expect(peekCache('ratings')).toBeNull();
    expect(await readCache('ratings')).toBeNull();

    await writeCache('ratings', ['second user']);
    setActiveCacheUser('u1');
    expect(await readCache('ratings')).toEqual(['first user']);
  });

  it('exposes a written value synchronously via peek, for first-frame paints', async () => {
    setActiveCacheUser('u1');
    expect(peekCache('recents')).toBeNull();
    await writeCache('recents', ['a']);
    expect(peekCache('recents')).toEqual(['a']);
  });

  it('warms peek after a disk read', async () => {
    setActiveCacheUser('u1');
    await writeCache('recents', ['a']);
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');

    expect(peekCache('recents')).toBeNull();
    await readCache('recents');
    expect(peekCache('recents')).toEqual(['a']);
  });

  it('wipes rather than migrates a document written under an older schema', async () => {
    await writeAsStringAsync(
      uriFor('u1', 'ratings'),
      JSON.stringify({ v: CACHE_SCHEMA_VERSION - 1, updatedAt: 0, data: ['stale'] }),
    );
    setActiveCacheUser('u1');

    expect(await readCache('ratings')).toBeNull();
    expect(files.has(uriFor('u1', 'ratings'))).toBe(false);
  });

  it('discards a document that is not valid JSON', async () => {
    await writeAsStringAsync(uriFor('u1', 'ratings'), '{not json');
    setActiveCacheUser('u1');

    expect(await readCache('ratings')).toBeNull();
  });

  it('deletes directories left behind by a previous schema version', async () => {
    await writeAsStringAsync(uriFor('u1', 'ratings', CACHE_SCHEMA_VERSION - 1), '{}');
    setActiveCacheUser('u1');

    await readCache('ratings');

    expect(readDirectoryAsync).toHaveBeenCalled();
    expect(files.has(uriFor('u1', 'ratings', CACHE_SCHEMA_VERSION - 1))).toBe(false);
  });

  it('reads null and swallows writes when no user is active', async () => {
    setActiveCacheUser(null);
    await writeCache('ratings', ['ignored']);

    expect(peekCache('ratings')).toBeNull();
    expect(await readCache('ratings')).toBeNull();
    expect(files.size).toBe(0);
  });

  it('removes a single document', async () => {
    setActiveCacheUser('u1');
    await writeCache('ratings', ['a']);
    await removeCache('ratings');

    expect(peekCache('ratings')).toBeNull();
    expect(await readCache('ratings')).toBeNull();
  });

  it('clears every user’s caches on sign-out', async () => {
    setActiveCacheUser('u1');
    await writeCache('ratings', ['a']);
    setActiveCacheUser('u2');
    await writeCache('ratings', ['b']);

    await clearAllCaches();

    expect(files.size).toBe(0);
    expect(await readCache('ratings')).toBeNull();
    setActiveCacheUser('u1');
    expect(await readCache('ratings')).toBeNull();
  });
});
