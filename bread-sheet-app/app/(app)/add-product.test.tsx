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
jest.mock('@/lib/api');

jest.mock('@/features/products/api', () => ({
  submitProduct: jest.fn(),
  uploadProductImage: jest.fn().mockResolvedValue({ imageKey: 'processed/mock-uuid.jpg' }),
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const imageProcessing = require('@/features/products/image-processing');

describe('AddProductScreen — access control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalSearchParams.mockReturnValue({ barcode: '0000000000001' });
  });

  it('shows the sign-up gate for anonymous users and carries barcode into returnTo', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'g1', is_anonymous: true } },
      isAnonymous: true,
      isLoading: false,
    });
    const { getByTestId } = await render(<AddProductScreen />);
    await fireEvent.press(getByTestId('add-product-signup'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(auth)/signup',
      params: { returnTo: '/product/0000000000001' },
    });
  });

  it('renders the full form for registered users (photos step)', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    const { getByTestId } = await render(<AddProductScreen />);
    expect(getByTestId('add-product-screen')).toBeTruthy();
    expect(getByTestId('product-photo-slot')).toBeTruthy();
    expect(getByTestId('label-photo-slot')).toBeTruthy();
  });

  it('suppresses the rubber-band bounce on the scroll host (P5-006)', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    const { getByTestId } = await render(<AddProductScreen />);
    const scroll = getByTestId('add-product-screen');
    expect(scroll.props.alwaysBounceVertical).toBe(false);
    expect(scroll.props.overScrollMode).toBe('never');
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
    const { getByTestId, queryByTestId } = await render(<AddProductScreen />);
    await fireEvent.press(getByTestId('photos-skip'));
    await waitFor(() => expect(getByTestId('field-name')).toBeTruthy());
    // No "mode" switcher when we skipped extraction (nothing to pre-fill).
    expect(queryByTestId('fill-mode-row')).toBeNull();
  });

  it('shows a per-slot processing indicator while the capture is being resized', async () => {
    // Hold the resize promise open so we can observe the in-flight state.
    let resolveProcessing!: (v: { uri: string; size: number }) => void;
    imageProcessing.processCaptureForUpload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProcessing = resolve;
        }),
    );

    const { getByTestId, queryByTestId, findByTestId } = await render(<AddProductScreen />);
    // Not awaited yet: RNTL 14's fireEvent waits for the press handler, which
    // is parked on the resize promise this test deliberately holds open.
    const pressed = fireEvent.press(getByTestId('product-photo-slot-camera'));

    // Spinner + text appear while processCaptureForUpload is pending.
    await findByTestId('product-photo-slot-processing');
    // The other slot is unaffected.
    expect(queryByTestId('label-photo-slot-processing')).toBeNull();

    // Resolving the resize clears the indicator — in the handler's `finally`,
    // several awaits (session, upload) later, so wait for it rather than
    // asserting on the next tick.
    resolveProcessing({ uri: 'file:///tmp/processed.jpg', size: 1024 });
    await waitFor(() => expect(queryByTestId('product-photo-slot-processing')).toBeNull());
    await pressed;
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
        fat: 2,
        saturatedFat: null,
        carbohydrates: 50,
        sugars: null,
        protein: 8,
        salt: 1,
        servingSize: '100g',
        ingredients: 'flour, water, salt',
        confidence: 'high',
      },
    });

    const { getByTestId, findByTestId } = await render(<AddProductScreen />);
    // Simulate the label photo being present so "Read the label" is enabled.
    await fireEvent.press(getByTestId('label-photo-slot-camera'));
    await waitFor(() =>
      expect(getByTestId('photos-continue').props.accessibilityState?.disabled).not.toBe(
        true,
      ),
    );
    await fireEvent.press(getByTestId('photos-continue'));

    const nameField = await findByTestId('field-name');
    expect(nameField.props.value).toBe('Sourdough');
    // Fill mode switcher appears when there was extracted data.
    expect(getByTestId('fill-mode-row')).toBeTruthy();
  });

  it('still pre-fills (and warns) when extraction succeeds with low confidence', async () => {
    // A spice with a clean ingredient list but no nutrition table reads as
    // "low" — we must keep the ingredients rather than blanking the form.
    extractModule.extractFromLabelImage.mockResolvedValue({
      kind: 'ok',
      path: 'image',
      data: {
        name: 'Kräutersteak Gewürz',
        brand: null,
        genericName: 'Gewürz',
        energyKcal: null,
        fat: null,
        saturatedFat: null,
        carbohydrates: null,
        sugars: null,
        protein: null,
        salt: null,
        servingSize: null,
        ingredients: 'Himalaya Steinsalz (20%), Pfeffer, Paprika',
        confidence: 'low',
      },
    });

    const { getByTestId, findByTestId } = await render(<AddProductScreen />);
    await fireEvent.press(getByTestId('label-photo-slot-camera'));
    await waitFor(() =>
      expect(getByTestId('photos-continue').props.accessibilityState?.disabled).not.toBe(
        true,
      ),
    );
    await fireEvent.press(getByTestId('photos-continue'));

    // Ingredients are pre-filled despite low confidence...
    const ingredientsField = await findByTestId('field-ingredients');
    expect(ingredientsField.props.value).toBe('Himalaya Steinsalz (20%), Pfeffer, Paprika');
    expect(getByTestId('field-name').props.value).toBe('Kräutersteak Gewürz');
    // ...the default mode is pre-fill, not manual...
    expect(getByTestId('fill-mode-prefill').props.accessibilityState?.selected).toBe(true);
    // ...and the user is nudged to double-check.
    expect(getByTestId('extraction-warning')).toBeTruthy();
  });

  it('surfaces a capture-time plausibility rejection in the photo slot', async () => {
    productsApi.uploadProductImage.mockRejectedValueOnce(
      new ApiError(422, "This doesn't look like a food product.", {
        error: 'image_rejected',
        reason: "This doesn't look like a food product.",
      }),
    );

    const { getByTestId, findByTestId } = await render(<AddProductScreen />);
    await fireEvent.press(getByTestId('product-photo-slot-camera'));

    const err = await findByTestId('capture-error');
    expect(err.props.children).toMatch(/food product/i);
  });

  it('pre-fills name/brand from the product-photo suggestions (photo wins)', async () => {
    productsApi.uploadProductImage.mockResolvedValueOnce({
      imageKey: 'processed/mock-uuid.jpg',
      name: 'Cola',
      brand: 'Coca-Cola',
      genericName: 'Soft drink',
    });

    const { getByTestId, findByTestId } = await render(<AddProductScreen />);
    await fireEvent.press(getByTestId('product-photo-slot-camera'));
    await waitFor(() => expect(productsApi.uploadProductImage).toHaveBeenCalled());

    await fireEvent.press(getByTestId('photos-skip'));

    const nameField = await findByTestId('field-name');
    expect(nameField.props.value).toBe('Cola');
    expect(getByTestId('field-brand').props.value).toBe('Coca-Cola');
  });

  it('surfaces a 422 plausibility error from submit as a field-level error', async () => {
    productsApi.submitProduct.mockRejectedValue(
      new ApiError(422, 'Implausible values', {
        reason: 'Energy too high',
        field: 'energyKcal',
      }),
    );

    const { getByTestId } = await render(<AddProductScreen />);
    // Capture the product photo *while still on the photos step* — it's a
    // submit prerequisite and the slot disappears once we leave this step.
    await fireEvent.press(getByTestId('product-photo-slot-library'));
    // Give the async capture+process chain a beat to resolve so the
    // productPhotoUri state is set before we advance.
    await waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const picker = require('@/features/products/image-picker');
      expect(picker.captureImage).toHaveBeenCalled();
    });
    await fireEvent.press(getByTestId('photos-skip'));
    await waitFor(() => expect(getByTestId('field-name')).toBeTruthy());
    await fireEvent.changeText(getByTestId('field-name'), 'Mystery bread');
    await fireEvent.changeText(getByTestId('field-energyKcal'), '9999');
    await fireEvent.press(getByTestId('submit-product'));

    await waitFor(() => expect(getByTestId('field-energyKcal-error')).toBeTruthy());
  });
});
