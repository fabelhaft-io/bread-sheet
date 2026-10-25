import { act, renderHook } from '@testing-library/react-native';
import { LayoutChangeEvent, PixelRatio } from 'react-native';

import {
  COMPACT_MAX_FONT_SCALE,
  COMPACT_MAX_OVERFLOW,
  COMPACT_RELEASE_SLACK,
  useFitToScreen,
} from './use-fit-to-screen';

const layoutEvent = (height: number) =>
  ({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } }) as LayoutChangeEvent;

/**
 * Drives one measurement cycle: the ScrollView reports its viewport height via
 * `onLayout` and its content height via `onContentSizeChange`.
 */
async function measure(
  result: { current: ReturnType<typeof useFitToScreen> },
  { viewport, content }: { viewport?: number; content?: number },
) {
  await act(() => {
    if (viewport !== undefined) result.current.scrollProps.onLayout(layoutEvent(viewport));
    if (content !== undefined) result.current.scrollProps.onContentSizeChange(390, content);
  });
}

describe('useFitToScreen', () => {
  let fontScaleSpy: jest.SpyInstance;

  beforeEach(() => {
    fontScaleSpy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
  });

  afterEach(() => {
    fontScaleSpy.mockRestore();
  });

  it('starts uncompacted before anything has been measured', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    expect(result.current.compact).toBe(false);
  });

  it('compacts when the content overflows by no more than the threshold', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 800 + COMPACT_MAX_OVERFLOW });
    expect(result.current.compact).toBe(true);
  });

  it('leaves a screen that overflows by more than the threshold alone', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 800 + COMPACT_MAX_OVERFLOW + 1 });
    expect(result.current.compact).toBe(false);
  });

  it('leaves a screen that already fits unchanged', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 760 });
    expect(result.current.compact).toBe(false);
  });

  it('treats an exactly-fitting screen as not overflowing', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 800 });
    expect(result.current.compact).toBe(false);
  });

  it('holds the latch when the compacted content reports that it now fits', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 820 });
    expect(result.current.compact).toBe(true);

    // This is the oscillation trap: compaction removed the 20 px overflow, so
    // the ScrollView now measures 780. Deciding from that would un-compact,
    // re-introduce the overflow, and flicker forever.
    await measure(result, { content: 780 });
    expect(result.current.compact).toBe(true);

    // Re-measuring the same compacted height must not flip it either.
    await measure(result, { content: 780 });
    expect(result.current.compact).toBe(true);
  });

  it('does not release when the relaxed content would fit by less than the slack', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 820 });
    expect(result.current.compact).toBe(true);

    // Viewport grows to 824: the relaxed content (820) fits, but only by 4 px —
    // less than COMPACT_RELEASE_SLACK, so the latch holds.
    await measure(result, { viewport: 820 + COMPACT_RELEASE_SLACK - 4 });
    expect(result.current.compact).toBe(true);
  });

  it('releases once the relaxed content fits with the full slack to spare', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 820 });
    expect(result.current.compact).toBe(true);

    await measure(result, { viewport: 820 + COMPACT_RELEASE_SLACK });
    expect(result.current.compact).toBe(false);
  });

  it('tracks content changes made while compacted against the relaxed baseline', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 820 });
    expect(result.current.compact).toBe(true);

    // First compacted measurement: 20 px of spacing was removed.
    await measure(result, { content: 800 });
    // A section collapses, taking 60 px with it. The relaxed baseline is now
    // 760 — a comfortable fit — so compaction is released.
    await measure(result, { content: 740 });
    expect(result.current.compact).toBe(false);
  });

  it('keeps compacting when content grows while compacted but still nearly fits', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 820 });
    await measure(result, { content: 800 });
    // +10 px of content: relaxed baseline is 830, still overflowing.
    await measure(result, { content: 810 });
    expect(result.current.compact).toBe(true);
  });

  it('skips compaction entirely above the maximum font scale', async () => {
    fontScaleSpy.mockReturnValue(COMPACT_MAX_FONT_SCALE + 0.1);
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 820 });
    expect(result.current.compact).toBe(false);
  });

  it('still compacts at exactly the maximum font scale', async () => {
    fontScaleSpy.mockReturnValue(COMPACT_MAX_FONT_SCALE);
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 820 });
    expect(result.current.compact).toBe(true);
  });

  it('releases compaction if the font scale is raised past the maximum', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    await measure(result, { viewport: 800, content: 820 });
    expect(result.current.compact).toBe(true);

    fontScaleSpy.mockReturnValue(COMPACT_MAX_FONT_SCALE + 0.1);
    await measure(result, { viewport: 799 });
    expect(result.current.compact).toBe(false);
  });

  it('re-evaluates on rotation: the same content may compact on one viewport and not another', async () => {
    const { result } = await renderHook(() => useFitToScreen());

    // Small viewport (e.g. iPhone SE): 20 px of overflow — compact.
    await measure(result, { viewport: 600, content: 620 });
    expect(result.current.compact).toBe(true);

    // Large viewport (e.g. Pixel 7 Pro): the same content fits comfortably.
    await measure(result, { viewport: 900 });
    expect(result.current.compact).toBe(false);
  });

  it('suppresses the rubber-band bounce on both platforms', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    expect(result.current.scrollProps.alwaysBounceVertical).toBe(false);
    expect(result.current.scrollProps.overScrollMode).toBe('never');
  });

  it('keeps the scroll props referentially stable across compaction flips', async () => {
    const { result } = await renderHook(() => useFitToScreen());
    const before = result.current.scrollProps;
    await measure(result, { viewport: 800, content: 820 });
    expect(result.current.compact).toBe(true);
    expect(result.current.scrollProps).toBe(before);
  });
});
