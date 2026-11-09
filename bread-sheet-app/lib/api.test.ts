import { ApiError, NetworkError, api } from './api';

jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

const originalFetch = global.fetch;

describe('api', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns the parsed JSON body on a 2xx response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '1', name: 'Bread' }),
    });
    const product = await api.get<{ id: string; name: string }>('/api/products/123');
    expect(product).toEqual({ id: '1', name: 'Bread' });
  });

  it('throws ApiError carrying the HTTP status on a non-2xx response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ message: 'Product not found' }),
    });

    expect.assertions(4);
    try {
      await api.get('/api/products/000');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.message).toBe('Product not found');
      expect(apiErr.body).toEqual({ message: 'Product not found' });
    }
  });

  // P8-002: `fetch` rejects with a bare TypeError when the request never left
  // the device. Screens must be able to tell that apart from an HTTP error —
  // otherwise an offline user gets "Product not found — add it?".
  it('throws NetworkError, not ApiError, when the request never reaches the server', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Network request failed'));

    expect.assertions(3);
    try {
      await api.get('/api/products/123');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ApiError);
      expect((err as NetworkError).cause).toBeInstanceOf(TypeError);
    }
  });

  // TICKET-P6-003: `DELETE /api/users/me/categories/:id` is the first
  // endpoint to answer `204 No Content` — calling `.json()` on an empty
  // body throws, which would turn a successful delete into a thrown error.
  it('resolves to undefined on a 204, never calling .json()', async () => {
    const json = jest.fn().mockRejectedValue(new Error('Unexpected end of JSON input'));
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 204, json });

    const result = await api.delete('/api/users/me/categories/c1');

    expect(result).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the body is not JSON', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('invalid json')),
    });

    try {
      await api.get('/api/products/000');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.message).toBe('Request failed with status 500');
    }
  });

  it('does not send X-Edge-Bypass when EXPO_PUBLIC_EDGE_BYPASS_SECRET is unset', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    await api.get('/api/products/123');

    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('X-Edge-Bypass');
  });

  it('sends X-Edge-Bypass with the configured secret when set (CI only — never the release build)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    process.env.EXPO_PUBLIC_EDGE_BYPASS_SECRET = 'ci-secret';
    jest.resetModules();
    const { api: apiWithBypass } = require('./api') as typeof import('./api');
    delete process.env.EXPO_PUBLIC_EDGE_BYPASS_SECRET;

    await apiWithBypass.get('/api/products/123');

    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers['X-Edge-Bypass']).toBe('ci-secret');
  });

  // TICKET-P6-008: `api.get` passes a caller's `AbortSignal` straight to
  // `fetch`, so a debounced search can cancel a superseded request.
  it('passes a `signal` option through to `fetch`', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    const controller = new AbortController();

    await api.get('/api/products/search?q=cola', { signal: controller.signal });

    const fetchOptions = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(fetchOptions.signal).toBe(controller.signal);
  });

  // An aborted request is deliberate cancellation, not a connectivity
  // failure — wrapping it as NetworkError would make `formatApiError` render
  // "you're offline" for a request nobody wanted answered anymore.
  it('rethrows an AbortError as-is, not as NetworkError', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    (global.fetch as jest.Mock).mockRejectedValue(abortError);

    expect.assertions(3);
    try {
      await api.get('/api/products/search?q=cola');
    } catch (err) {
      expect(err).toBe(abortError);
      expect(err).not.toBeInstanceOf(NetworkError);
      expect((err as Error).name).toBe('AbortError');
    }
  });
});
