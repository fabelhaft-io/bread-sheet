import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import ProductScreen from './[id]';

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
  navigate: jest.fn(),
};
const mockUseLocalSearchParams = jest.fn(() => ({ id: 'p1' }));
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
// state updates that clobber the state we are trying to assert. Memoise
// both the function and the wrapping object inside the factory closure.
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
 *  - GET /api/products/:id
 *  - GET /api/users/me/ratings — only when this device has no cached copy of
 *    the list; "my rating" is then read out of it by product id. The
 *    per-product `GET /api/ratings/me/:barcode` round trip is gone.
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
function ratingEntry(product: { id: string; kind: string; name: string; brand: string | null },
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

describe('ProductScreen — id-based 404', () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
    mockRouter.replace.mockClear();
    mockRouter.back.mockClear();
    mockRouter.navigate.mockClear();
    mockApiGet.mockReset();
    mockUseSession.mockReset();
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    mockUseLocalSearchParams.mockReturnValue({ id: 'p1' });
  });

  // Unlike the gtin resolver's not-found state, an id has no gtin to offer
  // "add this product" against — this is a plain dead end.
  it('renders a plain not-found screen with a "Back to Home" action, no add-product CTA', async () => {
    mockApiGet.mockRejectedValue(new ApiError(404, 'Product not found', {}));
    const { findByTestId, queryByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByTestId('product-id-not-found');
    expect(queryByTestId('product-not-found-add')).toBeNull();
    expect(queryByTestId('product-not-found-signup')).toBeNull();

    await fireEvent.press(await findByTestId('product-not-found-home'));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/(tabs)');
  });

  it('shows a friendly generic message (not the raw server error, not the not-found UI) on non-404 failures', async () => {
    // Server returns a verbose internal message — the screen must replace it
    // with safe, user-facing copy so we never expose internals on iOS.
    mockApiGet.mockRejectedValue(
      new ApiError(500, 'PrismaClientKnownRequestError: FK constraint Rating_userId_fkey', {}),
    );
    const { findByText, queryByText, queryByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText(/Could not load this product/i);
    expect(queryByText(/Prisma|FK constraint|userId/i)).toBeNull();
    expect(queryByTestId('product-id-not-found')).toBeNull();
  });

  it('renders the product normally on a 2xx response — no regression for known products', async () => {
    mockProductAndNoExistingRating({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'Sourdough Loaf',
      brand: 'Artisan',
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
    });
    const { findByText, queryByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');
    await waitFor(() => expect(queryByTestId('product-id-not-found')).toBeNull());
  });

  it('shows the barcode chip for a PACKAGED product', async () => {
    mockProductAndNoExistingRating({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'Sourdough Loaf',
      brand: 'Artisan',
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
    });
    const { findByText, queryByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');
    expect(queryByText('0000000000001')).toBeTruthy();
  });

  // P6-007 (not built yet) is what will produce a CUSTOM product; the branch
  // and its test land now per the ticket's scope guard.
  it('renders no barcode chip for a CUSTOM product (no packaged row)', async () => {
    mockUseLocalSearchParams.mockReturnValue({ id: 'p2' });
    mockProductAndNoExistingRating({
      id: 'p2',
      kind: 'CUSTOM',
      name: 'Whisky Sour',
      brand: null,
      image: null,
      description: null,
      packaged: null,
    });
    const { findByText, queryByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Whisky Sour');
    expect(queryByText(/^\d{8,13}$/)).toBeNull();
  });

  it('suppresses the rubber-band bounce on the scroll host (P5-006)', async () => {
    mockProductAndNoExistingRating({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'Sourdough Loaf',
      brand: 'Artisan',
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
    });
    const { findByText, getByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
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
    mockUseLocalSearchParams.mockReturnValue({ id: 'p1' });
  });

  it('shows the "Needs review" banner for a registered non-submitter on a PENDING_REVIEW product', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'reviewer', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    mockProductAndNoExistingRating({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'Mystery bread',
      brand: 'Artisan',
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
      unverified: true,
      submittedByUserId: 'someone-else',
    });
    const { findByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    const banner = await findByTestId('review-product-banner');
    await fireEvent.press(banner);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(app)/review-product/[id]',
      params: { id: 'p1' },
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
      kind: 'PACKAGED',
      name: 'My bread',
      brand: null,
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
      unverified: true,
      submittedByUserId: 'submitter',
    });
    const { findByText, queryByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
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
      kind: 'PACKAGED',
      name: 'Mystery bread',
      brand: null,
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
      unverified: true,
    });
    const { findByTestId, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    const banner = await findByTestId('review-product-banner');

    // Same title and explanation a registered reviewer reads…
    expect(getByText('Needs review')).toBeTruthy();
    expect(getByText(/added by a user — does it look correct\?/i)).toBeTruthy();
    // …plus the guest note, and no way to reach the reviewer screen.
    expect(getByText('Log in to review this product.')).toBeTruthy();
    expect(banner.props.onPress).toBeUndefined();
    await fireEvent.press(banner);
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
      kind: 'PACKAGED',
      name: 'Mystery bread',
      brand: null,
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
      unverified: true,
      submittedByUserId: 'someone-else',
    });
    const { findByTestId, queryByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
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
      kind: 'PACKAGED',
      name: 'Sourdough',
      brand: 'Artisan',
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
    });
    const { findByText, queryByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough');
    expect(queryByTestId('review-product-banner')).toBeNull();
  });
});

