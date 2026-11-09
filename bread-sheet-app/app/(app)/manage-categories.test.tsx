import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import ManageCategoriesScreen from './manage-categories';

/**
 * TICKET-P6-003 — the Manage Categories screen: rename, merge, delete.
 * Deleting must never claim ratings are removed; they are kept, uncategorised.
 *
 * `Platform.OS` under jest-expo is not `'web'`, so the screen's confirmation
 * goes through `Alert.alert` (the native branch), not `window.confirm` —
 * same convention as `app/(tabs)/profile.tsx`'s sign-out confirmation.
 */

const mockUseSession = jest.fn();

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/lib/api');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { api, ApiError } = require('@/lib/api') as typeof import('@/lib/api');
const mockApiGet = api.get as jest.Mock;
const mockApiPost = api.post as jest.Mock;
const mockApiPatch = api.patch as jest.Mock;
const mockApiDelete = api.delete as jest.Mock;

function category(id: string, name: string, slug: string, ratingCount = 0) {
  return { id, name, slug, isSeed: false, ratingCount, createdAt: '2026-01-01T00:00:00.000Z' };
}

/** Presses the given button label in the last `Alert.alert` call. */
async function pressAlertButton(label: string) {
  const call = (Alert.alert as jest.Mock).mock.calls.at(-1);
  const buttons = call?.[2] as { text: string; onPress?: () => void }[] | undefined;
  await act(async () => {
    buttons?.find((b) => b.text === label)?.onPress?.();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseSession.mockReturnValue({
    session: { user: { id: 'u1', is_anonymous: false } },
    isAnonymous: false,
  });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

describe('ManageCategoriesScreen', () => {
  it('shows an empty state with no categories', async () => {
    mockApiGet.mockResolvedValue([]);
    const { findByTestId } = await render(<ManageCategoriesScreen />);
    await findByTestId('manage-categories-empty');
  });

  it('lists categories most-used first, with their rating counts', async () => {
    mockApiGet.mockResolvedValue([
      category('c1', 'Beer', 'beer', 2),
      category('c2', 'Wine', 'wine', 9),
    ]);
    const { findByTestId, getByTestId } = await render(<ManageCategoriesScreen />);
    await findByTestId('manage-categories-row-c2');

    expect(getByTestId('manage-categories-name-c2')).toHaveTextContent('Wine');
    expect(getByTestId('manage-categories-count-c2')).toHaveTextContent('9 ratings');
    expect(getByTestId('manage-categories-count-c1')).toHaveTextContent('2 ratings');
  });

  it('renames a category', async () => {
    mockApiGet.mockResolvedValue([category('c1', 'Win', 'win', 1)]);
    mockApiPatch.mockResolvedValue(category('c1', 'Wine', 'win', 1));

    const { findByTestId, getByTestId } = await render(<ManageCategoriesScreen />);
    await findByTestId('manage-categories-row-c1');

    await fireEvent.press(getByTestId('manage-categories-rename-c1'));
    await fireEvent.changeText(getByTestId('manage-categories-rename-input-c1'), 'Wine');
    await fireEvent.press(getByTestId('manage-categories-rename-save-c1'));

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith('/api/users/me/categories/c1', { name: 'Wine' }),
    );
  });

  it('rejects an empty rename without calling the API', async () => {
    mockApiGet.mockResolvedValue([category('c1', 'Wine', 'wine', 1)]);
    const { findByTestId, getByTestId } = await render(<ManageCategoriesScreen />);
    await findByTestId('manage-categories-row-c1');

    await fireEvent.press(getByTestId('manage-categories-rename-c1'));
    await fireEvent.changeText(getByTestId('manage-categories-rename-input-c1'), '');
    await fireEvent.press(getByTestId('manage-categories-rename-save-c1'));

    expect(mockApiPatch).not.toHaveBeenCalled();
  });

  it('merges a category into another', async () => {
    mockApiGet.mockResolvedValue([
      category('c1', 'Beer', 'beer', 1),
      category('c2', 'Lager', 'lager', 1),
    ]);
    mockApiPost.mockResolvedValue(category('c1', 'Beer', 'beer', 2));

    const { findByTestId, getByTestId } = await render(<ManageCategoriesScreen />);
    await findByTestId('manage-categories-row-c2');

    await fireEvent.press(getByTestId('manage-categories-merge-c2'));
    await fireEvent.press(getByTestId('manage-categories-merge-target-c2-c1'));

    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/api/users/me/categories/c2/merge', { intoId: 'c1' }),
    );
  });

  it('deletes a category with confirmation copy that says ratings are kept', async () => {
    mockApiGet.mockResolvedValue([category('c1', 'Wine', 'wine', 4)]);
    mockApiDelete.mockResolvedValue(undefined);

    const { findByTestId, getByTestId } = await render(<ManageCategoriesScreen />);
    await findByTestId('manage-categories-row-c1');

    await fireEvent.press(getByTestId('manage-categories-delete-c1'));

    expect(Alert.alert).toHaveBeenCalledWith(
      'Delete category',
      expect.stringMatching(/keep their rating but become uncategorised/i),
      expect.anything(),
    );
    await pressAlertButton('Delete');
    await waitFor(() => expect(mockApiDelete).toHaveBeenCalledWith('/api/users/me/categories/c1'));
  });

  it('does not delete when the confirmation is declined', async () => {
    mockApiGet.mockResolvedValue([category('c1', 'Wine', 'wine', 4)]);

    const { findByTestId, getByTestId } = await render(<ManageCategoriesScreen />);
    await findByTestId('manage-categories-row-c1');
    await fireEvent.press(getByTestId('manage-categories-delete-c1'));
    await pressAlertButton('Cancel');

    expect(mockApiDelete).not.toHaveBeenCalled();
  });

  it('shows a row-scoped error on a failed rename, not a screen-wide crash', async () => {
    mockApiGet.mockResolvedValue([category('c1', 'Wine', 'wine', 1)]);
    mockApiPatch.mockRejectedValue(new ApiError(409, 'unique_violation', {}));

    const { findByTestId, getByTestId } = await render(<ManageCategoriesScreen />);
    await findByTestId('manage-categories-row-c1');

    await fireEvent.press(getByTestId('manage-categories-rename-c1'));
    await fireEvent.changeText(getByTestId('manage-categories-rename-input-c1'), 'Beer');
    await fireEvent.press(getByTestId('manage-categories-rename-save-c1'));

    await findByTestId('manage-categories-row-error-c1');
  });
});
