import { File } from 'expo-file-system';

import { uploadProductImage } from './api';
import { ApiError } from '@/lib/api';

// lib/api (imported transitively) pulls in the supabase client at module load.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest
        .fn()
        .mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

describe('uploadProductImage', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = 'http://test.local';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('returns the image key and front-of-pack suggestions on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        imageKey: 'processed/uuid.jpg',
        name: 'Oat Drink',
        brand: 'Alpro',
        genericName: 'Oat drink',
      }),
    }) as unknown as typeof fetch;

    const result = await uploadProductImage('file:///tmp/p.jpg', 'product', 'Bearer tok');

    expect(result).toEqual({
      imageKey: 'processed/uuid.jpg',
      name: 'Oat Drink',
      brand: 'Alpro',
      genericName: 'Oat drink',
    });
  });

  it('defaults missing suggestion fields to null', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ imageKey: 'processed/uuid.jpg' }),
    }) as unknown as typeof fetch;

    const result = await uploadProductImage('file:///tmp/p.jpg', 'product', 'Bearer tok');

    expect(result).toEqual({
      imageKey: 'processed/uuid.jpg',
      name: null,
      brand: null,
      genericName: null,
    });
  });

  it('throws an ApiError carrying the rejection reason on a 422', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: 'image_rejected', reason: 'This is not a food product.' }),
    }) as unknown as typeof fetch;

    await expect(
      uploadProductImage('file:///tmp/p.jpg', 'product', 'Bearer tok'),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      message: 'This is not a food product.',
    });
  });

  it('wraps non-2xx responses without a reason in an ApiError', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const err = await uploadProductImage('file:///tmp/p.jpg', 'product', null).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });

  // Regression: SDK 54+ swapped the global fetch for the WinterCG implementation,
  // which rejects the legacy React Native `{ uri, name, type }` FormData part with
  // "Unsupported FormDataPart implementation". The image must be appended as an
  // expo-file-system `File` (which implements `Blob`), not the plain URI object.
  it('appends the image as an expo-file-system File, not a {uri} object', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ imageKey: 'processed/uuid.jpg' }),
    }) as unknown as typeof fetch;

    await uploadProductImage('file:///tmp/p.jpg', 'product', 'Bearer tok');

    // A real File instance (implements Blob) — not the legacy plain
    // `{ uri, name, type }` object that WinterCG fetch rejects.
    const imageCall = appendSpy.mock.calls.find(([field]) => field === 'image');
    expect(imageCall).toBeDefined();
    expect(imageCall![1]).toBeInstanceOf(File);
    expect(imageCall![1].constructor).not.toBe(Object);

    appendSpy.mockRestore();
  });
});
