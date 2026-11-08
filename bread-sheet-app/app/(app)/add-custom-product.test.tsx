import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

import AddCustomProductScreen from './add-custom-product';
import { ApiError, NetworkError } from '@/lib/api';
import { searchProducts } from '@/features/search/api';

/**
 * TICKET-P6-007 — the Add Custom Product screen: search-before-create,
 * the similarity-based "Did you mean…?" soft gate, the P5-001 sign-up gate
 * on the create action only (search/browse stay open to guests), and the
 * short create form that hands off to the product screen with the rating
 * control focused.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() };
const mockUseSession = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

jest.mock('@/lib/api');

jest.mock('@/features/search/api', () => {
  const actual = jest.requireActual('@/features/search/api');
  return { ...actual, searchProducts: jest.fn() };
});

jest.mock('@/features/products/api', () => ({
  createCustomProduct: jest.fn(),
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
const productsApi = require('@/features/products/api');
const mockCreateCustomProduct = productsApi.createCustomProduct as jest.Mock;
const mockUploadProductImage = productsApi.uploadProductImage as jest.Mock;
const mockSearch = searchProducts as jest.Mock;

function result(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    kind: 'CUSTOM',
    name: `Item ${id}`,
    brand: null,
    image: null,
    unverified: false,
    similarity: 0.1,
    ...overrides,
  };
}

function signIn(anonymous = false) {
  mockUseSession.mockReturnValue({
    session: { user: { id: 'u1', is_anonymous: anonymous } },
    isAnonymous: anonymous,
    isLoading: false,
  });
}

async function typeAndSettle(
  getByTestId: Awaited<ReturnType<typeof render>>['getByTestId'],
  text: string,
) {
  await fireEvent.changeText(getByTestId('custom-product-search-input'), text);
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
}

describe('AddCustomProductScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    signIn();
    mockSearch.mockResolvedValue({ results: [], nextCursor: null });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not offer "Create" below 2 trimmed characters', async () => {
    const { getByTestId, queryByTestId } = await render(<AddCustomProductScreen />);
    await typeAndSettle(getByTestId, 'n');
    expect(queryByTestId('custom-product-create')).toBeNull();
  });

  it('offers "Create \'<query>\'" once the query is searchable and results have loaded', async () => {
    mockSearch.mockResolvedValue({ results: [result('x1', { name: 'Daiquiri', similarity: 0.1 })], nextCursor: null });
    const { getByTestId, findByTestId } = await render(<AddCustomProductScreen />);
    await typeAndSettle(getByTestId, 'negroni');

    await findByTestId('custom-product-create');
    expect(getByTestId('custom-product-create')).toHaveTextContent(/negroni/);
  });

  it('renders search results including both kinds, and opens one on tap', async () => {
    mockSearch.mockResolvedValue({
      results: [result('x1', { name: 'Coca-Cola', kind: 'PACKAGED', brand: 'Coca-Cola Company', similarity: 0.95 })],
      nextCursor: null,
    });
    const { getByTestId, findByText } = await render(<AddCustomProductScreen />);
    await typeAndSettle(getByTestId, 'coca');

    await findByText('Coca-Cola');
    await fireEvent.press(getByTestId('custom-product-result-x1'));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/(app)/product/[id]', params: { id: 'x1' } });
  });

  it('creates directly, pre-filled with the query, when nothing is a close match', async () => {
    mockSearch.mockResolvedValue({ results: [result('x1', { similarity: 0.1 })], nextCursor: null });
    const { getByTestId, findByTestId } = await render(<AddCustomProductScreen />);
    await typeAndSettle(getByTestId, 'negroni');
    await findByTestId('custom-product-create');

    await fireEvent.press(getByTestId('custom-product-create'));

    const nameInput = await findByTestId('custom-product-name-input');
    expect(nameInput.props.value).toBe('negroni');
  });

  it('requires a "Did you mean…?" confirmation when a result is a close match (similarity >= 0.6)', async () => {
    mockSearch.mockResolvedValue({
      results: [result('x1', { name: 'Negroni', similarity: 0.82 })],
      nextCursor: null,
    });
    const { getByTestId, findByTestId, findByText } = await render(<AddCustomProductScreen />);
    await typeAndSettle(getByTestId, 'negroni sbagliato');
    await findByTestId('custom-product-create');

    await fireEvent.press(getByTestId('custom-product-create'));

    await findByText('Did you mean Negroni?');
    await fireEvent.press(getByTestId('custom-product-duplicate-open'));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/(app)/product/[id]', params: { id: 'x1' } });
  });

  it('"No, create" after the confirmation proceeds to the create form pre-filled with the query', async () => {
    mockSearch.mockResolvedValue({
      results: [result('x1', { name: 'Negroni', similarity: 0.82 })],
      nextCursor: null,
    });
    const { getByTestId, findByTestId } = await render(<AddCustomProductScreen />);
    await typeAndSettle(getByTestId, 'negroni sbagliato');
    await findByTestId('custom-product-create');
    await fireEvent.press(getByTestId('custom-product-create'));

    await fireEvent.press(await findByTestId('custom-product-duplicate-create-anyway'));

    const nameInput = await findByTestId('custom-product-name-input');
    expect(nameInput.props.value).toBe('negroni sbagliato');
  });

  it('shows the sign-up gate when an anonymous user taps create, without creating anything', async () => {
    signIn(true);
    mockSearch.mockResolvedValue({ results: [], nextCursor: null });
    const { getByTestId, findByTestId } = await render(<AddCustomProductScreen />);
    await typeAndSettle(getByTestId, 'negroni');
    await findByTestId('custom-product-create');

    await fireEvent.press(getByTestId('custom-product-create'));

    await findByTestId('add-custom-product-signup-gate');
    expect(mockCreateCustomProduct).not.toHaveBeenCalled();

    await fireEvent.press(getByTestId('add-custom-product-signup'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(auth)/signup',
      params: { returnTo: '/add-custom-product' },
    });
  });

  it('reports offline search via the existing offline copy', async () => {
    mockSearch.mockRejectedValue(new NetworkError());
    const { getByTestId, findByTestId } = await render(<AddCustomProductScreen />);
    await typeAndSettle(getByTestId, 'negroni');

    await findByTestId('custom-product-search-offline');
  });

  describe('create form', () => {
    async function openCreateForm() {
      mockSearch.mockResolvedValue({ results: [], nextCursor: null });
      const view = await render(<AddCustomProductScreen />);
      await typeAndSettle(view.getByTestId, 'negroni');
      await view.findByTestId('custom-product-create');
      await fireEvent.press(view.getByTestId('custom-product-create'));
      await view.findByTestId('custom-product-name-input');
      return view;
    }

    it('requires a name', async () => {
      const { getByTestId, findByTestId } = await openCreateForm();
      await fireEvent.changeText(getByTestId('custom-product-name-input'), '   ');
      await fireEvent.press(getByTestId('custom-product-submit'));

      await findByTestId('custom-product-name-error');
      expect(mockCreateCustomProduct).not.toHaveBeenCalled();
    });

    it('creates the product and navigates to it with the rating control focused', async () => {
      mockCreateCustomProduct.mockResolvedValue({ id: 'new-id', status: 'PENDING_REVIEW' });
      const { getByTestId } = await openCreateForm();

      await fireEvent.press(getByTestId('custom-product-submit'));

      expect(mockCreateCustomProduct).toHaveBeenCalledWith({ name: 'negroni' });
      expect(mockRouter.replace).toHaveBeenCalledWith({
        pathname: '/(app)/product/[id]',
        params: { id: 'new-id', focusRating: '1' },
      });
    });

    it('uploads an optional photo with kind=item and includes the imageKey on create', async () => {
      mockUploadProductImage.mockResolvedValue({
        imageKey: 'processed/item-uuid.jpg',
        name: null,
        brand: null,
        genericName: null,
      });
      mockCreateCustomProduct.mockResolvedValue({ id: 'new-id', status: 'PENDING_REVIEW' });
      const { getByTestId, findByTestId } = await openCreateForm();

      await fireEvent.press(getByTestId('custom-product-photo-camera'));
      await findByTestId('custom-product-name-input'); // settle

      expect(mockUploadProductImage).toHaveBeenCalledWith(
        'file:///tmp/processed.jpg',
        'item',
        'Bearer tok',
      );

      await fireEvent.press(getByTestId('custom-product-submit'));
      expect(mockCreateCustomProduct).toHaveBeenCalledWith({
        name: 'negroni',
        imageKey: 'processed/item-uuid.jpg',
      });
    });

    it('navigates to the existing product on a 409 duplicate_name conflict', async () => {
      mockCreateCustomProduct.mockRejectedValue(
        new ApiError(409, 'Duplicate', { code: 'duplicate_name', productId: 'existing-id' }),
      );
      const { getByTestId } = await openCreateForm();

      await fireEvent.press(getByTestId('custom-product-submit'));

      expect(mockRouter.replace).toHaveBeenCalledWith({
        pathname: '/(app)/product/[id]',
        params: { id: 'existing-id' },
      });
    });

    it('reports being offline via formatApiError rather than a raw error (creation is online-only)', async () => {
      mockCreateCustomProduct.mockRejectedValue(new NetworkError());
      const { getByTestId, findByTestId } = await openCreateForm();

      await fireEvent.press(getByTestId('custom-product-submit'));

      const errorNode = await findByTestId('custom-product-submit-error');
      expect(errorNode).toHaveTextContent(/offline/i);
    });

    it('goes back to search without losing the query', async () => {
      const { getByTestId, findByTestId } = await openCreateForm();
      await fireEvent.press(getByTestId('custom-product-back-to-search'));

      const input = await findByTestId('custom-product-search-input');
      expect(input.props.value).toBe('negroni');
    });
  });
});
