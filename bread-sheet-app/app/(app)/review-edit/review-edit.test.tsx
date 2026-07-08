import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import ReviewEditScreen from './[editId]';

// ─── Shared mocks ────────────────────────────────────────────────────────────

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};
const mockUseLocalSearchParams = jest.fn(() => ({
  editId: 'edit-1',
  barcode: '0000000000001',
}));
const mockUseSession = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockUseLocalSearchParams(),
}));

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

// The screen pulls in @/lib/format-error → @/lib/api → @/lib/supabase; mock the
// api module so the Supabase client (which needs env vars) is never constructed.
jest.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  };
});

jest.mock('@/features/products/api', () => ({
  getPendingEdit: jest.fn(),
  voteOnProductEdit: jest.fn(),
  dismissProductEdit: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const productsApi = require('@/features/products/api');
const mockGetPendingEdit = productsApi.getPendingEdit as jest.Mock;
const mockVote = productsApi.voteOnProductEdit as jest.Mock;
const mockDismiss = productsApi.dismissProductEdit as jest.Mock;

const PENDING_EDIT = {
  editId: 'edit-1',
  barcode: '0000000000001',
  originalValues: {
    name: 'Sourdough Loaf',
    brand: 'Artisan',
    salt: 1.2,
  },
  proposedChanges: {
    name: 'Sourdough Boule',
  },
  approvals: 1,
  rejections: 0,
  createdAt: '2026-07-01T00:00:00Z',
  viewer: { isAuthor: false, vote: null, dismissed: false },
};

function signIn(anonymous = false) {
  mockUseSession.mockReturnValue({
    session: { user: { id: 'u1', is_anonymous: anonymous } },
    isAnonymous: anonymous,
    isLoading: false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  signIn();
  mockGetPendingEdit.mockResolvedValue({ edit: PENDING_EDIT });
});

describe('ReviewEditScreen — diff rendering', () => {
  it('shows old vs new for every changed field', async () => {
    const { findByTestId, findByText } = render(<ReviewEditScreen />);
    await findByTestId('diff-name');
    await findByText('Sourdough Loaf'); // original, struck through
    await findByText('Sourdough Boule'); // proposed
  });

  it('shows the vote tally', async () => {
    const { findByTestId } = render(<ReviewEditScreen />);
    const tally = await findByTestId('vote-tally');
    expect(tally.props.children.join('')).toContain('1 of 2 approvals needed');
  });

  it('collapses unchanged fields behind a toggle', async () => {
    const { findByTestId, queryByTestId } = render(<ReviewEditScreen />);
    await findByTestId('diff-name');
    expect(queryByTestId('unchanged-brand')).toBeNull();
    fireEvent.press(await findByTestId('toggle-unchanged'));
    await findByTestId('unchanged-brand');
    await findByTestId('unchanged-salt');
  });

  it('errors when the edit is no longer pending (stale deep link)', async () => {
    mockGetPendingEdit.mockResolvedValue({ edit: null });
    const { findByText } = render(<ReviewEditScreen />);
    await findByText(/no longer under review/i);
  });
});

describe('ReviewEditScreen — actions', () => {
  it('"Looks correct" casts an APPROVE vote and returns to the product', async () => {
    mockVote.mockResolvedValue({ approvals: 2, rejections: 0, status: 'APPLIED' });
    const { findByTestId } = render(<ReviewEditScreen />);
    fireEvent.press(await findByTestId('edit-approve'));
    await waitFor(() => expect(mockVote).toHaveBeenCalledWith('edit-1', 'APPROVE'));
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/product/[barcode]',
      params: { barcode: '0000000000001' },
    });
  });

  it('"Something\'s wrong" casts a REJECT vote', async () => {
    mockVote.mockResolvedValue({ approvals: 1, rejections: 1, status: 'PENDING' });
    const { findByTestId } = render(<ReviewEditScreen />);
    fireEvent.press(await findByTestId('edit-reject'));
    await waitFor(() => expect(mockVote).toHaveBeenCalledWith('edit-1', 'REJECT'));
  });

  it('"Dismiss" records a server-side dismissal, not a vote', async () => {
    mockDismiss.mockResolvedValue({ dismissed: true });
    const { findByTestId } = render(<ReviewEditScreen />);
    fireEvent.press(await findByTestId('edit-dismiss'));
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith('edit-1'));
    expect(mockVote).not.toHaveBeenCalled();
  });

  it('hides the actions from the edit author', async () => {
    mockGetPendingEdit.mockResolvedValue({
      edit: { ...PENDING_EDIT, viewer: { isAuthor: true, vote: null, dismissed: false } },
    });
    const { findByTestId, queryByTestId } = render(<ReviewEditScreen />);
    await findByTestId('own-edit-note');
    expect(queryByTestId('edit-approve')).toBeNull();
    expect(queryByTestId('edit-reject')).toBeNull();
  });

  it('hides the actions after the viewer has voted', async () => {
    mockGetPendingEdit.mockResolvedValue({
      edit: { ...PENDING_EDIT, viewer: { isAuthor: false, vote: 'APPROVE', dismissed: false } },
    });
    const { findByTestId, queryByTestId } = render(<ReviewEditScreen />);
    await findByTestId('already-voted-note');
    expect(queryByTestId('edit-approve')).toBeNull();
  });
});

describe('ReviewEditScreen — access control', () => {
  it('gates anonymous users', async () => {
    signIn(true);
    const { findByTestId } = render(<ReviewEditScreen />);
    await findByTestId('review-edit-anon-gate');
    expect(mockGetPendingEdit).not.toHaveBeenCalled();
  });
});
