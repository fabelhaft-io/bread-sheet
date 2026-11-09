import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import ProfileScreen from './profile';

/**
 * TICKET-P6-003 — "Manage Categories" is reachable from the profile tab for
 * both registered and anonymous users, since categories are `requireAuth`
 * only (not `requireRegistered`).
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockUseSession = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('@/features/auth', () => ({
  signOut: jest.fn().mockResolvedValue({ error: null }),
}));

describe('ProfileScreen — Manage Categories entry point (TICKET-P6-003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes to the manage-categories screen for a registered user', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', email: 'a@b.com', is_anonymous: false } },
      isAnonymous: false,
    });
    const { findByText } = await render(<ProfileScreen />);
    await fireEvent.press(await findByText('Manage Categories'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/manage-categories');
  });

  it('is also offered to an anonymous (guest) user', async () => {
    mockUseSession.mockReturnValue({
      session: { user: { id: 'guest', is_anonymous: true } },
      isAnonymous: true,
    });
    const { findByText } = await render(<ProfileScreen />);
    await fireEvent.press(await findByText('Manage Categories'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/manage-categories');
  });
});
