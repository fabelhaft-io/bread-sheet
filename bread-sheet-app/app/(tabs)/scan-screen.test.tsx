import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import ScanScreen from './scan';

/**
 * TICKET-P6-006: the scan tab must offer a way in that does not depend on the
 * camera at all, and a code that reads but is not a barcode we can look up must
 * become an editable field rather than an error.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockPermission = jest.fn();
const requestPermission = jest.fn();

// Captured so the test can drive the scan callback and assert on the
// symbologies the camera was configured with.
let cameraProps: Record<string, any> = {};

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    useRouter: () => mockRouter,
    // The screen only uses the focus effect to reset its scan lock.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run-once mock, deps intentionally empty
    useFocusEffect: (cb: () => unknown) => React.useEffect(() => cb(), []),
  };
});

jest.mock('expo-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    useCameraPermissions: () => mockPermission(),
    CameraView: (props: Record<string, any>) => {
      cameraProps = props;
      return <View testID="camera-view" />;
    },
  };
});

beforeEach(() => {
  // The screen re-arms its scan lock on a timer; fake timers keep that from
  // outliving the test run.
  jest.useFakeTimers();
  jest.clearAllMocks();
  cameraProps = {};
  mockPermission.mockReturnValue([{ granted: true }, requestPermission]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ScanScreen', () => {
  it('offers manual entry when camera permission has not been granted', () => {
    mockPermission.mockReturnValue([{ granted: false }, requestPermission]);
    render(<ScanScreen />);

    expect(screen.getByTestId('scan-manual-entry')).toBeTruthy();
    expect(screen.queryByTestId('camera-view')).toBeNull();
  });

  it('offers manual entry before the permission state is known', () => {
    mockPermission.mockReturnValue([null, requestPermission]);
    render(<ScanScreen />);

    expect(screen.getByTestId('scan-manual-entry')).toBeTruthy();
  });

  it('opens the manual sheet and routes to the entered code', () => {
    render(<ScanScreen />);

    fireEvent.press(screen.getByTestId('scan-manual-entry'));
    fireEvent.changeText(screen.getByTestId('manual-barcode-input'), '4006381333931');
    fireEvent.press(screen.getByTestId('manual-barcode-submit'));

    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/4006381333931');
  });

  it('recognises itf14 and code128 alongside the four retail symbologies', () => {
    render(<ScanScreen />);

    expect(cameraProps.barcodeScannerSettings.barcodeTypes).toEqual(
      expect.arrayContaining(['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'itf14'])
    );
  });

  it('routes a valid scanned code straight to the product screen', () => {
    render(<ScanScreen />);

    fireEvent(screen.getByTestId('camera-view'), 'onBarcodeScanned', { data: '4006381333931' });

    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/4006381333931');
    expect(screen.queryByTestId('manual-barcode-input')).toBeNull();
  });

  it('opens the manual sheet pre-filled when a scan fails server validation', () => {
    render(<ScanScreen />);

    // An ITF-14 case code: reads fine, but is 14 digits and would come back as
    // a bare `400 Invalid barcode format`.
    fireEvent(screen.getByTestId('camera-view'), 'onBarcodeScanned', { data: '14006381333931' });

    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(screen.getByTestId('manual-barcode-input').props.value).toBe('1400638133393');
  });

  it('stops scanning while the manual sheet is open', () => {
    render(<ScanScreen />);

    fireEvent.press(screen.getByTestId('scan-manual-entry'));

    expect(cameraProps.onBarcodeScanned).toBeUndefined();
  });
});
