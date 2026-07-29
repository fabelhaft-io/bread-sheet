import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { PixelRatio, StyleSheet } from 'react-native';

import { SPACING_COMPACT } from '@/constants/spacing';

import HomeScreen from './index';
import ProfileScreen from './profile';

/**
 * Scroll-host behaviour for the two tab screens (P5-006 FE Fixes).
 *
 * Both are plain `ScrollView` hosts whose content routinely lands within a few
 * pixels of the viewport. They must not rubber-band on that marginal overflow.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockUseSession = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/hooks/use-session', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Must be stable across renders — a fresh object would re-trigger the fetch
// effect in HomeScreen on every render.
jest.mock('@/hooks/use-recent-products', () => {
  const value = { addRecentProduct: jest.fn(), recentProducts: [] as unknown[] };
  return { useRecentProducts: () => value };
});

jest.mock('@/lib/api');

jest.mock('@/features/auth', () => ({
  signOut: jest.fn().mockResolvedValue({ error: null }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { api } = require('@/lib/api');

describe('Tab screens — scroll host (P5-006)', () => {
  let fontScaleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // jest-expo's default window reports fontScale: 2, which the hook (correctly)
    // reads as "the user asked for large text" and skips compaction. Pin it to
    // the normal scale so these tests exercise the compaction path.
    fontScaleSpy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
    mockUseSession.mockReturnValue({
      session: { user: { id: 'u1', email: 'a@b.test', is_anonymous: false } },
      isAnonymous: false,
      isLoading: false,
    });
    api.get.mockResolvedValue([]);
  });

  afterEach(() => {
    fontScaleSpy.mockRestore();
  });

  it('suppresses the rubber-band bounce on the home screen', async () => {
    const { getByTestId } = render(<HomeScreen />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const scroll = getByTestId('home-screen');
    expect(scroll.props.alwaysBounceVertical).toBe(false);
    expect(scroll.props.overScrollMode).toBe('never');
  });

  it('suppresses the rubber-band bounce on the profile screen', () => {
    const { getByTestId } = render(<ProfileScreen />);
    const scroll = getByTestId('profile-screen');
    expect(scroll.props.alwaysBounceVertical).toBe(false);
    expect(scroll.props.overScrollMode).toBe('never');
  });

  it('tightens the profile card only once a marginal overflow is measured', () => {
    const { getByTestId } = render(<ProfileScreen />);
    const card = () => StyleSheet.flatten(getByTestId('profile-account-card').props.style);

    // Nothing measured yet — the screen renders with its relaxed spacing.
    expect(card().marginTop).toBe(20);
    expect(card().paddingVertical).toBeUndefined();

    const scroll = getByTestId('profile-screen');
    act(() => {
      scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 800 } } });
      scroll.props.onContentSizeChange(390, 820);
    });

    // 20 px of overflow — inside the threshold, so the card compacts. Its
    // horizontal margin is untouched; only vertical spacing moves.
    expect(card().marginTop).toBe(SPACING_COMPACT.sectionPaddingV);
    expect(card().paddingVertical).toBe(SPACING_COMPACT.cardPaddingV);
    expect(card().marginHorizontal).toBe(16);
  });

  it('leaves the profile screen untouched when the content overflows well past the threshold', () => {
    const { getByTestId } = render(<ProfileScreen />);
    const scroll = getByTestId('profile-screen');
    act(() => {
      scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 800 } } });
      scroll.props.onContentSizeChange(390, 1400);
    });

    const card = StyleSheet.flatten(getByTestId('profile-account-card').props.style);
    expect(card.marginTop).toBe(20);
    expect(card.paddingVertical).toBeUndefined();
  });
});
