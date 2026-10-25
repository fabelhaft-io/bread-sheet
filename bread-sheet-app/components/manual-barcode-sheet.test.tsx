import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ManualBarcodeSheet } from './manual-barcode-sheet';

/**
 * TICKET-P6-006: the manual-entry sheet is the camera-free route into the
 * product flow. It must land on exactly the screen a scan lands on, and it must
 * never let a code through that the server would answer with a bare 400.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ManualBarcodeSheet', () => {
  it('navigates to the gtin resolver for the entered code', async () => {
    await render(<ManualBarcodeSheet visible onClose={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '4006381333931');
    await fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/gtin/4006381333931');
  });

  it('closes itself once it has navigated', async () => {
    const onClose = jest.fn();
    await render(<ManualBarcodeSheet visible onClose={onClose} />);

    await fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '4006381333931');
    await fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(onClose).toHaveBeenCalled();
  });

  it('reports too-short and non-digit input with distinguishable copy', async () => {
    await render(<ManualBarcodeSheet visible onClose={jest.fn()} />);
    const input = screen.getByTestId('manual-barcode-input');

    await fireEvent.changeText(input, '1234567');
    await fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(screen.getByTestId('manual-barcode-error')).toHaveTextContent(/Too short/);
    expect(mockRouter.push).not.toHaveBeenCalled();

    // A letter is a different mistake from a wrong length and says so — the
    // field keeps letters precisely so this error can be shown.
    await fireEvent.changeText(input, '40063813A3931');
    await fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(screen.getByTestId('manual-barcode-error')).toHaveTextContent(/digits only/);
    expect(mockRouter.push).not.toHaveBeenCalled();

    await fireEvent.changeText(input, '12345678901234');
    await fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(screen.getByTestId('manual-barcode-error')).toHaveTextContent(/Too long/);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('does not complain before the first submit', async () => {
    await render(<ManualBarcodeSheet visible onClose={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '123');

    expect(screen.queryByTestId('manual-barcode-error')).toBeNull();
  });

  it('strips separators from typed or pasted input', async () => {
    await render(<ManualBarcodeSheet visible onClose={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '4006 381-333931');
    await fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/gtin/4006381333931');
  });

  it('pre-fills from initialValue so a bad scan is corrected, not retyped', async () => {
    await render(
      <ManualBarcodeSheet visible onClose={jest.fn()} initialValue="00040063813339311" />
    );

    // Capped at the maximum barcode length while seeding.
    expect(screen.getByTestId('manual-barcode-input').props.value).toBe('0004006381333');
  });

  it('uses the onSubmit override instead of navigating when one is given', async () => {
    const onSubmit = jest.fn();
    await render(<ManualBarcodeSheet visible onClose={jest.fn()} onSubmit={onSubmit} />);

    await fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '12345678');
    await fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(onSubmit).toHaveBeenCalledWith('12345678');
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', async () => {
    await render(<ManualBarcodeSheet visible={false} onClose={jest.fn()} />);

    expect(screen.queryByTestId('manual-barcode-input')).toBeNull();
  });
});
