import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

import ProductScreen from './[barcode]';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mocks that live inside factory closures need to be declared BEFORE the
// factory captures them. Jest allows `mock`-prefixed variables to be referenced
// from factories, but we still have to ensure the factory's callback uses a
// live reference — that's why these are functions that hand back jest.fn()s
// on first access. The individual jest.fn() instances are memoised module-wide
// so assertions can reach them after the component has called them.

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};
const mockUseLocalSearchParams = jest.fn(() => ({ barcode: '0000000000001' }));
const mockUseSession = jest.fn();

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    useLocalSearchParams: () => mockUseLocalSearchParams(),
    useRouter: () => mockRouter,
    // Simulate focusing on mount (no re-focus in unit tests)
    useFocusEffect: (cb: () => unknown) => React.useEffect(cb, []),
  };
});

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

// IMPORTANT: the returned object must be stable across renders — if
// `addRecentProduct` is a new reference on every call, the useEffect
// inside ProductScreen re-runs on every render, which triggers repeated
// state updates (setNotFound(false)) that clobber the not-found state we
// are trying to assert. Memoise both the function and the wrapping object
// inside the factory closure.
jest.mock('@/hooks/use-recent-products', () => {
  const addRecentProduct = jest.fn();
  const value = { addRecentProduct, recentProducts: [] as unknown[] };
  return { useRecentProducts: () => value };
});

// Preserve ApiError as a real class so `instanceof` checks in the component
// match errors constructed in the tests.
jest.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    api: {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError, api } = require('@/lib/api') as typeof import('@/lib/api');
const mockApiGet = api.get as jest.Mock;
const mockApiPost = api.post as jest.Mock;

/**
 * The product screen now issues two parallel GETs on load:
 *  - GET /api/products/:barcode
 *  - GET /api/ratings/me/:barcode (registered users only)
 *
 * Tests that don't care about the existing-rating path can call this to
 * stub the product response and have the /me/:barcode call resolve to a
 * 404 (= "no rating yet").
 */
function mockProductAndNoExistingRating(product: unknown) {
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/ratings/me/')) {
      return Promise.reject(new ApiError(404, 'No rating yet', {}));
    }
    return Promise.resolve(product);
  });
}

describe('ProductScreen — product-not-found state', () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
    mockRouter.replace.mockClear();
    mockRouter.back.mockClear();
    mockApiGet.mockReset();
    mockUseSession.mockReset();
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
  });

  it('renders the not-found screen on a 404 response', async () => {
    mockApiGet.mockRejectedValue(new ApiError(404, 'Product not found', {}));
    const { findByTestId, getByText } = render(<ProductScreen />);
    await findByTestId('product-not-found');
    expect(getByText(/isn't in the database yet/i)).toBeTruthy();
  });

  it('shows the "Add this product" CTA for registered users and navigates with the barcode', async () => {
    mockApiGet.mockRejectedValue(new ApiError(404, 'Product not found', {}));
    const { findByTestId, queryByTestId } = render(<ProductScreen />);
    const btn = await findByTestId('product-not-found-add');
    expect(queryByTestId('product-not-found-signup')).toBeNull();
    fireEvent.press(btn);
    // replace (not push) so the "not-found" screen is removed from the stack —
    // prevents the user landing back on it after adding the product and rating it.
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/add-product',
      params: { barcode: '0000000000001' },
    });
  });

  it('shows the Sign up CTA for anonymous users and deep-links to signup with returnTo', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockApiGet.mockRejectedValue(new ApiError(404, 'Product not found', {}));
    const { findByTestId, queryByTestId } = render(<ProductScreen />);
    const btn = await findByTestId('product-not-found-signup');
    expect(queryByTestId('product-not-found-add')).toBeNull();
    fireEvent.press(btn);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(auth)/signup',
      params: { returnTo: '/product/0000000000001' },
    });
  });

  it('shows a friendly generic message (not the raw server error, not the not-found UI) on non-404 failures', async () => {
    // Server returns a verbose internal message — the screen must replace it
    // with safe, user-facing copy so we never expose internals on iOS.
    mockApiGet.mockRejectedValue(
      new ApiError(500, 'PrismaClientKnownRequestError: FK constraint Rating_userId_fkey', {}),
    );
    const { findByText, queryByText, queryByTestId } = render(<ProductScreen />);
    await findByText(/Could not load this product/i);
    expect(queryByText(/Prisma|FK constraint|userId/i)).toBeNull();
    expect(queryByTestId('product-not-found')).toBeNull();
  });

  it('renders the product normally on a 2xx response — no regression for known products', async () => {
    mockProductAndNoExistingRating({
      id: 'p1',
      barcode: '0000000000001',
      name: 'Sourdough Loaf',
      brand: 'Artisan',
      image: null,
      description: null,
    });
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    await waitFor(() => expect(queryByTestId('product-not-found')).toBeNull());
  });
});

