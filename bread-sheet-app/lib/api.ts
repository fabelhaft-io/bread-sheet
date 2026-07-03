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

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...(options.headers as Record<string, string>),
    },
  });

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

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
