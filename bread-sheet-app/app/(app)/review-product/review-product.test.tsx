import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import ReviewProductScreen from './[id]';

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};
const mockUseLocalSearchParams = jest.fn(() => ({ id: 'p1' }));
const mockUseSession = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockUseLocalSearchParams(),
}));

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/features/products/api', () => ({
  getProduct: jest.fn(),
  approveProduct: jest.fn(),
  rejectProduct: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const productsApi = require('@/features/products/api');

describe('ReviewProductScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalSearchParams.mockReturnValue({ id: 'p1' });
    mockUseSession.mockReturnValue({
      session: { user: { id: 'reviewer', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
  });

  it('redirects anonymous users to the signup screen with returnTo', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    const { getByTestId, getByText } = await render(<ReviewProductScreen />);
    expect(getByTestId('review-product-anon-gate')).toBeTruthy();
    await fireEvent.press(getByText('Sign up'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(auth)/signup',
      params: { returnTo: '/product/p1' },
    });
  });

  it('calls approveProduct when the reviewer taps "Looks correct"', async () => {
    productsApi.getProduct.mockResolvedValue({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'Mystery bread',
      brand: null,
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'someone-else',
      submission: { name: 'Mystery bread' },
      packaged: { gtin: '0000000000001' },
    });
    productsApi.approveProduct.mockResolvedValue({ verifications: 1 });

    const { findByTestId } = await render(<ReviewProductScreen />);
    const btn = await findByTestId('review-approve');
    await fireEvent.press(btn);
    await waitFor(() =>
      expect(productsApi.approveProduct).toHaveBeenCalledWith('p1'),
    );
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/product/[id]',
      params: { id: 'p1' },
    });
  });

  it('hides action buttons and shows a note when the viewer is the submitter', async () => {
    productsApi.getProduct.mockResolvedValue({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'My bread',
      brand: null,
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'reviewer',
      submission: { name: 'My bread' },
      packaged: { gtin: '0000000000001' },
    });
    const { findByTestId, queryByTestId } = await render(<ReviewProductScreen />);
    await findByTestId('own-submission-note');
    expect(queryByTestId('review-approve')).toBeNull();
    expect(queryByTestId('review-reject')).toBeNull();
  });

  it('renders every submission field, surfacing nulls as "Not provided"', async () => {
    productsApi.getProduct.mockResolvedValue({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'Mystery bread',
      brand: 'Artisan',
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'someone-else',
      packaged: { gtin: '0000000000001' },
      submission: {
        name: 'Mystery bread',
        brand: 'Artisan',
        genericName: null,
        energyKcal: 250,
        fat: null,
        saturatedFat: null,
        carbohydrates: null,
        sugars: null,
        protein: null,
        salt: null,
        servingSize: null,
        ingredients: null,
      },
    });
    const { findByTestId, getAllByText } = await render(<ReviewProductScreen />);
    await findByTestId('review-details');
    expect(getAllByText('Not provided').length).toBeGreaterThanOrEqual(9);
  });

  it('omits the barcode chip for a CUSTOM product (no packaged row)', async () => {
    productsApi.getProduct.mockResolvedValue({
      id: 'p1',
      kind: 'CUSTOM',
      name: 'Whisky Sour',
      brand: null,
      image: null,
      description: null,
      unverified: true,
      submittedByUserId: 'someone-else',
      packaged: null,
      submission: { name: 'Whisky Sour' },
    });
    const { findAllByText, queryByText } = await render(<ReviewProductScreen />);
    await findAllByText('Whisky Sour');
    expect(queryByText(/^\d{8,13}$/)).toBeNull();
  });

  it('suppresses the rubber-band bounce on the scroll host (P5-006)', async () => {
    productsApi.getProduct.mockResolvedValue({
      id: 'p1',
      kind: 'PACKAGED',
      name: 'Mystery bread',
      brand: null,
      image: null,
      description: null,
      unverified: true,
      packaged: { gtin: '0000000000001' },
      submission: { submittedByUserId: 'submitter' },
    });
    const { findByTestId } = await render(<ReviewProductScreen />);
    const scroll = await findByTestId('review-product-screen');
    expect(scroll.props.alwaysBounceVertical).toBe(false);
    expect(scroll.props.overScrollMode).toBe('never');
  });
});
