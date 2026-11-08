import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AddChoiceSheet } from './add-choice-sheet';

/**
 * TICKET-P6-007: the Home tab's "＋" now offers a choice before anything else
 * happens — barcode vs. "something with no barcode".
 */
describe('AddChoiceSheet', () => {
  it('calls onPickBarcode when the barcode option is pressed', async () => {
    const onPickBarcode = jest.fn();
    await render(
      <AddChoiceSheet
        visible
        onClose={jest.fn()}
        onPickBarcode={onPickBarcode}
        onPickCustom={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByTestId('add-choice-barcode'));
    expect(onPickBarcode).toHaveBeenCalledTimes(1);
  });

  it('calls onPickCustom when the no-barcode option is pressed', async () => {
    const onPickCustom = jest.fn();
    await render(
      <AddChoiceSheet
        visible
        onClose={jest.fn()}
        onPickBarcode={jest.fn()}
        onPickCustom={onPickCustom}
      />,
    );

    await fireEvent.press(screen.getByTestId('add-choice-custom'));
    expect(onPickCustom).toHaveBeenCalledTimes(1);
  });

  it('closes via the cancel button and the backdrop', async () => {
    const onClose = jest.fn();
    await render(
      <AddChoiceSheet visible onClose={onClose} onPickBarcode={jest.fn()} onPickCustom={jest.fn()} />,
    );

    await fireEvent.press(screen.getByTestId('add-choice-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('add-choice-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders nothing while closed', async () => {
    await render(
      <AddChoiceSheet
        visible={false}
        onClose={jest.fn()}
        onPickBarcode={jest.fn()}
        onPickCustom={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('add-choice-barcode')).toBeNull();
  });
});
