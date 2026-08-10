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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run-once mock, deps intentionally empty
    useFocusEffect: (cb: () => unknown) => React.useEffect(() => cb(), []),
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

// Uses the manual mock in lib/__mocks__/api.ts, which keeps ApiError and
// NetworkError as real classes so the component's `instanceof` checks match
// errors constructed in the tests.
jest.mock('@/lib/api');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError, api } = require('@/lib/api') as typeof import('@/lib/api');
const mockApiGet = api.get as jest.Mock;
const mockApiPost = api.post as jest.Mock;

/**
 * Since P8-002 the screen loads:
 *  - GET /api/products/:barcode
 *  - GET /api/users/me/ratings — only when this device has no cached copy of
 *    the list; "my rating" is then read out of it by barcode. The per-product
 *    `GET /api/ratings/me/:barcode` round trip is gone.
 *
 * Tests that don't care about the existing-rating path use this to stub the
 * product and return an empty rating history.
 */
function mockProductAndNoExistingRating(product: unknown) {
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/users/me/ratings')) return Promise.resolve([]);
    return Promise.resolve(product);
  });
}

/** Build one `/api/users/me/ratings` entry for the given product. */
function ratingEntry(product: { id: string; barcode: string; name: string; brand: string | null },
  taste: number, comment: string | null) {
  return {
    id: 'r1',
    score: taste,
    taste,
    comment,
    createdAt: new Date().toISOString(),
    product: { ...product, image: null },
  };
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

  // One test in this block routes an invalid code; every other test (here and
  // in the blocks below) assumes the default barcode.
  afterEach(() => {
    mockUseLocalSearchParams.mockReturnValue({ barcode: '0000000000001' });
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

  // P6-006: a code the server rejects outright is a correctable mistake, not
  // an error to read. The manual-entry sheet opens pre-filled with the digits.
  it('offers the manual-entry sheet pre-filled on a 400 invalid-barcode response', async () => {
    mockUseLocalSearchParams.mockReturnValue({ barcode: '14006381333931' });
    mockApiGet.mockRejectedValue(new ApiError(400, 'Invalid barcode format', {}));

    const { findByTestId, getByTestId, queryByText } = render(<ProductScreen />);

    await findByTestId('product-invalid-barcode');
    expect(queryByText(/Invalid barcode format/i)).toBeNull();
    expect(getByTestId('manual-barcode-input').props.value).toBe('1400638133393');

    fireEvent.changeText(getByTestId('manual-barcode-input'), '4006381333931');
    fireEvent.press(getByTestId('manual-barcode-submit'));

    // `replace`: the corrected code takes the place of the broken screen.
    expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/product/4006381333931');
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

  it('suppresses the rubber-band bounce on the scroll host (P5-006)', async () => {
    mockProductAndNoExistingRating({
      id: 'p1',
      barcode: '0000000000001',
      name: 'Sourdough Loaf',
      brand: 'Artisan',
      image: null,
      description: null,
    });
    const { findByText, getByTestId } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    const scroll = getByTestId('product-screen');
    expect(scroll.props.alwaysBounceVertical).toBe(false);
    expect(scroll.props.overScrollMode).toBe('never');
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

  // P5-007: anonymous users see the same banner copy, plus a note in place of
  // the tap affordance. The server omits `submittedByUserId` from their copy of
  // the product, so the "not my own submission" check passes on `undefined`.
  it('shows the banner as a non-interactive note for anonymous users', async () => {
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
    });
    const { findByTestId, getByText } = render(<ProductScreen />);
    const banner = await findByTestId('review-product-banner');

    // Same title and explanation a registered reviewer reads…
    expect(getByText('Needs review')).toBeTruthy();
    expect(getByText(/added by a user — does it look correct\?/i)).toBeTruthy();
    // …plus the guest note, and no way to reach the reviewer screen.
    expect(getByText('Log in to review this product.')).toBeTruthy();
    expect(banner.props.onPress).toBeUndefined();
    fireEvent.press(banner);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('omits the guest note for registered users', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'reviewer', is_anonymous: false } },
      isAnonymous: false,
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
    const { findByTestId, queryByTestId } = render(<ProductScreen />);
    await findByTestId('review-product-banner');
    expect(queryByTestId('review-product-banner-guest-note')).toBeNull();
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
      if (path.startsWith('/api/users/me/ratings')) {
        return Promise.resolve([ratingEntry(PRODUCT, 8, 'Solid loaf')]);
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
      if (path.startsWith('/api/users/me/ratings')) {
        return Promise.resolve([ratingEntry(PRODUCT, 6, null)]);
      }
      return Promise.resolve(PRODUCT);
    });
    mockApiPost.mockResolvedValue(ratingEntry(PRODUCT, 6, null));

    const { findByText, getByText } = render(<ProductScreen />);
    await findByText('Update Rating');
    fireEvent.press(getByText('Update Rating'));
    await findByText(/Rating Updated!/i);
  });

  it('never issues the per-product /api/ratings/me/:barcode lookup (P8-002)', async () => {
    mockProductAndNoExistingRating(PRODUCT);
    const { findByText } = render(<ProductScreen />);
    await findByText('Submit Rating');
    const meCalls = mockApiGet.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].startsWith('/api/ratings/me/'),
    );
    expect(meCalls).toHaveLength(0);
  });

  it('pre-fills an anonymous user’s own previous rating (P8-003)', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/users/me/ratings')) {
        return Promise.resolve([ratingEntry(PRODUCT, 7, null)]);
      }
      return Promise.resolve(PRODUCT);
    });

    const { findByText } = render(<ProductScreen />);
    await findByText('Update Rating');
    await findByText('7.0');
  });
});
