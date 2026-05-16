import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import AddProductScreen from './add-product';

// ─── Shared mocks ──────────────────────────────────────────────────────
// The anonymous-user guard and the core flow are the main behaviours we
// need to pin down. Everything else (ML Kit, image-manipulator, FormData-
// based uploads) is business logic owned by `features/products/*` and is
// mocked at the module boundary so these tests stay focused on the screen.

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

// Preserve ApiError as a real class so `instanceof` branches in the screen
// (422 handling, in particular) resolve correctly.
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
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
  };
});

jest.mock('@/features/products/api', () => ({
  submitProduct: jest.fn(),
  uploadProductImage: jest.fn().mockResolvedValue({ url: 'https://s3/mock.jpg' }),
  extractLabelFromText: jest.fn(),
  extractLabelFromImage: jest.fn(),
  approveProduct: jest.fn(),
  rejectProduct: jest.fn(),
}));

jest.mock('@/features/products/image-picker', () => ({
  captureImage: jest.fn().mockResolvedValue({ uri: 'file:///tmp/photo.jpg' }),
}));

jest.mock('@/features/products/image-processing', () => ({
  processCaptureForUpload: jest
    .fn()
    .mockResolvedValue({ uri: 'file:///tmp/processed.jpg', size: 1024 }),
  ImageTooLargeError: class ImageTooLargeError extends Error {
    bytes: number;
    constructor(bytes: number) {
      super('too big');
      this.bytes = bytes;
    }
  },
}));

jest.mock('@/features/products/extract', () => ({
  extractFromLabelImage: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError } = require('@/lib/api') as typeof import('@/lib/api');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const productsApi = require('@/features/products/api');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const extractModule = require('@/features/products/extract');

describe('AddProductScreen — access control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalSearchParams.mockReturnValue({ barcode: '0000000000001' });
  });

  it('shows the sign-up gate for anonymous users and carries barcode into returnTo', () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'g1', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    const { getByTestId } = render(<AddProductScreen />);
    fireEvent.press(getByTestId('add-product-signup'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(auth)/signup',
      params: { returnTo: '/product/0000000000001' },
    });
  });

  it('renders the full form for registered users (photos step)', () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    const { getByTestId } = render(<AddProductScreen />);
    expect(getByTestId('add-product-screen')).toBeTruthy();
    expect(getByTestId('product-photo-slot')).toBeTruthy();
    expect(getByTestId('label-photo-slot')).toBeTruthy();
  });
});

describe('AddProductScreen — flow progression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalSearchParams.mockReturnValue({ barcode: '0000000000001' });
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    (Alert.alert as jest.Mock).mockRestore?.();
  });

  it('skipping extraction lands on the review step with an empty form', async () => {
    const { getByTestId, queryByTestId } = render(<AddProductScreen />);
    fireEvent.press(getByTestId('photos-skip'));
    await waitFor(() => expect(getByTestId('field-name')).toBeTruthy());
    // No "mode" switcher when we skipped extraction (nothing to pre-fill).
    expect(queryByTestId('fill-mode-row')).toBeNull();
  });

  it('pre-fills the form when extraction succeeds with medium+ confidence', async () => {
    extractModule.extractFromLabelImage.mockResolvedValue({
      kind: 'ok',
      path: 'text',
      data: {
        name: 'Sourdough',
        brand: 'Artisan',
        genericName: null,
        energyKcal: 250,
        carbohydrates: 50,
        fat: 2,
        protein: 8,
        salt: 1,
        servingSize: '100g',
        ingredients: 'flour, water, salt',
        confidence: 'high',
      },
    });

    const { getByTestId, findByTestId } = render(<AddProductScreen />);
    // Simulate the label photo being present so "Read the label" is enabled.
    fireEvent.press(getByTestId('label-photo-slot-camera'));
    await waitFor(() =>
      expect(getByTestId('photos-continue').props.accessibilityState?.disabled).not.toBe(
        true,
      ),
    );
    fireEvent.press(getByTestId('photos-continue'));

    const nameField = await findByTestId('field-name');
    expect(nameField.props.value).toBe('Sourdough');
    // Fill mode switcher appears when there was extracted data.
    expect(getByTestId('fill-mode-row')).toBeTruthy();
  });

  it('surfaces a 422 plausibility error from submit as a field-level error', async () => {
    productsApi.submitProduct.mockRejectedValue(
      new ApiError(422, 'Implausible values', {
        reason: 'Energy too high',
        field: 'energyKcal',
      }),
    );

    const { getByTestId } = render(<AddProductScreen />);
    // Capture the product photo *while still on the photos step* — it's a
    // submit prerequisite and the slot disappears once we leave this step.
    fireEvent.press(getByTestId('product-photo-slot-library'));
    // Give the async capture+process chain a beat to resolve so the
    // productPhotoUri state is set before we advance.
    await waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const picker = require('@/features/products/image-picker');
      expect(picker.captureImage).toHaveBeenCalled();
    });
    fireEvent.press(getByTestId('photos-skip'));
    await waitFor(() => expect(getByTestId('field-name')).toBeTruthy());
    fireEvent.changeText(getByTestId('field-name'), 'Mystery bread');
    fireEvent.changeText(getByTestId('field-energyKcal'), '9999');
    fireEvent.press(getByTestId('submit-product'));

    await waitFor(() => expect(getByTestId('field-energyKcal-error')).toBeTruthy());
  });
});
