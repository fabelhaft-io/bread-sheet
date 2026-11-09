import { supabase } from './supabase';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL;

/**
 * Thrown by the `api.*` helpers when a request returns a non-2xx status.
 * Screens can branch on `.status` to render state-specific UI (e.g. 404 →
 * "Product not found") rather than matching on the message string.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown when the request never reached the server — no connectivity, DNS
 * failure, timeout. `fetch` signals this with a bare `TypeError`, which is
 * indistinguishable from a programming mistake and, more importantly, was
 * indistinguishable from an HTTP error at the call site. Screens must be able
 * to tell "you are offline" apart from "the server said no": rendering
 * "Product not found — add it?" to someone who merely has no signal is the
 * failure mode this type exists to prevent (P8-002).
 */
export class NetworkError extends Error {
  /** The original `fetch` rejection, kept for logging. */
  readonly cause: unknown;

  constructor(message = 'Could not reach the server.', cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

// Set only in the Maestro CI workflow's env (test-native-e2e.yml)
// — never in the release APK build (build-apk.yml doesn't set it) —
// Matched against the WAF's "edge-bypass" rule (terraform/dev-geo-restriction.tf)
const EDGE_BYPASS_SECRET = process.env.EXPO_PUBLIC_EDGE_BYPASS_SECRET;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = await authHeaders();

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(EDGE_BYPASS_SECRET ? { 'X-Edge-Bypass': EDGE_BYPASS_SECRET } : {}),
        ...(options.headers as Record<string, string>),
      },
    });
  } catch (err) {
    // A caller-initiated `AbortController.abort()` (TICKET-P6-008's debounced
    // search cancels a superseded request on the next keystroke) is not a
    // connectivity failure — it's deliberate, and the caller already knows it
    // asked for it. Wrapping it as NetworkError would make `formatApiError`
    // render "you're offline" for a request nobody wanted answered anymore.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new NetworkError(undefined, err);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // The backend uses two shapes for error bodies:
    //   - `{ message: string }` from the global errorHandler
    //   - `{ error: string }` from middlewares (auth, rate-limit)
    // Either one is treated as the server-side message; if neither is present
    // we fall back to a status-derived label.
    const fromBody =
      body && typeof body === 'object'
        ? (typeof (body as { message?: unknown }).message === 'string'
            ? (body as { message: string }).message
            : typeof (body as { error?: unknown }).error === 'string'
              ? (body as { error: string }).error
              : null)
        : null;
    const message = fromBody ?? `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message, body);
  }

  // A `204 No Content` (TICKET-P6-003's `DELETE /api/users/me/categories/:id`
  // is the first endpoint to use one) has no body at all — `res.json()` on
  // an empty string throws, which would turn a successful delete into a
  // thrown error at every call site. No other 2xx response in this API is
  // ever empty, so this is the one exception worth special-casing here
  // rather than in each caller.
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

/** Options a caller may pass through to `fetch` on a `GET`. Currently just `signal`
 * (TICKET-P6-008 — cancelling a superseded debounced search request). */
export interface GetOptions {
  signal?: AbortSignal;
}

export const api = {
  get: <T>(path: string, options?: GetOptions) => request<T>(path, options),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
