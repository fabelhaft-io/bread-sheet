import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { CategorySeed } from '@/features/categories/seeds';
import type { UserCategory } from '@/features/categories/types';

import { CategoryPickerSheet, type PickerActionResult } from './category-picker-sheet';

/**
 * The picker is pure presentation (TICKET-P6-003): every network call is a
 * prop the screen supplies, so these tests exercise the near-match flow and
 * the list ordering purely against the callbacks, with no `lib/api` mock.
 */

function category(id: string, name: string, slug: string, ratingCount = 0): UserCategory {
  return { id, name, slug, isSeed: false, ratingCount, createdAt: '2026-01-01T00:00:00.000Z' };
}

async function renderSheet(overrides: Partial<React.ComponentProps<typeof CategoryPickerSheet>> = {}) {
  const onClose = jest.fn();
  const onSelectExisting = jest.fn();
  const onSelectSeed = jest
    .fn<Promise<PickerActionResult>, [CategorySeed]>()
    .mockResolvedValue({ ok: true });
  const onCreate = jest
    .fn<Promise<PickerActionResult>, [string]>()
    .mockResolvedValue({ ok: true });
  const onClear = jest.fn();

  const props = {
    visible: true,
    onClose,
    ownCategories: [],
    currentSelection: null,
    onSelectExisting,
    onSelectSeed,
    onCreate,
    onClear,
    ...overrides,
  };

  const view = await render(<CategoryPickerSheet {...props} />);
  return { ...view, onClose, onSelectExisting, onSelectSeed, onCreate, onClear };
}

describe('CategoryPickerSheet', () => {
  it('renders nothing while closed', async () => {
    await render(
      <CategoryPickerSheet
        visible={false}
        onClose={jest.fn()}
        ownCategories={[]}
        currentSelection={null}
        onSelectExisting={jest.fn()}
        onSelectSeed={jest.fn()}
        onCreate={jest.fn()}
        onClear={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('category-picker-new')).toBeNull();
  });

  it('lists own categories most-used first, then unused seeds, then "+ New category"', async () => {
    await renderSheet({
      ownCategories: [category('c1', 'Beer', 'beer', 1), category('c2', 'Wine', 'wine', 9)],
    });

    // Own categories, most-used first.
    expect(screen.getByTestId('category-picker-own-c2')).toBeTruthy();
    expect(screen.getByTestId('category-picker-own-c1')).toBeTruthy();
    // Seeds already materialised ("wine", "beer") are not offered again.
    expect(screen.queryByTestId('category-picker-seed-wine')).toBeNull();
    expect(screen.queryByTestId('category-picker-seed-beer')).toBeNull();
    // An unused seed is still offered.
    expect(screen.getByTestId('category-picker-seed-cigars')).toBeTruthy();
    expect(screen.getByTestId('category-picker-new')).toBeTruthy();
  });

  it('selects an existing category with no network call and closes', async () => {
    const { onSelectExisting, onClose } = await renderSheet({
      ownCategories: [category('c1', 'Wine', 'wine', 2)],
    });
    await fireEvent.press(screen.getByTestId('category-picker-own-c1'));

    expect(onSelectExisting).toHaveBeenCalledWith(category('c1', 'Wine', 'wine', 2));
    expect(onClose).toHaveBeenCalled();
  });

  it('offers "No category" only when something is currently selected', async () => {
    await renderSheet({ currentSelection: null });
    expect(screen.queryByTestId('category-picker-clear')).toBeNull();

    await renderSheet({ currentSelection: { kind: 'existing', id: 'c1', name: 'Wine' } });
    expect(screen.getByTestId('category-picker-clear')).toBeTruthy();
  });

  it('clears the category and closes', async () => {
    const { onClear, onClose } = await renderSheet({
      currentSelection: { kind: 'existing', id: 'c1', name: 'Wine' },
    });
    await fireEvent.press(screen.getByTestId('category-picker-clear'));
    expect(onClear).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('picks an unused seed via the one-tap row', async () => {
    const { onSelectSeed, onClose } = await renderSheet();
    await fireEvent.press(screen.getByTestId('category-picker-seed-wine'));

    await waitFor(() => expect(onSelectSeed).toHaveBeenCalledWith({ slug: 'wine', name: 'Wine' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the seed row error and keeps the sheet open on failure', async () => {
    const onSelectSeed = jest
      .fn<Promise<PickerActionResult>, [CategorySeed]>()
      .mockResolvedValue({ ok: false, message: 'Could not add that category.' });
    const { onClose } = await renderSheet({ onSelectSeed });

    await fireEvent.press(screen.getByTestId('category-picker-seed-wine'));

    await screen.findByTestId('category-picker-error');
    expect(screen.getByTestId('category-picker-error')).toHaveTextContent('Could not add that category.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('creates a brand-new category with no near match', async () => {
    const { onCreate, onClose } = await renderSheet();
    await fireEvent.press(screen.getByTestId('category-picker-new'));
    await fireEvent.changeText(screen.getByTestId('category-picker-name-input'), 'Negroni');
    await fireEvent.press(screen.getByTestId('category-picker-submit-name'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Negroni'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('rejects an empty name without calling onCreate', async () => {
    const { onCreate } = await renderSheet();
    await fireEvent.press(screen.getByTestId('category-picker-new'));
    await fireEvent.press(screen.getByTestId('category-picker-submit-name'));

    expect(screen.getByTestId('category-picker-name-error')).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
  });

  // "Did you mean…?" — a nudge, not a gate: offered first, but rejecting it
  // still creates the typed name.
  it('offers "Did you mean…?" for a near-match own category, and "create anyway" still creates', async () => {
    const { onCreate, onSelectExisting } = await renderSheet({
      ownCategories: [category('c1', 'Wine', 'wine', 2)],
    });
    await fireEvent.press(screen.getByTestId('category-picker-new'));
    await fireEvent.changeText(screen.getByTestId('category-picker-name-input'), 'Win');
    await fireEvent.press(screen.getByTestId('category-picker-submit-name'));

    await screen.findByText('Did you mean Wine?');
    expect(onCreate).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('category-picker-create-anyway'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Win'));
    expect(onSelectExisting).not.toHaveBeenCalled();
  });

  it('"Use <match>" selects the existing category with no new row created', async () => {
    const { onCreate, onSelectExisting, onClose } = await renderSheet({
      ownCategories: [category('c1', 'Wine', 'wine', 2)],
    });
    await fireEvent.press(screen.getByTestId('category-picker-new'));
    await fireEvent.changeText(screen.getByTestId('category-picker-name-input'), 'Win');
    await fireEvent.press(screen.getByTestId('category-picker-submit-name'));
    await screen.findByTestId('category-picker-use-match');

    await fireEvent.press(screen.getByTestId('category-picker-use-match'));

    expect(onSelectExisting).toHaveBeenCalledWith(category('c1', 'Wine', 'wine', 2));
    expect(onCreate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a near-match against a seed uses onSelectSeed, not onCreate', async () => {
    const { onCreate, onSelectSeed } = await renderSheet();
    await fireEvent.press(screen.getByTestId('category-picker-new'));
    await fireEvent.changeText(screen.getByTestId('category-picker-name-input'), 'Win');
    await fireEvent.press(screen.getByTestId('category-picker-submit-name'));
    await screen.findByTestId('category-picker-use-match');

    await fireEvent.press(screen.getByTestId('category-picker-use-match'));

    await waitFor(() => expect(onSelectSeed).toHaveBeenCalledWith({ slug: 'wine', name: 'Wine' }));
    expect(onCreate).not.toHaveBeenCalled();
  });
});