describe('ProductScreen — rating submission errors', () => {
  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiPost.mockReset();
    mockUseSession.mockReset();
    mockUseLocalSearchParams.mockReturnValue({ id: 'p1' });
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    mockProductAndNoExistingRating({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'Sourdough Loaf',
      brand: 'Artisan',
      image: null,
      description: null,
      packaged: { gtin: '0000000000001' },
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
    const { findByText, queryByText, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');
    await fireEvent.press(getByText('Submit Rating'));
    await findByText(/Could not submit your rating/i);
    expect(queryByText(/Prisma|Rating_userId_fkey|Foreign key/i)).toBeNull();
  });

  it('forwards the validator copy on a 400 (server-controlled message is safe to show)', async () => {
    mockApiPost.mockRejectedValue(
      new ApiError(400, 'taste must be between 0 and 10 in 0.5 increments', {}),
    );
    const { findByText, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');
    await fireEvent.press(getByText('Submit Rating'));
    await findByText(/taste must be between/i);
  });

  it('submits ratings keyed by productId, not barcode', async () => {
    mockApiPost.mockResolvedValue({
      id: 'r1',
      score: 5,
      taste: 5,
      comment: null,
      createdAt: new Date().toISOString(),
      product: { id: 'p1', kind: 'PACKAGED', name: 'Sourdough Loaf', brand: 'Artisan', image: null },
    });
    const { findByText, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');
    await fireEvent.press(getByText('Submit Rating'));
    await findByText(/Rating Submitted!/i);
    expect(mockApiPost).toHaveBeenCalledWith('/api/ratings', {
      productId: 'p1',
      taste: 5,
      comment: undefined,
    });
  });
});

describe('ProductScreen — existing rating pre-fill', () => {
  const PRODUCT = {
    id: 'p1',
    kind: 'PACKAGED' as const,
    name: 'Sourdough Loaf',
    brand: 'Artisan',
    image: null,
    description: null,
    packaged: { gtin: '0000000000001' },
  };

  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiPost.mockReset();
    mockUseSession.mockReset();
    mockUseLocalSearchParams.mockReturnValue({ id: 'p1' });
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

    const { findByText, queryByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });

    await findByText('Sourdough Loaf');
    // Submit-button copy reflects the update intent
    await findByText('Update Rating');
    expect(queryByText('Submit Rating')).toBeNull();
    // Slider badge shows the pre-filled score (one decimal place for whole numbers)
    await findByText('8.0');
  });

  it('shows the "Submit Rating" button when the user has no existing rating', async () => {
    mockProductAndNoExistingRating(PRODUCT);
    const { findByText, queryByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
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

    const { findByText, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Update Rating');
    await fireEvent.press(getByText('Update Rating'));
    await findByText(/Rating Updated!/i);
  });

  it('never issues the per-product /api/ratings/me/:id lookup (P8-002)', async () => {
    mockProductAndNoExistingRating(PRODUCT);
    const { findByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
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

    const { findByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Update Rating');
    await findByText('7.0');
  });
});

/**
 * The way out of the success card.
 *
 * The card is a state of this screen, not a route, so `router.back()` sent the
 * user wherever they entered from — after a scan, the camera still pointed at
 * the barcode they had just rated, which scanned it again and dropped them
 * right back on the rating form. The exit has to be an explicit destination.
 */
describe('ProductScreen — leaving the success card', () => {
  const PRODUCT = {
    id: 'p1',
    kind: 'PACKAGED' as const,
    name: 'Sourdough Loaf',
    brand: 'Artisan',
    image: null,
    description: null,
    packaged: { gtin: '0000000000001' },
  };

  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiPost.mockReset();
    mockUseSession.mockReset();
    mockUseLocalSearchParams.mockReturnValue({ id: 'p1' });
    // The router mock is module-level: without this, one test's navigation is
    // still on record in the next one.
    mockRouter.navigate.mockClear();
    mockRouter.back.mockClear();
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    mockProductAndNoExistingRating(PRODUCT);
    mockApiPost.mockResolvedValue(ratingEntry(PRODUCT, 5, null));
  });

  async function submitRating() {
    const view = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await view.findByText('Sourdough Loaf');
    await fireEvent.press(view.getByText('Submit Rating'));
    await view.findByTestId('rating-submitted');
    return view;
  }

  it('sends the user to the Home tab instead of popping back to the scanner', async () => {
    const { getByTestId } = await submitRating();

    await fireEvent.press(getByTestId('rating-submitted-home'));

    expect(mockRouter.navigate).toHaveBeenCalledWith('/(tabs)');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('offers a way back to the product itself, which returns the rating form', async () => {
    const { getByTestId, findByTestId, queryByTestId } = await submitRating();

    await fireEvent.press(getByTestId('rating-submitted-back-to-product'));

    await findByTestId('product-screen');
    expect(queryByTestId('rating-submitted')).toBeNull();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('retires the success card when the screen is left, so it cannot come back stale', async () => {
    const { unmount } = await submitRating();

    // The focus-effect cleanup runs on blur as well as unmount; the mocked
    // `useFocusEffect` exposes it as the effect cleanup, so unmounting is how a
    // unit test reaches it. It must not throw, and re-rendering the screen has
    // to land on the form.
    await unmount();

    const { findByText, queryByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');
    expect(queryByTestId('rating-submitted')).toBeNull();
  });
});
