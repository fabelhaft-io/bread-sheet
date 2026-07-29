import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { ApiError, NetworkError } from '@/lib/api';
import { productCache, ratingsCache } from '@/lib/offline/caches';
import { __resetOfflineStoreForTests, setActiveCacheUser } from '@/lib/offline/store';

import ProductScreen from './[barcode]';

/**
 * Offline behaviour of the product screen (P8-002 / P8-004).
 *
 * The distinction these tests protect: "the server said this barcode does not
 * exist" and "the request never left the device" must never render the same
 * way. Offering "Add this product" to someone standing in a supermarket with
 * no signal sends them into a submission flow that cannot succeed.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockUseSession = jest.fn();
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
const mockIsQueued = jest.fn().mockReturnValue(false);

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    useLocalSearchParams: () => ({ barcode: '0000000000001' }),
    useRouter: () => mockRouter,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run-once mock
    useFocusEffect: (cb: () => unknown) => React.useEffect(() => cb(), []),
  };
});

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/hooks/use-outbox', () => ({
  useOutbox: () => ({
    queued: [],
    failures: [],
    isQueued: (barcode: string) => mockIsQueued(barcode),
    enqueue: mockEnqueue,
    flush: jest.fn(),
    dismissFailures: jest.fn(),
  }),
}));

jest.mock('@/hooks/use-recent-products', () => {
  const value = { addRecentProduct: jest.fn(), recentProducts: [] as unknown[] };
  return { useRecentProducts: () => value };
});

jest.mock('@/features/products/api', () => ({
  getPendingEdit: jest.fn().mockResolvedValue({ edit: null }),
}));

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
const { api } = require('@/lib/api');
const mockApiGet = api.get as jest.Mock;
const mockApiPost = api.post as jest.Mock;

const PRODUCT = {
  id: 'p1',
  barcode: '0000000000001',
  name: 'Sourdough Loaf',
  brand: 'Artisan',
  image: null,
  description: null,
  status: 'VERIFIED' as const,
};

describe('ProductScreen — offline (P8-002)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsQueued.mockReturnValue(false);
    files.clear();
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
  });

  it('renders a previously viewed product from cache with an offline strip', async () => {
    await productCache(PRODUCT.barcode).write(PRODUCT);
    await ratingsCache.write([]);
    mockApiGet.mockRejectedValue(new NetworkError());

    const { findByText, findByTestId, queryByTestId } = render(<ProductScreen />);

    await findByText('Sourdough Loaf');
    await findByTestId('product-offline-indicator');
    expect(queryByTestId('product-not-found')).toBeNull();
  });

  it('shows the offline state — not "add this product" — for an uncached barcode', async () => {
    mockApiGet.mockRejectedValue(new NetworkError());

    const { findByTestId, queryByTestId } = render(<ProductScreen />);

    await findByTestId('product-offline');
    expect(queryByTestId('product-not-found')).toBeNull();
    expect(queryByTestId('product-not-found-add')).toBeNull();
  });

  it('still shows the not-found state when the server genuinely answers 404', async () => {
    mockApiGet.mockRejectedValue(new ApiError(404, 'Product not found', {}));

    const { findByTestId, queryByTestId } = render(<ProductScreen />);

    await findByTestId('product-not-found');
    expect(queryByTestId('product-offline')).toBeNull();
  });

  it('pre-fills the rating from the cached ratings list with no network at all', async () => {
    await productCache(PRODUCT.barcode).write(PRODUCT);
    await ratingsCache.write([
      {
        id: 'r1',
        score: 9,
        taste: 9,
        comment: 'Great crust',
        createdAt: '2026-07-01T00:00:00.000Z',
        product: { id: 'p1', barcode: PRODUCT.barcode, name: PRODUCT.name, brand: null, image: null },
      },
    ]);
    mockApiGet.mockRejectedValue(new NetworkError());

    const { findByText } = render(<ProductScreen />);

    await findByText('Update Rating');
    await findByText('9.0');
    expect(mockApiGet).not.toHaveBeenCalledWith(expect.stringContaining('/api/users/me/ratings'));
  });
});

describe('ProductScreen — offline rating submission (P8-004)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockIsQueued.mockReturnValue(false);
    files.clear();
    __resetOfflineStoreForTests();
    setActiveCacheUser('u1');
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    mockApiGet.mockResolvedValue(PRODUCT);
    await ratingsCache.write([]);
  });

  it('queues the rating and confirms success rather than showing an error', async () => {
    mockApiPost.mockRejectedValue(new NetworkError());

    const { findByText, findByTestId, getByText } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    fireEvent.press(getByText('Submit Rating'));

    await findByTestId('rating-queued-offline');
    expect(mockEnqueue).toHaveBeenCalledWith({
      barcode: PRODUCT.barcode,
      taste: 5,
      comment: null,
    });
  });

  it('writes the queued rating into the cache so the Home tab shows it immediately', async () => {
    mockApiPost.mockRejectedValue(new NetworkError());

    const { findByText, findByTestId, getByText } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    fireEvent.press(getByText('Submit Rating'));
    await findByTestId('rating-queued-offline');

    expect(await ratingsCache.read()).toMatchObject([
      { taste: 5, product: { barcode: PRODUCT.barcode } },
    ]);
  });

  it('does not queue anything when the server accepts the rating', async () => {
    mockApiPost.mockResolvedValue({
      id: 'r1',
      score: 5,
      taste: 5,
      comment: null,
      createdAt: '2026-07-29T00:00:00.000Z',
      product: { id: 'p1', barcode: PRODUCT.barcode, name: PRODUCT.name, brand: null, image: null },
    });

    const { findByText, getByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    fireEvent.press(getByText('Submit Rating'));

    await findByText(/Rating Submitted!/i);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(queryByTestId('rating-queued-offline')).toBeNull();
  });

  it('reports a server rejection as an error instead of queueing it', async () => {
    mockApiPost.mockRejectedValue(new ApiError(400, 'taste must be between 0 and 10', {}));

    const { findByText, getByText } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    fireEvent.press(getByText('Submit Rating'));

    await findByText(/taste must be between 0 and 10/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('marks the product as awaiting sync while its rating sits in the queue', async () => {
    mockIsQueued.mockReturnValue(true);

    const { findByTestId } = render(<ProductScreen />);

    await findByTestId('product-pending-sync');
  });
});
