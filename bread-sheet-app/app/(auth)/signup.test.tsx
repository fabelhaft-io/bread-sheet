import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import SignUpScreen from './signup';
import * as pendingReturnTo from '@/lib/pending-return-to';
import { signUp } from '@/features/auth';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockUseLocalSearchParams = jest.fn(() => ({}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useLocalSearchParams: () => mockUseLocalSearchParams(),
}));

jest.mock('@/features/auth', () => ({
  isValidEmail: jest.fn((email: string) => /@/.test(email)),
  signUp: jest.fn(),
}));

jest.mock('@/lib/pending-return-to', () => ({
  setPendingReturnTo: jest.fn().mockResolvedValue(undefined),
  clearPendingReturnTo: jest.fn().mockResolvedValue(undefined),
  getPendingReturnTo: jest.fn().mockResolvedValue(null),
}));

const mockedSignUp = signUp as jest.Mock;
const mockSetPending = pendingReturnTo.setPendingReturnTo as jest.Mock;
const mockClearPending = pendingReturnTo.clearPendingReturnTo as jest.Mock;

describe('SignUpScreen — returnTo handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalSearchParams.mockReturnValue({});
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    (Alert.alert as jest.Mock).mockRestore?.();
  });

  it('persists returnTo via pendingReturnTo before calling signUp', async () => {
    mockUseLocalSearchParams.mockReturnValue({ returnTo: '/product/0000000000001' });
    mockedSignUp.mockResolvedValue({ data: { session: null }, error: null });

    const { getByPlaceholderText, getByText } = render(<SignUpScreen />);
    fireEvent.changeText(getByPlaceholderText('Email'), 'a@b.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'secret');

    // Use async act() so the full signUpWithEmail chain (including the
    // await setPendingReturnTo → await signUp sequence) completes before
    // we assert. A sync fireEvent.press + waitFor races with microtask
    // resolution in CI environments and causes intermittent 5s timeouts.
    await act(async () => {
      fireEvent.press(getByText('Sign Up'));
    });

    // Order: persist returnTo, THEN call signUp.
    expect(mockSetPending).toHaveBeenCalledWith('/product/0000000000001');
    const setOrder = mockSetPending.mock.invocationCallOrder[0];
    const signUpOrder = mockedSignUp.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(signUpOrder);
    expect(mockedSignUp).toHaveBeenCalled();
  });

  it('does not persist anything when no returnTo is present', async () => {
    mockedSignUp.mockResolvedValue({ data: { session: null }, error: null });

    const { getByPlaceholderText, getByText } = render(<SignUpScreen />);
    fireEvent.changeText(getByPlaceholderText('Email'), 'a@b.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'secret');
    fireEvent.press(getByText('Sign Up'));

    await waitFor(() => expect(mockedSignUp).toHaveBeenCalled());
    expect(mockSetPending).not.toHaveBeenCalled();
    expect(mockClearPending).not.toHaveBeenCalled();
  });

  it('clears pendingReturnTo when the signUp call fails', async () => {
    mockUseLocalSearchParams.mockReturnValue({ returnTo: '/product/999' });
    mockedSignUp.mockResolvedValue({
      data: { session: null },
      error: { message: 'weak password' },
    });

    const { getByPlaceholderText, getByText } = render(<SignUpScreen />);
    fireEvent.changeText(getByPlaceholderText('Email'), 'a@b.com');
    fireEvent.changeText(getByPlaceholderText('Password'), '123');
    fireEvent.press(getByText('Sign Up'));

    await waitFor(() => expect(mockClearPending).toHaveBeenCalled());
    expect(Alert.alert).toHaveBeenCalledWith('Sign up failed', 'weak password');
  });

  it('navigates to verify-email when signUp succeeds without an immediate session', async () => {
    mockedSignUp.mockResolvedValue({ data: { session: null }, error: null });

    const { getByPlaceholderText, getByText } = render(<SignUpScreen />);
    fireEvent.changeText(getByPlaceholderText('Email'), 'a@b.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'secret');
    fireEvent.press(getByText('Sign Up'));

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/(auth)/verify-email',
        params: { email: 'a@b.com' },
      }),
    );
  });
});
