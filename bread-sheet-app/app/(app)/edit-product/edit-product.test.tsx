import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import EditProductScreen from './[barcode]';

// ─── Shared mocks (same conventions as add-product.test.tsx) ────────────────

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

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest
        .fn()
        .mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

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

jest.mock('@/features/products/api', () => ({
  correctProduct: jest.fn(),
  proposeProductEdit: jest.fn(),
  uploadProductImage: jest
    .fn()
    .mockResolvedValue({ imageKey: 'processed/mock-uuid.jpg', name: null, brand: null, genericName: null }),
}));

jest.mock('@/features/products/image-picker', () => ({
  captureImage: jest.fn().mockResolvedValue({ uri: 'file:///tmp/photo.jpg' }),
}));

jest.mock('@/features/products/image-processing', () => ({
  processCaptureForUpload: jest
    .fn()
    .mockResolvedValue({ uri: 'file:///tmp/processed.jpg', size: 1024 }),
  ImageTooLargeError: class ImageTooLargeError extends Error {},
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError, api } = require('@/lib/api') as typeof import('@/lib/api');
const mockApiGet = api.get as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const productsApi = require('@/features/products/api');
const mockCorrectProduct = productsApi.correctProduct as jest.Mock;
const mockProposeEdit = productsApi.proposeProductEdit as jest.Mock;

const VERIFIED_PRODUCT = {
  id: 'p1',
  barcode: '0000000000001',
  name: 'Sourdough Loaf',
  brand: 'Artisan',
  image: null,
  description: null,
  status: 'VERIFIED',
  unverified: false,
  genericName: 'Bread',
  energyKcal: 250,
  fat: 3.5,
  saturatedFat: 1.2,
  carbohydrates: 45,
  sugars: 5,
  protein: 8,
  salt: 1.2,
  servingSize: '50g',
  ingredients: 'Flour, water, salt',
};

function signIn(anonymous = false) {
  mockUseSession.mockReturnValue({
    session: { user: { id: 'u1', is_anonymous: anonymous } },
    isAnonymous: anonymous,
    isLoading: false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  signIn();
  mockApiGet.mockResolvedValue(VERIFIED_PRODUCT);
});

describe('EditProductScreen — access control', () => {
  it('shows the signup gate for anonymous users and never fetches the product', async () => {
    signIn(true);
    const { findByTestId } = render(<EditProductScreen />);
    await findByTestId('edit-product-anon-gate');
    expect(mockApiGet).not.toHaveBeenCalled();
  });
});

describe('EditProductScreen — pre-population & unchanged submits', () => {
  it('pre-fills every field from the current product values', async () => {
    const { findByTestId } = render(<EditProductScreen />);
    expect((await findByTestId('field-name')).props.value).toBe('Sourdough Loaf');
    expect((await findByTestId('field-brand')).props.value).toBe('Artisan');
    expect((await findByTestId('field-energyKcal')).props.value).toBe('250');
    expect((await findByTestId('field-ingredients')).props.value).toBe('Flour, water, salt');
  });

  it('renders the barcode read-only', async () => {
    const { findByTestId } = render(<EditProductScreen />);
    const barcodeField = await findByTestId('field-barcode');
    expect(barcodeField.props.editable).toBe(false);
    expect(barcodeField.props.value).toBe('0000000000001');
  });

  it('disables submit while nothing changed and shows the hint', async () => {
    const { findByTestId } = render(<EditProductScreen />);
    const submit = await findByTestId('submit-edit');
    expect(submit.props.accessibilityState?.disabled).toBe(true);
    await findByTestId('no-changes-hint');
    fireEvent.press(submit);
    expect(mockProposeEdit).not.toHaveBeenCalled();
    expect(mockCorrectProduct).not.toHaveBeenCalled();
  });
});

describe('EditProductScreen — VERIFIED proposal path', () => {
  it('sends only the changed fields to proposeProductEdit', async () => {
    mockProposeEdit.mockResolvedValue({ editId: 'e1', barcode: '0000000000001', status: 'PENDING' });
    const { findByTestId } = render(<EditProductScreen />);

    fireEvent.changeText(await findByTestId('field-name'), 'Sourdough Boule');
    fireEvent.changeText(await findByTestId('field-salt'), '1.5');
    fireEvent.press(await findByTestId('submit-edit'));

    await waitFor(() =>
      expect(mockProposeEdit).toHaveBeenCalledWith('0000000000001', {
        name: 'Sourdough Boule',
        salt: 1.5,
      }),
    );
    expect(mockCorrectProduct).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/product/[barcode]',
      params: { barcode: '0000000000001' },
    });
  });

  it('surfaces the 409 edit_pending conflict inline', async () => {
    mockProposeEdit.mockRejectedValue(new ApiError(409, 'edit_pending', { error: 'edit_pending' }));
    const { findByTestId, findByText } = render(<EditProductScreen />);

    fireEvent.changeText(await findByTestId('field-name'), 'Sourdough Boule');
    fireEvent.press(await findByTestId('submit-edit'));

    await findByText(/already under review/i);
  });

  it('blocks submit-side validation errors (bad number) client-side', async () => {
    const { findByTestId } = render(<EditProductScreen />);

    fireEvent.changeText(await findByTestId('field-energyKcal'), 'lots');
    fireEvent.press(await findByTestId('submit-edit'));

    await findByTestId('field-energyKcal-error');
    expect(mockProposeEdit).not.toHaveBeenCalled();
  });
});

describe('EditProductScreen — PENDING_REVIEW correction path', () => {
  beforeEach(() => {
    mockApiGet.mockResolvedValue({
      ...VERIFIED_PRODUCT,
      status: 'PENDING_REVIEW',
      unverified: true,
    });
  });

  it('labels the intent and PATCHes the full payload via correctProduct', async () => {
    mockCorrectProduct.mockResolvedValue({ barcode: '0000000000001', status: 'PENDING_REVIEW' });
    const { findByTestId, findByText } = render(<EditProductScreen />);

    await findByText('Correct this submission');
    fireEvent.changeText(await findByTestId('field-name'), 'Fixed Name');
    fireEvent.press(await findByTestId('submit-edit'));

    await waitFor(() => expect(mockCorrectProduct).toHaveBeenCalled());
    const [barcode, payload] = mockCorrectProduct.mock.calls[0];
    expect(barcode).toBe('0000000000001');
    // Full payload — unchanged fields are included on the correction path.
    expect(payload).toMatchObject({
      name: 'Fixed Name',
      brand: 'Artisan',
      energyKcal: 250,
    });
    // Photo untouched -> no productImageKey in the payload.
    expect('productImageKey' in payload).toBe(false);
    expect(mockProposeEdit).not.toHaveBeenCalled();
  });
});
