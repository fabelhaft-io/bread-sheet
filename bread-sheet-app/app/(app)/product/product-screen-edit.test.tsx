import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import ProductScreen from './[barcode]';

// ─── Mocks (same conventions as product-screen.test.tsx) ────────────────────

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run-once mock
    useFocusEffect: (cb: () => unknown) => React.useEffect(() => cb(), []),
  };
});

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/hooks/use-recent-products', () => {
  const addRecentProduct = jest.fn();
  const value = { addRecentProduct, recentProducts: [] as unknown[] };
  return { useRecentProducts: () => value };
});

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
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  };
});

// The pending-edit lookup goes through features/products/api — mock it at the
// module boundary so tests control the banner/notice states directly.
jest.mock('@/features/products/api', () => ({
  getPendingEdit: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError, api } = require('@/lib/api') as typeof import('@/lib/api');
const mockApiGet = api.get as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const productsApi = require('@/features/products/api');
const mockGetPendingEdit = productsApi.getPendingEdit as jest.Mock;

const VERIFIED_PRODUCT = {
  id: 'p1',
  barcode: '0000000000001',
  name: 'Sourdough Loaf',
  brand: 'Artisan',
  image: null,
  description: null,
  status: 'VERIFIED',
  unverified: false,
};

const PENDING_EDIT = {
  editId: 'edit-1',
  barcode: '0000000000001',
  originalValues: { name: 'Sourdough Loaf' },
  proposedChanges: { name: 'Sourdough Boule' },
  approvals: 0,
  rejections: 0,
  createdAt: '2026-07-01T00:00:00Z',
  viewer: { isAuthor: false, vote: null, dismissed: false },
};

function signIn(anonymous = false, id = 'u1') {
  mockUseSession.mockReturnValue({
    session: { user: { id, is_anonymous: anonymous } },
    isAnonymous: anonymous,
    isLoading: false,
  });
}

function mockProduct(product: unknown) {
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/ratings/me/')) {
      return Promise.reject(new ApiError(404, 'No rating yet', {}));
    }
    return Promise.resolve(product);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  signIn();
  mockProduct(VERIFIED_PRODUCT);
  mockGetPendingEdit.mockResolvedValue({ edit: null });
});

describe('ProductScreen — edit entry point (P5-006)', () => {
  it('shows "Edit product" for registered users on a VERIFIED product and navigates', async () => {
    const { findByTestId } = render(<ProductScreen />);
    const btn = await findByTestId('edit-product-button');
    fireEvent.press(btn);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(app)/edit-product/[barcode]',
      params: { barcode: '0000000000001' },
    });
  });

  it('is entirely absent for anonymous users — no disabled state, no tooltip', async () => {
    signIn(true, 'guest');
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    expect(queryByTestId('edit-product-button')).toBeNull();
    expect(queryByTestId('edit-under-review-notice')).toBeNull();
    // Anonymous users must not trigger the pending-edit lookup either.
    expect(mockGetPendingEdit).not.toHaveBeenCalled();
  });

  it('labels the button "Correct this submission" on a PENDING_REVIEW product', async () => {
    mockProduct({
      ...VERIFIED_PRODUCT,
      status: 'PENDING_REVIEW',
      unverified: true,
      submittedByUserId: 'someone-else',
    });
    const { findByText, findByTestId } = render(<ProductScreen />);
    await findByTestId('edit-product-button');
    await findByText(/Correct this submission/);
  });

  it('hides the button and shows the notice when an edit is already under review', async () => {
    mockGetPendingEdit.mockResolvedValue({ edit: PENDING_EDIT });
    const { findByTestId, queryByTestId } = render(<ProductScreen />);
    await findByTestId('edit-under-review-notice');
    expect(queryByTestId('edit-product-button')).toBeNull();
  });
});

describe('ProductScreen — suggested-change banner (P5-006)', () => {
  it('shows the banner to a registered non-author and opens the diff screen', async () => {
    mockGetPendingEdit.mockResolvedValue({ edit: PENDING_EDIT });
    const { findByTestId } = render(<ProductScreen />);
    const banner = await findByTestId('review-edit-banner');
    fireEvent.press(banner);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(app)/review-edit/[editId]',
      params: { editId: 'edit-1', barcode: '0000000000001' },
    });
  });

  it('hides the banner from the edit author', async () => {
    mockGetPendingEdit.mockResolvedValue({
      edit: { ...PENDING_EDIT, viewer: { isAuthor: true, vote: null, dismissed: false } },
    });
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    expect(queryByTestId('review-edit-banner')).toBeNull();
  });

  it('hides the banner after the viewer dismissed the edit', async () => {
    mockGetPendingEdit.mockResolvedValue({
      edit: { ...PENDING_EDIT, viewer: { isAuthor: false, vote: null, dismissed: true } },
    });
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    expect(queryByTestId('review-edit-banner')).toBeNull();
    // The under-review notice still applies (edit exists) even when dismissed.
    expect(queryByTestId('edit-under-review-notice')).toBeTruthy();
  });

  it('hides the banner after the viewer voted', async () => {
    mockGetPendingEdit.mockResolvedValue({
      edit: { ...PENDING_EDIT, viewer: { isAuthor: false, vote: 'APPROVE', dismissed: false } },
    });
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    expect(queryByTestId('review-edit-banner')).toBeNull();
  });

  it('shows no banner when there is no pending edit', async () => {
    const { findByText, queryByTestId } = render(<ProductScreen />);
    await findByText('Sourdough Loaf');
    expect(queryByTestId('review-edit-banner')).toBeNull();
  });
});
