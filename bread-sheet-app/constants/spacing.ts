/**
 * Vertical spacing tokens for the "eliminate marginal scroll" compaction
 * (TICKET-P5-006 FE Fixes).
 *
 * `SPACING` documents the relaxed baseline the screens use by default;
 * `SPACING_COMPACT` is its tightened counterpart, applied only when
 * `useFitToScreen()` reports `compact` — i.e. when a screen overflows the
 * viewport by a barely-perceptible amount.
 *
 * Screens keep their own (relaxed) `StyleSheet` untouched and add a single
 * `compactStyles` sheet built from `SPACING_COMPACT`. That keeps the
 * uncompacted rendering byte-for-byte identical and confines the compaction to
 * one reviewable block per screen instead of conditionals sprinkled through
 * the stylesheet.
 *
 * Two rules constrain what may live here:
 *  - Only margins, padding and gaps. Never font sizes, never fixed heights of
 *    interactive elements.
 *  - Never the internal padding of a pressable. Tightening a container is
 *    free; tightening a button's own padding is what drives a touch target
 *    below the 44x44 minimum. Compact overrides adjust the *margin* around
 *    controls, not the padding inside them.
 */

export type SpacingTokens = {
  /** `contentContainerStyle` bottom padding of a screen-level ScrollView. */
  screenBottom: number;
  /** Vertical padding inside a content section. */
  sectionPaddingV: number;
  /** Gap between the items of a content section. */
  sectionGap: number;
  /** Gap inside a dense pairing (field label + input, old value + new value). */
  tightGap: number;
  /** Margin between two major blocks. */
  blockGap: number;
  /** Margin separating a primary control from the content above it. */
  controlGap: number;
  /** Vertical padding inside a card or banner. */
  cardPaddingV: number;
};

export const SPACING: SpacingTokens = {
  screenBottom: 60,
  sectionPaddingV: 20,
  sectionGap: 12,
  tightGap: 6,
  blockGap: 12,
  controlGap: 20,
  cardPaddingV: 16,
};

export const SPACING_COMPACT: SpacingTokens = {
  screenBottom: 16,
  sectionPaddingV: 12,
  sectionGap: 8,
  tightGap: 4,
  blockGap: 8,
  controlGap: 10,
  cardPaddingV: 10,
};
