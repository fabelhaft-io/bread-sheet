import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  readAsStringAsync,
  readDirectoryAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

/**
 * Typed, versioned, user-namespaced JSON store on disk (P8-002).
 *
 * Layout: `<documentDirectory>offline/v<VERSION>/<userId>/<name>.json`
 *
 * Three properties matter here:
 *
 *  - **Namespacing is not optional.** The anonymous → registered upgrade and
 *    account switching must never let one user's cached ratings or votes show
 *    up in another user's view, so every document lives under the Supabase user
 *    id that produced it.
 *  - **A schema mismatch wipes, it never migrates.** These are caches; the
 *    server is the source of truth, so re-fetching is always cheaper and safer
 *    than writing migration code for throwaway data.
 *  - **Failures are non-fatal.** A cache that cannot be read or written must
 *    degrade to "no cache", never to a broken screen.
 *
 * The substrate is `expo-file-system` rather than SQLite — following the
 * precedent P5-001 set (no extra native module, jest-expo keeps passing) and
 * because the data is small (~200 products, one rating per product). When the
 * document directory is unavailable (web, tests) we fall back to AsyncStorage,
 * which is backed by `localStorage` on web.
 */

/** Bump to invalidate every cached document on the next launch. */
export const CACHE_SCHEMA_VERSION = 1;

const ROOT_DIR_NAME = 'offline';
const VERSION_DIR_NAME = `v${CACHE_SCHEMA_VERSION}`;

interface Envelope<T> {
  /** Schema version the document was written under. */
  v: number;
  /** Epoch millis of the write, for staleness display. */
  updatedAt: number;
  data: T;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let activeUserId: string | null = null;

/**
 * Synchronous mirror of what is on disk, keyed `${userId}:${name}`. This is what
 * lets a screen paint from cache in its *first* frame rather than after a disk
 * round trip — the difference between "snappy" and "a flash of empty state".
 */
const memory = new Map<string, unknown>();

/** Serialises writes per document so two rapid updates cannot interleave. */
const writeChains = new Map<string, Promise<unknown>>();

/** Runs once per process: drops directories left behind by older schemas. */
let pruneOldVersions: Promise<void> | null = null;

// ─── Paths ────────────────────────────────────────────────────────────────────

function rootUri(): string | null {
  if (!documentDirectory) return null;
  return `${documentDirectory}${ROOT_DIR_NAME}/`;
}

function versionUri(): string | null {
  const root = rootUri();
  return root ? `${root}${VERSION_DIR_NAME}/` : null;
}

function userDirUri(userId: string): string | null {
  const version = versionUri();
  return version ? `${version}${encodeURIComponent(userId)}/` : null;
}

function documentUri(userId: string, name: string): string | null {
  const dir = userDirUri(userId);
  return dir ? `${dir}${name}.json` : null;
}

function memoryKey(userId: string, name: string): string {
  return `${userId}:${name}`;
}

function fallbackKey(userId: string, name: string): string {
  return `${ROOT_DIR_NAME}/${VERSION_DIR_NAME}/${userId}/${name}`;
}

// ─── Active user ──────────────────────────────────────────────────────────────

/**
 * Point the store at a user. Called from `SessionProvider` whenever the session
 * changes; passing `null` (signed out) makes every read return `null` and every
 * write a no-op, so a signed-out app can never read a signed-in user's cache.
 */
export function setActiveCacheUser(userId: string | null): void {
  if (userId === activeUserId) return;
  activeUserId = userId;
  // Memory keys are user-scoped so stale entries could not leak anyway, but
  // there is no reason to keep the previous user's payloads resident.
  memory.clear();
  writeChains.clear();
}

export function getActiveCacheUser(): string | null {
  return activeUserId;
}

// ─── Version pruning ──────────────────────────────────────────────────────────

async function prune(): Promise<void> {
  const root = rootUri();
  if (!root) return;
  try {
    const info = await getInfoAsync(root);
    if (!info.exists) return;
    const entries = await readDirectoryAsync(root);
    await Promise.all(
      entries
        .filter((entry) => entry !== VERSION_DIR_NAME)
        .map((entry) => deleteAsync(`${root}${entry}`, { idempotent: true }).catch(() => {})),
    );
  } catch {
    // Best effort — a stale directory costs disk space, not correctness.
  }
}

function ensurePruned(): Promise<void> {
  pruneOldVersions ??= prune();
  return pruneOldVersions;
}

// ─── Read / write ─────────────────────────────────────────────────────────────

/**
 * Synchronous cache probe. Returns a value only if this process has already
 * read or written it; use it to seed initial render state, then follow up with
 * {@link readCache} for the cold case.
 */
export function peekCache<T>(name: string): T | null {
  if (!activeUserId) return null;
  const hit = memory.get(memoryKey(activeUserId, name));
  return hit === undefined ? null : (hit as T);
}

/** Read a document from disk. Returns `null` when absent, unreadable, or stale. */
export async function readCache<T>(name: string): Promise<T | null> {
  const userId = activeUserId;
  if (!userId) return null;

  const cached = peekCache<T>(name);
  if (cached !== null) return cached;

  await ensurePruned();

  const raw = await readRaw(userId, name);
  if (raw === null) return null;

  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(raw) as Envelope<T>;
  } catch {
    await removeCache(name);
    return null;
  }

