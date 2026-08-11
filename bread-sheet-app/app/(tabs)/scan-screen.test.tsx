import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import ScanScreen from './scan';

/**
 * TICKET-P6-006: the scan tab must offer a way in that does not depend on the
 * camera at all, and a code that reads but is not a barcode we can look up must
 * become an editable field rather than an error.
 */

const mockPermission = jest.fn();
const requestPermission = jest.fn();

/**
 * Router params the mocked `expo-router` hands back (TICKET-P9-003).
 *
 * `setParams` really mutates this object and re-renders every component that
 * read it, because that is what the real router does — and the injection seam
 * under test clears its own `?inject=` param. A mock that froze the params
 * would keep the seam's effect from ever re-running, so it would pass no matter
 * what the seam did; that is exactly how the "seam cancels its own scan" defect
 * reached a green suite.
 */
let mockParamsState: Record<string, string | undefined> = {};
const mockParamsSubscribers = new Set<() => void>();

function applyMockParams(next: Record<string, string | undefined>) {
  mockParamsState = { ...mockParamsState, ...next };
  for (const key of Object.keys(mockParamsState)) {
    if (mockParamsState[key] === undefined) delete mockParamsState[key];
  }
  mockParamsSubscribers.forEach((notify) => notify());
}

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  setParams: jest.fn(applyMockParams),
};

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
    // Subscribes so a `setParams` call re-renders the caller, like the real hook.
    useLocalSearchParams: () => {
      const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
      React.useEffect(() => {
        mockParamsSubscribers.add(forceRender);
        return () => {
          mockParamsSubscribers.delete(forceRender);
        };
      }, [forceRender]);
      return mockParamsState;
    },
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
  mockParamsState = {};
  mockParamsSubscribers.clear();
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

  // TICKET-P9-003 — the dev-only injection seam the Maestro E2E flow drives via
  // `breadsheet://scan?inject=<barcode>`: it must go through the same routing as
  // a real camera scan, not a separate test-only code path.
  //
  // These run against a router mock whose `setParams` really mutates the params
  // and re-renders (see the top of this file). That re-render is the seam's own
  // doing, and it must not cancel the scan it just started.
  it('injects a scanned barcode from the dev ?inject= param straight to the product screen', () => {
    mockParamsState = { inject: '4006381333931' };
    render(<ScanScreen />);

    // The seam defers past the router's deep-link update via setTimeout(0).
    act(() => {
      jest.runAllTimers();
    });

    expect(mockRouter.setParams).toHaveBeenCalledWith({ inject: undefined });
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/product/4006381333931');
  });

  it('consumes the inject param and still completes the scan it started', () => {
    mockParamsState = { inject: '4006381333931' };
    render(<ScanScreen />);

    act(() => {
      jest.runAllTimers();
    });

    // The param really is gone from the router's state — the seam is spent, so
    // a re-focus cannot replay the scan…
    expect(mockParamsState.inject).toBeUndefined();
    // …and the re-render that clearing it caused did not cancel the pending
    // scan, nor let it fire twice.
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.setParams).toHaveBeenCalledTimes(1);
  });

  it('routes a dev-injected non-lookupable code to the manual sheet, like a real scan', () => {
    mockParamsState = { inject: '14006381333931' };
    render(<ScanScreen />);

    act(() => {
      jest.runAllTimers();
    });

    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(screen.getByTestId('manual-barcode-input').props.value).toBe('1400638133393');
  });

  it('stays inert when no inject param is present', () => {
    render(<ScanScreen />);

    act(() => {
      jest.runAllTimers();
    });

    expect(mockRouter.setParams).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
