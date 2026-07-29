/**
 * Manual mock for `@/lib/api`, picked up by a bare `jest.mock('@/lib/api')`.
 *
 * Two reasons every screen test wants this:
 *   - the real module constructs the Supabase client at import time, which
 *     needs env vars that tests don't set;
 *   - `ApiError` and `NetworkError` must stay real classes, because screens and
 *     `formatApiError` branch on `instanceof` to decide between "not found",
 *     "you're offline" and generic failure copy.
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

export class NetworkError extends Error {
  readonly cause: unknown;

  constructor(message = 'Could not reach the server.', cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export const api = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
};