describe('ProductScreen — reviewer banner (P5-002)', () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
    mockApiGet.mockReset();
  });

  it('shows the "Needs review" banner for a registered non-submitter on a PENDING_REVIEW product', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'reviewer', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    mockProductAndNoExistingRating({
      id: 'p1',
      barcode: '0000000000001',
      name: 'Mystery bread',
      brand: 'Artisan',
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'someone-else',
    });
    const { findByTestId } = render(<ProductScreen />);
    const banner = await findByTestId('review-product-banner');
    fireEvent.press(banner);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(app)/review-product/[barcode]',
      params: { barcode: '0000000000001' },
    });
  });

  it('hides the banner for the submitter of the product', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'submitter', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    mockProductAndNoExistingRating({
      id: 'p1',
      barcode: '0000000000001',
      name: 'My bread',
      brand: null,
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'submitter',
    });
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('My bread');
    expect(queryByTestId('review-product-banner')).toBeNull();
  });

  it('hides the banner for anonymous users', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockProductAndNoExistingRating({
      id: 'p1',
      barcode: '0000000000001',
      name: 'Mystery bread',
      brand: null,
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'someone-else',
    });
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Mystery bread');
    expect(queryByTestId('review-product-banner')).toBeNull();
  });

  it('hides the banner for a VERIFIED product (no unverified flag)', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'reviewer', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    mockProductAndNoExistingRating({
      id: 'p1',
      barcode: '0000000000001',
      name: 'Sourdough',
      brand: 'Artisan',
      image: null,
      description: null,
    });
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Sourdough');
    expect(queryByTestId('review-product-banner')).toBeNull();
  });
});

describe('ProductScreen — rating submission errors', () => {
  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiPost.mockReset();
    mockUseSession.mockReset();
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockProductAndNoExistingRating({
      id: 'p1',
      barcode: '0000000000001',
      name: 'Sourdough Loaf',
      brand: 'Artisan',
      image: null,
      description: null,
    });
  });

  it('shows the friendly "Could not submit your rating" copy on a 500 — never the raw Prisma message', async () => {
    mockApiPost.mockRejectedValue(
      new ApiError(
        500,
        'PrismaClientKnownRequestError: Foreign key constraint failed on the field: `Rating_userId_fkey`',
        {},
      ),
    );
    const { findByText, queryByText, getByText } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    fireEvent.press(getByText('Submit Rating'));
    await findByText(/Could not submit your rating/i);
    expect(queryByText(/Prisma|Rating_userId_fkey|Foreign key/i)).toBeNull();
  });

  it('forwards the validator copy on a 400 (server-controlled message is safe to show)', async () => {
    mockApiPost.mockRejectedValue(
      new ApiError(400, 'taste must be between 0 and 10 in 0.5 increments', {}),
    );
    const { findByText, getByText } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    fireEvent.press(getByText('Submit Rating'));
    await findByText(/taste must be between/i);
  });
});

describe('ProductScreen — existing rating pre-fill', () => {
  const PRODUCT = {
    id: 'p1',
    barcode: '0000000000001',
    name: 'Sourdough Loaf',
    brand: 'Artisan',
    image: null,
    description: null,
  };

  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiPost.mockReset();
    mockUseSession.mockReset();
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
  });

  it('pre-populates the slider and comment from the user’s existing rating and shows "Update Rating"', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/ratings/me/')) {
        return Promise.resolve({ id: 'r1', taste: 8, comment: 'Solid loaf' });
      }
      return Promise.resolve(PRODUCT);
    });

    const { findByText, queryByText } = render(<ProductScreen />);

    await findByText('Sourdough Loaf');
    // Submit-button copy reflects the update intent
    await findByText('Update Rating');
    expect(queryByText('Submit Rating')).toBeNull();
    // Slider badge shows the pre-filled score (one decimal place for whole numbers)
    await findByText('8.0');
  });

  it('shows the "Submit Rating" button when the user has no existing rating', async () => {
    mockProductAndNoExistingRating(PRODUCT);
    const { findByText, queryByText } = render(<ProductScreen />);
    await findByText('Submit Rating');
    expect(queryByText('Update Rating')).toBeNull();
  });

  it('shows "Rating Updated!" on the success screen after re-rating', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/ratings/me/')) {
        return Promise.resolve({ id: 'r1', taste: 6, comment: null });
      }
      return Promise.resolve(PRODUCT);
    });
    mockApiPost.mockResolvedValue({ id: 'r1', taste: 6 });

    const { findByText, getByText } = render(<ProductScreen />);
    await findByText('Update Rating');
    fireEvent.press(getByText('Update Rating'));
    await findByText(/Rating Updated!/i);
  });

  it('skips the /me/:barcode lookup for anonymous users', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/ratings/me/')) {
        // If this ever fires for an anonymous user, the test must fail —
        // we don't want to spam the backend with auth'd lookups for guests.
        throw new Error('Anonymous users must not call /api/ratings/me/:barcode');
      }
      return Promise.resolve(PRODUCT);
    });
    const { findByText } = render(<ProductScreen />);
    await findByText('Submit Rating');
    // Asserting the /me call did NOT happen
    const meCalls = mockApiGet.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].startsWith('/api/ratings/me/'),
    );
    expect(meCalls).toHaveLength(0);
  });
});
