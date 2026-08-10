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
  it('navigates to the product screen for the entered code', () => {
    render(<ManualBarcodeSheet visible onClose={jest.fn()} />);

    fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '4006381333931');
    fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/4006381333931');
  });

  it('closes itself once it has navigated', () => {
    const onClose = jest.fn();
    render(<ManualBarcodeSheet visible onClose={onClose} />);

    fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '4006381333931');
    fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(onClose).toHaveBeenCalled();
  });

  it('reports too-short and non-digit input with distinguishable copy', () => {
    render(<ManualBarcodeSheet visible onClose={jest.fn()} />);
    const input = screen.getByTestId('manual-barcode-input');

    fireEvent.changeText(input, '1234567');
    fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(screen.getByTestId('manual-barcode-error')).toHaveTextContent(/Too short/);
    expect(mockRouter.push).not.toHaveBeenCalled();

    // A letter is a different mistake from a wrong length and says so — the
    // field keeps letters precisely so this error can be shown.
    fireEvent.changeText(input, '40063813A3931');
    fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(screen.getByTestId('manual-barcode-error')).toHaveTextContent(/digits only/);
    expect(mockRouter.push).not.toHaveBeenCalled();

    fireEvent.changeText(input, '12345678901234');
    fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(screen.getByTestId('manual-barcode-error')).toHaveTextContent(/Too long/);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('does not complain before the first submit', () => {
    render(<ManualBarcodeSheet visible onClose={jest.fn()} />);

    fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '123');

    expect(screen.queryByTestId('manual-barcode-error')).toBeNull();
  });

  it('strips separators from typed or pasted input', () => {
    render(<ManualBarcodeSheet visible onClose={jest.fn()} />);

    fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '4006 381-333931');
    fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/4006381333931');
  });

  it('pre-fills from initialValue so a bad scan is corrected, not retyped', () => {
    render(
      <ManualBarcodeSheet visible onClose={jest.fn()} initialValue="00040063813339311" />
    );

    // Capped at the maximum barcode length while seeding.
    expect(screen.getByTestId('manual-barcode-input').props.value).toBe('0004006381333');
  });

  it('uses the onSubmit override instead of navigating when one is given', () => {
    const onSubmit = jest.fn();
    render(<ManualBarcodeSheet visible onClose={jest.fn()} onSubmit={onSubmit} />);

    fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '12345678');
    fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(onSubmit).toHaveBeenCalledWith('12345678');
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    render(<ManualBarcodeSheet visible={false} onClose={jest.fn()} />);

    expect(screen.queryByTestId('manual-barcode-input')).toBeNull();
  });
});
