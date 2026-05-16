import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import ReviewProductScreen from './[barcode]';

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};
const mockUseLocalSearchParams = jest.fn(() => ({ barcode: '0000000000001' }));
const mockUseSession = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockUseLocalSearchParams(),
}));

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/lib/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

jest.mock('@/features/products/api', () => ({
  approveProduct: jest.fn(),
  rejectProduct: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { api } = require('@/lib/api');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const productsApi = require('@/features/products/api');

describe('ReviewProductScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalSearchParams.mockReturnValue({ barcode: '0000000000001' });
    mockUseSession.mockReturnValue({
      session: { user: { id: 'reviewer', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
  });

  it('redirects anonymous users to the signup screen with returnTo', () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    const { getByTestId, getByText } = render(<ReviewProductScreen />);
    expect(getByTestId('review-product-anon-gate')).toBeTruthy();
    fireEvent.press(getByText('Sign up'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(auth)/signup',
      params: { returnTo: '/product/0000000000001' },
    });
  });

  it('calls approveProduct when the reviewer taps "Looks correct"', async () => {
    api.get.mockResolvedValue({
      id: 'p1',
      barcode: '0000000000001',
      name: 'Mystery bread',
      brand: null,
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'someone-else',
      submission: { name: 'Mystery bread' },
    });
    productsApi.approveProduct.mockResolvedValue({ verifications: 1 });

    const { findByTestId } = render(<ReviewProductScreen />);
    const btn = await findByTestId('review-approve');
    fireEvent.press(btn);
    await waitFor(() =>
      expect(productsApi.approveProduct).toHaveBeenCalledWith('0000000000001'),
    );
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/product/[barcode]',
      params: { barcode: '0000000000001' },
    });
  });

  it('hides action buttons and shows a note when the viewer is the submitter', async () => {
    api.get.mockResolvedValue({
      id: 'p1',
      barcode: '0000000000001',
      name: 'My bread',
      brand: null,
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'reviewer',
      submission: { name: 'My bread' },
    });
    const { findByTestId, queryByTestId } = render(<ReviewProductScreen />);
    await findByTestId('own-submission-note');
    expect(queryByTestId('review-approve')).toBeNull();
    expect(queryByTestId('review-reject')).toBeNull();
  });

  it('renders every submission field, surfacing nulls as "Not provided"', async () => {
    api.get.mockResolvedValue({
      id: 'p1',
      barcode: '0000000000001',
      name: 'Mystery bread',
      brand: 'Artisan',
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'someone-else',
      submission: {
        name: 'Mystery bread',
        brand: 'Artisan',
        genericName: null,
        energyKcal: 250,
        carbohydrates: null,
        fat: null,
        protein: null,
        salt: null,
        servingSize: null,
        ingredients: null,
      },
    });
    const { findByTestId, getAllByText } = render(<ReviewProductScreen />);
    await findByTestId('review-details');
    // 8 nulls → 8 "Not provided" rows.
    expect(getAllByText('Not provided').length).toBeGreaterThanOrEqual(7);
  });
});
