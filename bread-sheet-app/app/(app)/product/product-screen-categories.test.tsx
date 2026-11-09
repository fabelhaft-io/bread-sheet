import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { NetworkError } from '@/lib/api';

import ProductScreen from './[id]';

/**
 * TICKET-P6-003 — the rating screen's category row: the pre-selected
 * suggestion (mapped onto an existing own category, or offered as a
 * one-tap seed create), the full picker, removing a category, and the
 * offline seed fallback that carries through the outbox.
 */

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  navigate: jest.fn(),
  setParams: jest.fn(),
};
const mockUseSession = jest.fn();
const mockEnqueue = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    useLocalSearchParams: () => ({ id: 'p1' }),
    useRouter: () => mockRouter,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run-once mock
    useFocusEffect: (cb: () => unknown) => React.useEffect(() => cb(), []),
  };
});

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

// A fresh object per call (not one built once inside the factory) is
// required here: the factory runs the first time anything requires this
// module, which — via the `ProductScreen` import above — can happen before
// `mockEnqueue` below has been assigned. Reading `mockEnqueue` lazily, at
// `useOutbox()` call time (safely after all of this file's module-level
// code has run), avoids baking in a stale/undefined reference.
jest.mock('@/hooks/use-outbox', () => ({
  useOutbox: () => ({
    queued: [] as unknown[],
    failures: [] as unknown[],
    isQueued: () => false,
    enqueue: mockEnqueue,
    flush: jest.fn(),
    dismissFailures: jest.fn(),
  }),
}));

jest.mock('@/hooks/use-recent-products', () => {
  const value = { addRecentProduct: jest.fn(), recentProducts: [] as unknown[] };
  return { useRecentProducts: () => value };
});

jest.mock('@/lib/api');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { api } = require('@/lib/api') as typeof import('@/lib/api');
const mockApiGet = api.get as jest.Mock;
const mockApiPost = api.post as jest.Mock;

const PRODUCT = {
  id: 'p1',
  kind: 'PACKAGED' as const,
  name: 'Sourdough Loaf',
  brand: 'Artisan',
  image: null,
  description: null,
  packaged: { gtin: '0000000000001' },
};

function withSuggestion(suggestedCategory: string | null) {
  return { ...PRODUCT, suggestedCategory };
}

/** Stubs `/api/products/:id`, `/api/users/me/ratings`, `/api/users/me/categories`. */
function mockLoad(options: {
  product?: unknown;
  ratings?: unknown[];
  categories?: unknown[];
}) {
  const { product = PRODUCT, ratings = [], categories = [] } = options;
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/users/me/ratings')) return Promise.resolve(ratings);
    if (path.startsWith('/api/users/me/categories')) return Promise.resolve(categories);
    return Promise.resolve(product);
  });
}

function category(id: string, name: string, slug: string, ratingCount = 0) {
  return { id, name, slug, isSeed: false, ratingCount, createdAt: '2026-01-01T00:00:00.000Z' };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseSession.mockReturnValue({
    session: { user: { id: 'u1', is_anonymous: false } },
    isAnonymous: false,
    isLoading: false,
  });
  mockApiPost.mockResolvedValue({
    id: 'r1',
    score: 5,
    taste: 5,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: 'p1', kind: 'PACKAGED', name: 'Sourdough Loaf', brand: 'Artisan', image: null },
    category: null,
  });
});

describe('ProductScreen — category suggestion (TICKET-P6-003)', () => {
  it('pre-selects the chip when the suggestion maps to an existing own category', async () => {
    mockLoad({
      product: withSuggestion('wine'),
      categories: [category('c1', 'Wine', 'wine', 3)],
    });

    const { findByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    const chip = await findByTestId('category-chip-selected');
    expect(chip).toHaveTextContent(/Wine/);
  });

  it('sends the pre-selected existing category on submit with no extra tap', async () => {
    mockLoad({
      product: withSuggestion('wine'),
      categories: [category('c1', 'Wine', 'wine', 3)],
    });

    const { findByText, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');
    await fireEvent.press(getByText('Submit Rating'));

    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/api/ratings', {
        productId: 'p1',
        taste: 5,
        comment: undefined,
        categoryId: 'c1',
      }),
    );
  });

  it('offers an unmatched seed as a one-tap create, materialising exactly one category', async () => {
    mockLoad({ product: withSuggestion('wine'), categories: [] });

    const { findByTestId, findByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');

    const suggestionChip = await findByTestId('category-chip-suggestion');
    expect(suggestionChip).toHaveTextContent(/Wine/);

    mockApiPost.mockImplementation((path: string) => {
      if (path === '/api/users/me/categories') {
        return Promise.resolve(category('c-new', 'Wine', 'wine', 0));
      }
      return Promise.resolve({
        id: 'r1',
        score: 5,
        taste: 5,
        comment: null,
        createdAt: new Date().toISOString(),
        product: { id: 'p1', kind: 'PACKAGED', name: 'Sourdough Loaf', brand: 'Artisan', image: null },
        category: { id: 'c-new', name: 'Wine' },
      });
    });

    await fireEvent.press(suggestionChip);

    const selected = await findByTestId('category-chip-selected');
    expect(selected).toHaveTextContent(/Wine/);
    expect(mockApiPost).toHaveBeenCalledWith('/api/users/me/categories', { seedSlug: 'wine' });

    await fireEvent.press(await findByText('Submit Rating'));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/api/ratings', {
        productId: 'p1',
        taste: 5,
        comment: undefined,
        categoryId: 'c-new',
      }),
    );
  });

  it('shows a plain "+ Add category" chip with no suggestion, opening the full picker', async () => {
    mockLoad({ product: withSuggestion(null), categories: [category('c1', 'Wine', 'wine', 1)] });

    const { findByTestId } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    const addChip = await findByTestId('category-chip-add');
    await fireEvent.press(addChip);

    expect(await findByTestId('category-picker-own-c1')).toBeTruthy();
  });

  it('skipping sends no category field at all', async () => {
    mockLoad({ product: withSuggestion(null), categories: [] });

    const { findByText, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    await findByText('Sourdough Loaf');
    await fireEvent.press(getByText('Submit Rating'));

    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/api/ratings', {
        productId: 'p1',
        taste: 5,
        comment: undefined,
      }),
    );
  });
});

