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
});
