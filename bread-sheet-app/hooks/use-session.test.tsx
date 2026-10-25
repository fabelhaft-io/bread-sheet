import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { SessionProvider, useSession } from './use-session';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(),
    },
  },
}));

jest.mock('@/lib/api', () => ({
  api: { post: jest.fn().mockResolvedValue({}) },
}));

const mockGetSession = supabase.auth.getSession as jest.Mock;
const mockOnAuthStateChange = supabase.auth.onAuthStateChange as jest.Mock;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SessionProvider>{children}</SessionProvider>
);

describe('useSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: jest.fn() } },
    });
  });

  it('starts in loading state with a null session', async () => {
    // getSession never resolves — simulates the loading window
    mockGetSession.mockReturnValue(new Promise(() => {}));
    const { result } = await renderHook(() => useSession(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.session).toBeNull();
  });

  it('resolves to null session and isLoading=false when not signed in', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.isAnonymous).toBe(false);
  });

  it('exposes the session and marks isAnonymous=true for a guest user', async () => {
    const session = {
      access_token: 'anon-tok',
      user: { id: 'u1', is_anonymous: true },
    };
    mockGetSession.mockResolvedValue({ data: { session } });
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.session).toEqual(session);
    expect(result.current.isAnonymous).toBe(true);
  });

  it('exposes the session and marks isAnonymous=false for a registered user', async () => {
    const session = {
      access_token: 'tok',
      user: { id: 'u2', is_anonymous: false },
    };
    mockGetSession.mockResolvedValue({ data: { session } });
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAnonymous).toBe(false);
  });

  it('updates session when onAuthStateChange fires with a new session', async () => {
    let authCallback: (event: string, session: any) => void = () => {};
    mockOnAuthStateChange.mockImplementation((cb: any) => {
      authCallback = cb;
      return { data: { subscription: { unsubscribe: jest.fn() } } };
    });
    mockGetSession.mockResolvedValue({ data: { session: null } });

    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.session).toBeNull();

    const newSession = { access_token: 'tok', user: { id: 'u1', is_anonymous: false } };
    await act(() => authCallback('SIGNED_IN', newSession));

    await waitFor(() => expect(result.current.session).toEqual(newSession));
    expect(result.current.isAnonymous).toBe(false);
  });

  it('unsubscribes from auth state changes on unmount', async () => {
    const unsubscribe = jest.fn();
    mockOnAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const { unmount } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => {}); // let effects settle
    await unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
