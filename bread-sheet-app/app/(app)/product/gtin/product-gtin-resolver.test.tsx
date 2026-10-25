import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import { productCache } from '@/lib/offline/caches';
import { __resetOfflineStoreForTests, setActiveCacheUser } from '@/lib/offline/store';

import ProductGtinResolverScreen from './[gtin]';

/**
 * TICKET-P6-009 — the GTIN resolver. These tests cover exactly the states
 * that moved off the product screen when it was re-keyed from `barcode` to
 * `Product.id`: invalid code (400), not-found (404), offline-with-nothing-
 * cached, and the cache-hit / network-hit paths into `/(app)/product/<id>`.
 */

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};
const mockUseLocalSearchParams = jest.fn(() => ({ gtin: '0000000000001' }));
const mockUseSession = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => mockRouter,
}));

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/features/products/api', () => ({
  lookupProductByGtin: jest.fn(),
}));

// Uses the manual mock in lib/__mocks__/api.ts, which keeps ApiError and
// NetworkError as real classes so the resolver's `instanceof` checks match
// errors constructed in these tests — and so this file never has to
// construct the real Supabase client lib/api.ts imports transitively.
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError, NetworkError } = require('@/lib/api');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const productsApi = require('@/features/products/api');
const mockLookup = productsApi.lookupProductByGtin as jest.Mock;

const PRODUCT = {
  id: 'p1',
  kind: 'PACKAGED' as const,
  name: 'Sourdough Loaf',
  brand: 'Artisan',
  image: null,
  description: null,
  status: 'VERIFIED' as const,
  packaged: {
    gtin: '0000000000001',
    genericName: null,
    energyKcal: null,
    fat: null,
    saturatedFat: null,
    carbohydrates: null,
    sugars: null,
    protein: null,
    salt: null,
    servingSize: null,
    ingredients: null,
  },
};

describe('ProductGtinResolverScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    files.clear();
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');
    mockUseLocalSearchParams.mockReturnValue({ gtin: '0000000000001' });
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
  });

  it('resolves a cached gtin without ever calling the network', async () => {
    await productCache('p1').write(PRODUCT);

    await render(<ProductGtinResolverScreen />);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/product/p1'));
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('looks up over the network, caches the result (with its gtin index), and redirects', async () => {
    mockLookup.mockResolvedValue(PRODUCT);

    await render(<ProductGtinResolverScreen />);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/product/p1'));
    expect(await productCache('p1').read()).toEqual(PRODUCT);
  });

  it('shows the invalid-code state on a 400 and pre-fills the manual sheet', async () => {
    mockUseLocalSearchParams.mockReturnValue({ gtin: '14006381333931' });
    mockLookup.mockRejectedValue(new ApiError(400, 'Invalid barcode format', {}));

    const { findByTestId, getByTestId } = await render(<ProductGtinResolverScreen />);

    await findByTestId('product-invalid-barcode');
    expect(getByTestId('manual-barcode-input').props.value).toBe('1400638133393');
  });

  it('shows the not-found state on a 404, with an "add this product" CTA for registered users', async () => {
    mockLookup.mockRejectedValue(new ApiError(404, 'Product not found', {}));

    const { findByTestId, queryByTestId } = await render(<ProductGtinResolverScreen />);

    const btn = await findByTestId('product-not-found-add');
    expect(queryByTestId('product-not-found-signup')).toBeNull();
    await fireEvent.press(btn);
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/add-product',
      params: { gtin: '0000000000001' },
    });
  });

  it('shows the signup CTA with a gtin returnTo for anonymous users on a 404', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockLookup.mockRejectedValue(new ApiError(404, 'Product not found', {}));

    const { findByTestId } = await render(<ProductGtinResolverScreen />);
    const btn = await findByTestId('product-not-found-signup');
    await fireEvent.press(btn);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(auth)/signup',
      params: { returnTo: '/product/gtin/0000000000001' },
    });
  });

  it('shows the offline state — not not-found — when nothing is cached for this gtin', async () => {
    mockLookup.mockRejectedValue(new NetworkError());

    const { findByTestId, queryByTestId } = await render(<ProductGtinResolverScreen />);

    await findByTestId('product-offline');
    expect(queryByTestId('product-not-found')).toBeNull();
  });

  it('retries the lookup from the offline state', async () => {
    mockLookup.mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce(PRODUCT);

    const { findByTestId } = await render(<ProductGtinResolverScreen />);
    await fireEvent.press(await findByTestId('product-offline-retry'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/product/p1'));
  });

  it('shows a generic error state (with retry) on a non-400/404/offline failure', async () => {
    mockLookup.mockRejectedValue(new ApiError(500, 'boom', {}));

    const { findByTestId } = await render(<ProductGtinResolverScreen />);
    await findByTestId('product-error');
  });
});
