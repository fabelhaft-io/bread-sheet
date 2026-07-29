import { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, PixelRatio, ScrollViewProps } from 'react-native';

/**
 * Overflow (content height − viewport height, in px) at or below which a
 * screen is considered to "nearly fit" and is worth compacting. Above this the
 * screen genuinely has more content than fits and must scroll normally.
 */
export const COMPACT_MAX_OVERFLOW = 32;

/**
 * Slack required before compaction is released. The relaxed content must fit
 * with at least this much room to spare, so a screen sitting exactly on the
 * boundary does not toggle back and forth.
 */
export const COMPACT_RELEASE_SLACK = 8;

/**
 * OS font scale above which compaction is skipped entirely. A user who has
 * asked for large text is better served by scrolling than by cramped content.
 *
 * Note: `PixelRatio.getFontScale()` falls back to the *pixel density* when the
 * window has no `fontScale` — which never happens on a device but does under
 * jest-expo (density 2), so tests that exercise compaction must stub it.
 */
export const COMPACT_MAX_FONT_SCALE = 1.3;

export type FitToScreenScrollProps = Required<
  Pick<ScrollViewProps, 'onLayout' | 'onContentSizeChange' | 'alwaysBounceVertical' | 'overScrollMode'>
>;

export type FitToScreen = {
  /** True while the screen's spacing should be tightened. */
  compact: boolean;
  /** Spread onto the screen's `ScrollView`. */
  scrollProps: FitToScreenScrollProps;
};

/**
 * Measures a screen-level `ScrollView` and reports whether its vertical
 * spacing should be tightened so the content fits without scrolling.
 *
 * ## The latch
 *
 * Compacting removes the overflow, so a naive implementation reads "it fits
 * now", un-compacts, re-introduces the overflow, and flickers forever. This
 * hook therefore never decides from a *compacted* measurement. It tracks the
 * content height as it measures **uncompacted** (`relaxedContentRef`) and
 * compares that against the viewport in both directions:
 *
 *  - not compact → compact when `0 < relaxed − viewport <= COMPACT_MAX_OVERFLOW`
 *  - compact → release only when `relaxed + COMPACT_RELEASE_SLACK <= viewport`
 *
 * While compacted the relaxed height cannot be observed directly, so changes
 * to the compacted height (a section appears, text rewraps, the device
 * rotates) are carried over to the baseline as a delta. Spacing savings are
 * constant, so the two heights move together.
 */
export function useFitToScreen(): FitToScreen {
  const [compact, setCompact] = useState(false);

  // Mirrors `compact` so the measurement callbacks can read the current value
  // without being re-created (and re-registered on the ScrollView) each flip.
  const compactRef = useRef(false);
  const viewportRef = useRef(0);
  const relaxedContentRef = useRef<number | null>(null);
  const compactContentRef = useRef<number | null>(null);

  const evaluate = useCallback(() => {
    const viewport = viewportRef.current;
    const relaxed = relaxedContentRef.current;
    if (viewport <= 0 || relaxed == null) return;

    let next: boolean;
    if (PixelRatio.getFontScale() > COMPACT_MAX_FONT_SCALE) {
      next = false;
    } else if (compactRef.current) {
      next = relaxed + COMPACT_RELEASE_SLACK > viewport;
    } else {
      const overflow = relaxed - viewport;
      next = overflow > 0 && overflow <= COMPACT_MAX_OVERFLOW;
    }

    if (next === compactRef.current) return;
    compactRef.current = next;
    // The next content measurement belongs to the other mode; start a fresh
    // delta chain rather than diffing across the transition.
    compactContentRef.current = null;
    setCompact(next);
  }, []);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (height === viewportRef.current) return;
      viewportRef.current = height;
      evaluate();
    },
    [evaluate],
  );

  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      if (compactRef.current) {
        const previous = compactContentRef.current;
        if (previous != null && relaxedContentRef.current != null) {
          relaxedContentRef.current += height - previous;
        }
        compactContentRef.current = height;
      } else {
        relaxedContentRef.current = height;
      }
      evaluate();
    },
    [evaluate],
  );

  const scrollProps = useMemo<FitToScreenScrollProps>(
    () => ({
      onLayout,
      onContentSizeChange,
      // A barely-overflowing screen should not rubber-band; that bounce is a
      // large part of what makes marginal scroll feel broken. `overScrollMode`
      // is the Android equivalent and a no-op elsewhere.
      alwaysBounceVertical: false,
      overScrollMode: 'never',
    }),
    [onLayout, onContentSizeChange],
  );

  return { compact, scrollProps };
}