describe('ProductScreen — category picker (TICKET-P6-003)', () => {
  it('selects a different existing category from the picker', async () => {
    mockLoad({
      product: withSuggestion(null),
      categories: [category('c1', 'Wine', 'wine', 1), category('c2', 'Cigars', 'cigars', 1)],
    });

    const { findByTestId, getByText } = await render(<ProductScreen />, {
      wrapper: GestureHandlerRootView,
    });
    await fireEvent.press(await findByTestId('category-chip-add'));
    await fireEvent.press(await findByTestId('category-picker-own-c2'));

    const selected = await findByTestId('category-chip-selected');
    expect(selected).toHaveTextContent(/Cigars/);

    await fireEvent.press(getByText('Submit Rating'));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/api/ratings', {
        productId: 'p1',
        taste: 5,
        comment: undefined,
        categoryId: 'c2',
      }),
    );
  });

  it('creates a brand-new category from the picker and uses it on submit', async () => {
    mockLoad({ product: withSuggestion(null), categories: [] });
    mockApiPost.mockImplementation((path: string) => {
      if (path === '/api/users/me/categories') {
        return Promise.resolve(category('c-new', 'Negroni', 'negroni', 0));
      }
      return Promise.resolve({
        id: 'r1',
        score: 5,
        taste: 5,
        comment: null,
        createdAt: new Date().toISOString(),
        product: { id: 'p1', kind: 'PACKAGED', name: 'Sourdough Loaf', brand: 'Artisan', image: null },
        category: { id: 'c-new', name: 'Negroni' },
      });
    });

    const { findByTestId, getByText } = await render(<ProductScreen />, {
      wrapper: GestureHandlerRootView,
    });
    await fireEvent.press(await findByTestId('category-chip-add'));
    await fireEvent.press(await findByTestId('category-picker-new'));
    await fireEvent.changeText(await findByTestId('category-picker-name-input'), 'Negroni');
    await fireEvent.press(await findByTestId('category-picker-submit-name'));

    const selected = await findByTestId('category-chip-selected');
    expect(selected).toHaveTextContent(/Negroni/);

    await fireEvent.press(getByText('Submit Rating'));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/api/ratings', {
        productId: 'p1',
        taste: 5,
        comment: undefined,
        categoryId: 'c-new',
      }),
    );
  });

  it('lets the user remove a pre-filled category and sends an explicit categoryId: null', async () => {
    mockLoad({
      product: withSuggestion(null),
      ratings: [
        {
          id: 'r1',
          score: 6,
          taste: 6,
          comment: null,
          createdAt: new Date().toISOString(),
          product: { id: 'p1', kind: 'PACKAGED', name: 'Sourdough Loaf', brand: 'Artisan', image: null },
          category: { id: 'c1', name: 'Wine' },
        },
      ],
      categories: [category('c1', 'Wine', 'wine', 1)],
    });

    const { findByTestId, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    const selected = await findByTestId('category-chip-selected');
    expect(selected).toHaveTextContent(/Wine/);

    await fireEvent.press(await findByTestId('category-chip-remove'));

    await fireEvent.press(getByText('Update Rating'));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/api/ratings', {
        productId: 'p1',
        taste: 6,
        comment: undefined,
        categoryId: null,
      }),
    );
  });
});

describe('ProductScreen — offline seed selection (TICKET-P6-003)', () => {
  it('falls back to carrying the seed slug when materialising it fails offline, and queues the rating with it', async () => {
    mockLoad({ product: withSuggestion('wine'), categories: [] });
    mockApiPost.mockImplementation((path: string) => {
      if (path === '/api/users/me/categories') return Promise.reject(new NetworkError());
      return Promise.reject(new NetworkError());
    });

    const { findByTestId, getByText } = await render(<ProductScreen />, { wrapper: GestureHandlerRootView });
    const suggestionChip = await findByTestId('category-chip-suggestion');
    await fireEvent.press(suggestionChip);

    // Still offered for use (as the seed itself) even though nothing could
    // be created on the server — "nothing is written" holds, and the
    // selection is resolved once the rating is actually sent.
    const selected = await findByTestId('category-chip-selected');
    expect(selected).toHaveTextContent(/Wine/);

    await fireEvent.press(getByText('Submit Rating'));

    await waitFor(() =>
      expect(mockEnqueue).toHaveBeenCalledWith({
        productId: 'p1',
        taste: 5,
        comment: null,
        seedSlug: 'wine',
      }),
    );
  });
});