  if (!envelope || envelope.v !== CACHE_SCHEMA_VERSION) {
    // Wipe rather than migrate — see the module comment.
    await removeCache(name);
    return null;
  }

  memory.set(memoryKey(userId, name), envelope.data);
  return envelope.data;
}

async function readRaw(userId: string, name: string): Promise<string | null> {
  const uri = documentUri(userId, name);
  if (!uri) {
    try {
      return await AsyncStorage.getItem(fallbackKey(userId, name));
    } catch {
      return null;
    }
  }
  try {
    const info = await getInfoAsync(uri);
    if (!info.exists) return null;
    return await readAsStringAsync(uri);
  } catch {
    return null;
  }
}

/** Write a document, updating the synchronous mirror immediately. */
export function writeCache<T>(name: string, data: T): Promise<void> {
  const userId = activeUserId;
  if (!userId) return Promise.resolve();

  memory.set(memoryKey(userId, name), data);

  const key = memoryKey(userId, name);
  const envelope: Envelope<T> = { v: CACHE_SCHEMA_VERSION, updatedAt: Date.now(), data };
  const serialised = JSON.stringify(envelope);

  const next = (writeChains.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeRaw(userId, name, serialised));
  writeChains.set(key, next);
  return next;
}

async function writeRaw(userId: string, name: string, contents: string): Promise<void> {
  const uri = documentUri(userId, name);
  if (!uri) {
    try {
      await AsyncStorage.setItem(fallbackKey(userId, name), contents);
    } catch {
      // Memory mirror still serves this session.
    }
    return;
  }
  try {
    const dir = userDirUri(userId)!;
    await makeDirectoryAsync(dir, { intermediates: true });
    await writeAsStringAsync(uri, contents);
  } catch {
    // Disk errors are non-fatal: the memory mirror keeps this session snappy.
  }
}

/** Delete a single document for the active user. */
export async function removeCache(name: string): Promise<void> {
  const userId = activeUserId;
  if (!userId) return;
  memory.delete(memoryKey(userId, name));
  const uri = documentUri(userId, name);
  if (!uri) {
    await AsyncStorage.removeItem(fallbackKey(userId, name)).catch(() => {});
    return;
  }
  await deleteAsync(uri, { idempotent: true }).catch(() => {});
}

/**
 * Drop every cached document for every user. Called on sign-out so the next
 * account — including the next anonymous session — starts from a clean slate.
 */
export async function clearAllCaches(): Promise<void> {
  memory.clear();
  writeChains.clear();
  const root = rootUri();
  if (!root) {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const ours = keys.filter((key) => key.startsWith(`${ROOT_DIR_NAME}/`));
      if (ours.length) await AsyncStorage.multiRemove(ours);
    } catch {
      // Nothing else to try.
    }
    return;
  }
  await deleteAsync(root, { idempotent: true }).catch(() => {});
}

/** Reset all module state. Intended for tests only. */
export function __resetOfflineStoreForTests(): void {
  activeUserId = null;
  memory.clear();
  writeChains.clear();
  pruneOldVersions = null;
}
