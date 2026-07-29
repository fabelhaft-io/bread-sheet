import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  type OutboxFailure,
  type OutboxRating,
  enqueueRating,
  flushOutbox,
  peekOutbox,
  readOutbox,
} from '@/lib/offline/outbox';

import { useSession } from './use-session';

/**
 * App-wide view of the offline rating queue (P8-004).
 *
 * Holds two things screens care about: which barcodes are still waiting to
 * reach the server (so a rating can be marked "not yet synced"), and which ones
 * the server refused outright (so the user is told rather than left believing a
 * rating landed). Flushes on mount and on every foreground — without a
 * connectivity library, "the app came back to the front" is the cheapest
 * reliable signal that a retry is worth attempting.
 */

interface OutboxContextValue {
  queued: OutboxRating[];
  failures: OutboxFailure[];
  /** Barcodes with a rating still in the queue. */
  isQueued: (barcode: string) => boolean;
  enqueue: (input: { barcode: string; taste: number; comment: string | null }) => Promise<void>;
  flush: () => Promise<void>;
  dismissFailures: () => void;
}

const OutboxContext = createContext<OutboxContextValue>({
  queued: [],
  failures: [],
  isQueued: () => false,
  enqueue: async () => {},
  flush: async () => {},
  dismissFailures: () => {},
});

export function useOutbox() {
  return useContext(OutboxContext);
}

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  const [queued, setQueued] = useState<OutboxRating[]>(() => peekOutbox());
  const [failures, setFailures] = useState<OutboxFailure[]>([]);

  const flush = useCallback(async () => {
    if (!userId) return;
    const result = await flushOutbox();
    setQueued(result.remaining);
    if (result.dropped.length) {
      setFailures((prev) => [...prev, ...result.dropped]);
    }
  }, [userId]);

  const enqueue = useCallback(
    async (input: { barcode: string; taste: number; comment: string | null }) => {
      const next = await enqueueRating(input);
      setQueued(next);
    },
    [],
  );

  const dismissFailures = useCallback(() => setFailures([]), []);

  const isQueued = useCallback(
    (barcode: string) => queued.some((item) => item.barcode === barcode),
    [queued],
  );

  // Hydrate for the signed-in user, then try to drain what is already waiting.
  // The queue lives on disk, so reading it into state is the "subscribe to an
  // external system" case rather than a derived-state mistake.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!userId) {
      setQueued([]);
      setFailures([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const stored = await readOutbox();
      if (cancelled) return;
      setQueued(stored);
      if (stored.length) await flush();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, flush]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === 'active') void flush();
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [flush]);

  return (
    <OutboxContext.Provider
      value={{ queued, failures, isQueued, enqueue, flush, dismissFailures }}
    >
      {children}
    </OutboxContext.Provider>
  );
}
