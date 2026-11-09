import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { CategoryPickerSheet, type PickerActionResult } from '@/components/category-picker-sheet';
import { SPACING_COMPACT } from '@/constants/spacing';
import { Colors } from '@/constants/theme';
import { ApiError, NetworkError, api } from '@/lib/api';
import { formatApiError } from '@/lib/format-error';
import { upsertCachedRating, productCache } from '@/lib/offline/caches';
import { useCachedResource } from '@/hooks/use-cached-resource';
import { useFitToScreen } from '@/hooks/use-fit-to-screen';
import { useMyCategories } from '@/hooks/use-my-categories';
import { useMyRating } from '@/hooks/use-my-rating';
import { useOutbox } from '@/hooks/use-outbox';
import { useRecentProducts } from '@/hooks/use-recent-products';
import { useSession } from '@/hooks/use-session';
import { createCategory } from '@/features/categories/api';
import { buildRatingCategoryFields, mapSuggestion, type CategorySelection } from '@/features/categories/picker';
import type { CategorySeed } from '@/features/categories/seeds';
import type { UserCategory, RatingCategory } from '@/features/categories/types';
import { getPendingEdit } from '@/features/products/api';
import type { PendingEdit, ProductDetail } from '@/features/products/types';
import type { RatingEntry } from '@/features/ratings/types';

type Product = ProductDetail;

// ─── Taste Score Colour ───────────────────────────────────────────────────────
// Interpolates amber → green as score rises 0 → 10
function scoreColor(score: number): string {
  const t = score / 10; // 0..1
  if (t < 0.5) {
    // amber (#f5a623) → yellow (#f0d060)
    const r = Math.round(245 + (240 - 245) * (t / 0.5));
    const g = Math.round(166 + (208 - 166) * (t / 0.5));
    const b = Math.round(35 + (96 - 35) * (t / 0.5));
    return `rgb(${r},${g},${b})`;
  } else {
    // yellow → green (#4caf50)
    const u = (t - 0.5) / 0.5;
    const r = Math.round(240 + (76 - 240) * u);
    const g = Math.round(208 + (175 - 208) * u);
    const b = Math.round(96 + (80 - 96) * u);
    return `rgb(${r},${g},${b})`;
  }
}

// ─── TasteSlider ──────────────────────────────────────────────────────────────
//
// UX design:
//   • Large score badge front and centre
//   • Horizontal draggable track (snaps to 0.5) — tap anywhere to jump
//   • –0.5 / +0.5 stepper buttons for fine control
//   • Filled track colour transitions amber → green
//   • Tick marks at whole numbers
//
// Gesture implementation uses react-native-gesture-handler so the iOS back
// swipe and the vertical ScrollView are disambiguated at the native level
// (failOffsetY / activeOffsetX), eliminating the race that PanResponder lost.
//
function TasteSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const TRACK_WIDTH = 280;
  const MIN = 0;
  const MAX = 10;
  const STEP = 0.5;

  // Thumb pixel position drives both the fill width and thumb left offset.
  const thumbX = useSharedValue((value / MAX) * TRACK_WIDTH);
  // Captured at gesture start so onUpdate can add translationX to the
  // original position rather than accumulating deltas frame-by-frame.
  const startThumbX = useSharedValue(0);

  // Keep thumb in sync when value changes from the stepper buttons.
  // The 0.5 px guard skips redundant springs while the user is dragging
  // (drag already positions thumbX; the onChange → re-render → effect cycle
  // would otherwise fire a spring to the exact position it's already at).
  useEffect(() => {
    const target = (value / MAX) * TRACK_WIDTH;
    if (Math.abs(thumbX.value - target) > 0.5) {
      thumbX.value = withSpring(target, { damping: 15, stiffness: 180 });
    }
  }, [value, thumbX]);

  const snap = (raw: number) => {
    const clamped = Math.max(MIN, Math.min(MAX, raw));
    return Math.round(clamped / STEP) * STEP;
  };

  const step = (dir: 1 | -1) => {
    onChange(snap(value + dir * STEP));
  };

  // Pan: only activates after clearly horizontal movement; fails on vertical
  // movement so the ScrollView and iOS back gesture win those races.
  const panGesture = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-8, 8])
    .onBegin(() => {
      startThumbX.value = thumbX.value;
    })
    .onUpdate((e) => {
      const px = Math.max(0, Math.min(TRACK_WIDTH, startThumbX.value + e.translationX));
      // Writing a Reanimated shared value inside a worklet is the intended API;
      // react-hooks/immutability doesn't model shared values and false-positives here.
      // eslint-disable-next-line react-hooks/immutability
      thumbX.value = px;
      const snapped = Math.round(Math.max(MIN, Math.min(MAX, (px / TRACK_WIDTH) * MAX)) / STEP) * STEP;
      scheduleOnRN(onChange, snapped);
    });

  // Tap: jumps to the tapped position with a snappy spring.
  const tapGesture = Gesture.Tap()
    .onEnd((e) => {
      const px = Math.max(0, Math.min(TRACK_WIDTH, e.x));
      // eslint-disable-next-line react-hooks/immutability -- Reanimated shared-value write in a worklet
      thumbX.value = withSpring(px, { damping: 25, stiffness: 300 });
      const snapped = Math.round(Math.max(MIN, Math.min(MAX, (px / TRACK_WIDTH) * MAX)) / STEP) * STEP;
      scheduleOnRN(onChange, snapped);
    });

  // Race: the first to activate wins — pan for drags, tap for short presses.
  const gesture = Gesture.Race(panGesture, tapGesture);

  const fillStyle = useAnimatedStyle(() => ({ width: thumbX.value }));
  const thumbStyle = useAnimatedStyle(() => ({ left: thumbX.value }));

  const color = scoreColor(value);

  return (
    <View style={sliderStyles.container}>
      {/* Score badge */}
      <View style={[sliderStyles.badge, { borderColor: color }]}>
        <Text style={[sliderStyles.scoreText, { color }]}>
          {value % 1 === 0 ? value.toFixed(1) : value.toString()}
        </Text>
        <Text style={sliderStyles.outOfText}>/10</Text>
      </View>

      {/* Stepper row */}
      <View style={sliderStyles.stepperRow}>
        <TouchableOpacity
          style={[sliderStyles.stepBtn, value <= MIN && sliderStyles.stepBtnDisabled]}
          onPress={() => step(-1)}
          disabled={value <= MIN}
          hitSlop={12}
        >
          <Text style={[sliderStyles.stepBtnText, value <= MIN && sliderStyles.stepBtnTextDisabled]}>−</Text>
        </TouchableOpacity>

        {/* Track — wrapped in a taller hit-area view so the thumb's visual
            overflow is also touchable (track itself is only 8 px tall). */}
        <GestureDetector gesture={gesture}>
          <View style={sliderStyles.trackHitArea}>
            <View style={sliderStyles.track}>
              {/* Fill */}
              <Animated.View
                pointerEvents="none"
                style={[sliderStyles.trackFill, fillStyle, { backgroundColor: color }]}
              />
              {/* Tick marks at whole numbers */}
              {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                <View
                  key={n}
                  style={[
                    sliderStyles.tick,
                    { left: (n / MAX) * TRACK_WIDTH - 1 },
                    n <= value && sliderStyles.tickFilled,
                  ]}
                />
              ))}
              {/* Thumb */}
              <Animated.View
                pointerEvents="none"
                style={[sliderStyles.thumb, thumbStyle, { backgroundColor: color }]}
              />
            </View>
          </View>
        </GestureDetector>

        <TouchableOpacity
          style={[sliderStyles.stepBtn, value >= MAX && sliderStyles.stepBtnDisabled]}
          onPress={() => step(1)}
          disabled={value >= MAX}
          hitSlop={12}
        >
          <Text style={[sliderStyles.stepBtnText, value >= MAX && sliderStyles.stepBtnTextDisabled]}>+</Text>
        </TouchableOpacity>
      </View>

      {/* Scale labels */}
      <View style={sliderStyles.labelsRow}>
        <Text style={sliderStyles.labelText}>0</Text>
        <Text style={sliderStyles.labelText}>5</Text>
        <Text style={sliderStyles.labelText}>10</Text>
      </View>
    </View>
  );
}

const THUMB_SIZE = 24;
const TRACK_HEIGHT = 8;

const sliderStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 20,
    paddingVertical: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 3,
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
    gap: 4,
  },
  scoreText: {
    fontSize: 52,
    fontWeight: '800',
    lineHeight: 56,
    letterSpacing: -1,
  },
  outOfText: {
    fontSize: 18,
    fontWeight: '500',
    color: '#999',
    marginBottom: 8,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0ece4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnDisabled: {
    opacity: 0.35,
  },
  stepBtnText: {
    fontSize: 24,
    fontWeight: '600',
    color: '#555',
    lineHeight: 28,
  },
  stepBtnTextDisabled: {
    color: '#aaa',
  },
  // Taller transparent wrapper so the thumb's visual overflow is touchable.
  // The track itself is only 8 px tall, which is too narrow to tap reliably.
  trackHitArea: {
    width: 280,
    height: THUMB_SIZE + 20,
    justifyContent: 'center',
    overflow: 'visible',
  },
  track: {
    width: 280,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: '#e0ddd8',
    justifyContent: 'center',
    overflow: 'visible',
  },
  trackFill: {
    position: 'absolute',
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    left: 0,
  },
  tick: {
    position: 'absolute',
    width: 2,
    height: TRACK_HEIGHT + 4,
    borderRadius: 1,
    backgroundColor: '#c8c4bc',
    top: -2,
  },
  tickFilled: {
    backgroundColor: 'rgba(255,255,255,0.6)',
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    marginLeft: -(THUMB_SIZE / 2),
    top: -(THUMB_SIZE - TRACK_HEIGHT) / 2,
    elevation: 4,
    ...Platform.select({
      web: { boxShadow: '0px 2px 4px rgba(0,0,0,0.18)' },
      default: {
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 4,
      },
    }),
  },
  labelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: 280,
    marginTop: -8,
  },
  labelText: {
    fontSize: 12,
    color: '#aaa',
    fontWeight: '500',
  },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────

/**
 * TICKET-P6-009: identity is `Product.id`. The code-shaped states (invalid
 * barcode, not-found-by-gtin, offline-with-nothing-cached) moved to the
 * `product/gtin/[gtin]` resolver, which always redirects here with an id once
 * it has one — this screen only ever renders found / id-not-found / generic
 * error / the success card.
 */
export default function ProductScreen() {
  const { id, focusRating } = useLocalSearchParams<{ id: string; focusRating?: string }>();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const router = useRouter();

  const { addRecentProduct } = useRecentProducts();
  const { isAnonymous, session } = useSession();
  const { enqueue, isQueued } = useOutbox();
  const userId = session?.user.id ?? null;

  const { compact, scrollProps } = useFitToScreen();

  const fetchProduct = useCallback(() => api.get<Product>(`/api/products/${id}`), [id]);

  // Product: painted from the on-disk cache first, revalidated in the
  // background (P8-002). `error` only ever holds an HTTP failure — a request
  // that never reached the server surfaces as `isOffline` instead, which is
  // what keeps "no signal" from being rendered as "product not found".
  const {
    data: product,
    isLoading: loading,
    isOffline,
    error: loadError,
    refresh: refreshProduct,
  } = useCachedResource<Product>({
    key: `product:${id}`,
    cache: productCache(id),
    fetcher: fetchProduct,
  });

  // A product that genuinely no longer exists (rejected, or an id that never
  // existed). Unlike the gtin resolver's not-found state there is no gtin to
  // offer "add this product" against — an id is opaque.
  const notFound = loadError instanceof ApiError && loadError.status === 404;

  // Pending edit on a VERIFIED product (P5-006). Drives both the "review this
  // change" banner and the hide-edit-button-with-notice state.
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  const { rating: existingRating, applyLocalRating } = useMyRating(userId, id);

  const [taste, setTaste] = useState(5);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // Captured at submit time: applying the new rating locally would otherwise
  // make a first-time submission report itself as an update.
  const [submittedAsUpdate, setSubmittedAsUpdate] = useState(false);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [imageError, setImageError] = useState(false);

  // TICKET-P6-007: creating a custom product lands here with `?focusRating=1`
  // — the reason someone adds a cocktail is to rate it, so the rating control
  // should be ready to use immediately rather than making them navigate again.
  // Consumed once per arrival, mirroring the P9-003 scan-injection and the
  // P6-008 `focusSearch` hand-off patterns, so re-focusing this screen later
  // doesn't re-trigger it. The decision is latched into state rather than
  // re-derived from `focusRating` on every render: the product itself loads
  // asynchronously, and `router.setParams` clearing the param can easily land
  // before the comment field has even mounted for the first time — at which
  // point a render that just re-reads `focusRating` would see it already gone.
  const [autoFocusRatingComment, setAutoFocusRatingComment] = useState(false);
  const consumedFocusRating = useRef<string | null>(null);
  useEffect(() => {
    if (typeof focusRating !== 'string' || focusRating.length === 0) {
      consumedFocusRating.current = null;
      return;
    }
    if (consumedFocusRating.current === focusRating) return;
    consumedFocusRating.current = focusRating;
    setAutoFocusRatingComment(true);
    router.setParams({ focusRating: undefined });
  }, [focusRating, router]);

  // Pre-fill from the cached rating. Anonymous sessions are included (P8-003):
  // their ratings are stored server-side under their anonymous user id, and now
  // that the session survives a restart it is the same id tomorrow.
  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!existingRating || prefilledFor.current === existingRating.id) return;
    prefilledFor.current = existingRating.id;
    setTaste(existingRating.taste);
    setComment(existingRating.comment ?? '');
  }, [existingRating]);

  // ─── Category (TICKET-P6-003) ───────────────────────────────────────────
  // A category is the user's own label for this rating, never the machine
  // suggestion (`product.suggestedCategory`) shown as fact. `categories`
  // backs both the suggestion-mapping below and the picker's own-list
  // section; it is stale-while-revalidate over the same on-disk cache the
  // Manage Categories screen reads, so a rename/merge made there shows up
  // here without extra plumbing.
  const { categories: myCategories, refresh: refreshCategories } = useMyCategories(userId);

  const [categorySelection, setCategorySelection] = useState<CategorySelection | null>(null);
  // True once the user has made an explicit choice this session (selecting,
  // creating, or clearing). Drives whether a rating write sends a category
  // field at all — per the backend contract, omitting it leaves an existing
  // rating's category unchanged, while an untouched *new* rating simply has
  // none (see `buildRatingCategoryFields`).
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);
  const [categoryActionError, setCategoryActionError] = useState<string | null>(null);

  // Maps `product.suggestedCategory` onto the user's own list: an existing
  // own category with that slug wins outright; otherwise, if the slug is a
  // known seed, it is offered unmaterialised (a one-tap create).
  const suggestion = useMemo(
    () => mapSuggestion(product?.suggestedCategory, myCategories),
    [product?.suggestedCategory, myCategories],
  );

  // Until the user touches the category control, `categorySelection` tracks
  // the best known default: the rating's own existing category takes
  // priority (re-opening a rating you already organised should not be
  // second-guessed by a suggestion) and is NOT marked touched — omitting
  // the field on submit if nothing changes is correct and avoids a needless
  // write. Otherwise, an `existing`-kind suggestion (an own category already
  // materialised under that slug) both pre-selects *and* is marked touched
  // immediately: the AC is that this pre-selection is already applied, not
  // merely visible, so it must be sent even with no further tap. A
  // `seed`-kind suggestion deliberately does neither here — it stays
  // offered, unselected, rendered by the category row directly from
  // `suggestion` — selecting it is the one tap that is allowed to
  // materialise a row (see `handleSelectSeedCategory`). Reactive rather than
  // "apply once" so a `categories` list that finishes loading after the
  // product (a cold cache miss) still gets to upgrade a seed-only
  // suggestion into the matching existing category once it arrives.
  /* eslint-disable react-hooks/set-state-in-effect -- synchronising display
     state with two external, asynchronously-arriving reads (the ratings
     cache and the categories cache), exactly like the pending-edit lookup
     above; not derivable during render. */
  useEffect(() => {
    if (categoryTouched) return;
    if (existingRating) {
      setCategorySelection(
        existingRating.category
          ? { kind: 'existing', id: existingRating.category.id, name: existingRating.category.name }
          : suggestion?.kind === 'existing'
            ? suggestion
            : null,
      );
      if (!existingRating.category && suggestion?.kind === 'existing') setCategoryTouched(true);
      return;
    }
    if (suggestion?.kind === 'existing') {
      setCategorySelection(suggestion);
      setCategoryTouched(true);
      return;
    }
    setCategorySelection(null);
  }, [existingRating, suggestion, categoryTouched]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const applyCategorySelection = useCallback((next: CategorySelection | null) => {
    setCategorySelection(next);
    setCategoryTouched(true);
    setCategoryActionError(null);
  }, []);

  const handleSelectExistingCategory = useCallback(
    (category: UserCategory) => {
      applyCategorySelection({ kind: 'existing', id: category.id, name: category.name });
    },
    [applyCategorySelection],
  );

  const handleClearCategory = useCallback(() => {
    applyCategorySelection(null);
  }, [applyCategorySelection]);

  // Tries to materialise the seed immediately (`POST /api/users/me/categories
  // { seedSlug }` — find-or-create, so this never duplicates). Offline, that
  // call cannot be made; the selection is still applied, carried as the seed
  // slug itself, and resolved server-side once the rating is actually sent
  // (`POST /api/ratings`'s own `seedSlug` field, or the outbox replaying it).
  const handleSelectSeedCategory = useCallback(
    async (seed: CategorySeed): Promise<PickerActionResult> => {
      try {
        const created = await createCategory({ seedSlug: seed.slug });
        applyCategorySelection({ kind: 'existing', id: created.id, name: created.name });
        void refreshCategories();
        return { ok: true };
      } catch (err) {
        if (err instanceof NetworkError) {
          applyCategorySelection({ kind: 'seed', slug: seed.slug, name: seed.name });
          return { ok: true };
        }
        return {
          ok: false,
          message: formatApiError(err, 'Could not add that category. Please try again.'),
        };
      }
    },
    [applyCategorySelection, refreshCategories],
  );

  // A brand-new custom name is online-only (TICKET-P6-003's offline scope is
  // explicitly the `categoryId`/`seedSlug` cases above, not an unmaterialised
  // free-text name) — a `NetworkError` here surfaces as a normal inline error.
  const handleCreateCategory = useCallback(
    async (name: string): Promise<PickerActionResult> => {
      try {
        const created = await createCategory({ name });
        applyCategorySelection({ kind: 'existing', id: created.id, name: created.name });
        void refreshCategories();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: formatApiError(err, 'Could not create that category. Please try again.'),
        };
      }
    },
    [applyCategorySelection, refreshCategories],
  );

  useEffect(() => {
    if (product) {
      addRecentProduct({
        id: product.id,
        name: product.name,
        brand: product.brand,
        image: product.image,
      });
    }
  }, [product, addRecentProduct]);

  // Pending-edit lookup (P5-006) — registered users on VERIFIED products only.
  // Failures (including being offline) degrade to "no pending edit"; the lookup
  // must never block the screen.
  useEffect(() => {
    if (!product || isAnonymous || product.status !== 'VERIFIED') {
      // Clearing a lookup result that no longer applies to the current product
      // is exactly the synchronisation an effect is for; the rule over-flags it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingEdit(null);
      return;
    }
    let cancelled = false;
    getPendingEdit(product.id)
      .then(({ edit }) => { if (!cancelled) setPendingEdit(edit); })
      .catch(() => { if (!cancelled) setPendingEdit(null); });
    return () => { cancelled = true; };
  }, [product, isAnonymous]);

  // Refresh on *re*-focus (e.g. returning from a peer review that changed the
  // status). The first focus is skipped — the cached-resource hook has already
  // kicked off that request.
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!focusedBefore.current) {
        focusedBefore.current = true;
      } else {
        void refreshProduct();
      }
      // Leaving retires the success card. It is a *state* of this screen, not a
      // route of its own, so without this a user who navigates away and comes
      // back to the same product is met by a stale "Rating Submitted!" instead
      // of the form — with no way to reach the form short of a cold start.
      return () => setSubmitted(false);
    }, [refreshProduct])
  );

  /**
   * Deliberate exit from the rating flow.
   *
   * `router.back()` is wrong here: the product screen sits on the root stack
   * above the tabs, so back drops the user wherever they entered from — after a
   * scan that is the camera, still pointed at the barcode they just rated,
   * which scans it again and returns them to this very screen. `navigate` pops
   * back to the tab navigator and lands on Home, where the new rating is listed.
   */
  const goHome = useCallback(() => {
    router.navigate('/(tabs)');
  }, [router]);

  const handleSubmit = useCallback(async () => {
    if (!product || submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    setSubmittedAsUpdate(existingRating !== null);
    const trimmed = comment.trim();
    // TICKET-P6-003: omitted entirely when the user never touched category
    // (leaves an existing rating's category unchanged, per the backend
    // contract); `categoryId: null` when they explicitly cleared it.
    const categoryFields = buildRatingCategoryFields(categorySelection, categoryTouched);
    try {
      const saved = await api.post<RatingEntry>('/api/ratings', {
        productId: product.id,
        taste,
        comment: trimmed || undefined,
        ...categoryFields,
      });
      if (saved?.product?.id) {
        await upsertCachedRating(saved);
        applyLocalRating(saved);
      }
      setQueuedOffline(false);
      setSubmitted(true);
    } catch (err: unknown) {
      if (err instanceof NetworkError) {
        // Ratings are the one write safe to queue: the endpoint upserts on
        // (user, product), so replay is idempotent and the local value is by
        // definition the user's latest intent (P8-004).
        //
        // The optimistic `category` only carries an id we already know about
        // (an existing own category, or whatever the rating already had);
        // a not-yet-materialised seed selection has no id to show yet and
        // reads as uncategorised locally until the outbox flush returns the
        // server's authoritative version.
        const optimisticCategory: RatingCategory | null = !categoryTouched
          ? existingRating?.category ?? null
          : categorySelection?.kind === 'existing'
            ? { id: categorySelection.id, name: categorySelection.name }
            : null;
        const optimistic: RatingEntry = {
          id: existingRating?.id ?? `local:${product.id}`,
          score: taste,
          taste,
          comment: trimmed || null,
          createdAt: new Date().toISOString(),
          product: {
            id: product.id,
            kind: product.kind,
            name: product.name,
            brand: product.brand,
            image: product.image,
          },
          category: optimisticCategory,
        };
        await enqueue({ productId: product.id, taste, comment: trimmed || null, ...categoryFields });
        await upsertCachedRating(optimistic);
        applyLocalRating(optimistic);
        setQueuedOffline(true);
        setSubmitted(true);
      } else {
        setSubmitError(formatApiError(err, 'Could not submit your rating. Please try again.'));
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    product,
    taste,
    comment,
    submitting,
    existingRating,
    enqueue,
    applyLocalRating,
    categorySelection,
    categoryTouched,
  ]);

  const isUpdate = existingRating !== null;
  const pendingSync = product ? isQueued(product.id) : false;

  if (loading || (!product && !notFound && !loadError && !isOffline)) {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator size="large" color={colors.tint} />
      </ThemedView>
    );
  }

  // Offline with nothing cached for this id. Rare by construction — the gtin
  // resolver is the usual entry point and only hands out an id once the
  // product has been written to this device's cache — but a direct deep link
  // to an id that was never cached here can still land in this state.
  if (!product && isOffline) {
    return (
      <ThemedView style={styles.center} testID="product-offline">
        <Text style={styles.successIcon}>📴</Text>
        <ThemedText type="title" style={styles.successTitle}>
          You&apos;re offline
        </ThemedText>
        <ThemedText style={styles.notFoundBody}>
          We haven&apos;t saved this product on this device yet. Reconnect to look it up.
        </ThemedText>
        <TouchableOpacity
          testID="product-offline-retry"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={() => { void refreshProduct(); }}
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Try again</Text>
        </TouchableOpacity>
      </ThemedView>
    );
  }

  // Id-based 404 (rejected or deleted). Unlike the gtin resolver's not-found
  // state, there is no gtin here to offer "add this product" against — an id
  // is opaque, so this is a plain dead end back to Home.
  if (notFound && !product) {
    return (
      <ThemedView style={styles.center} testID="product-id-not-found">
        <Text style={styles.successIcon}>🤔</Text>
        <ThemedText type="title" style={styles.successTitle}>
          Product not found
        </ThemedText>
        <ThemedText style={styles.notFoundBody}>
          This product is no longer available.
        </ThemedText>
        <TouchableOpacity
          testID="product-not-found-home"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={goHome}
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Back to Home</Text>
        </TouchableOpacity>
      </ThemedView>
    );
  }

  if (loadError && !notFound && !product) {
    return (
      // testID (P9-003): a backend-hiccup state. The Maestro flows assert they landed
      // on the product screen in *any* state; without this one a backend hiccup reads as a
      // navigation failure, which is what it did in CI.
      <ThemedView style={styles.center} testID="product-error">
        <ThemedText style={styles.errorText}>
          {formatApiError(loadError, 'Could not load this product. Please try again.')}
        </ThemedText>
      </ThemedView>
    );
  }

  if (submitted) {
    return (
      <ThemedView style={styles.center} testID="rating-submitted">
        <Text style={styles.successIcon}>{queuedOffline ? '💾' : '🎉'}</Text>
        <ThemedText type="title" style={styles.successTitle}>
          {queuedOffline
            ? 'Saved on this device'
            : submittedAsUpdate
              ? 'Rating Updated!'
              : 'Rating Submitted!'}
        </ThemedText>
        <ThemedText style={styles.successSubtitle}>
          You gave it a {taste % 1 === 0 ? taste.toFixed(1) : taste}/10 for taste.
        </ThemedText>
        {queuedOffline ? (
          <ThemedText testID="rating-queued-offline" style={styles.successSubtitle}>
            You&apos;re offline — we&apos;ll send it as soon as you&apos;re back online.
          </ThemedText>
        ) : null}
        <TouchableOpacity
          testID="rating-submitted-home"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={goHome}
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Done</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="rating-submitted-back-to-product"
          style={styles.successSecondary}
          onPress={() => setSubmitted(false)}
        >
          <Text style={[styles.successSecondaryText, { color: colors.tint }]}>
            Back to product
          </Text>
        </TouchableOpacity>
      </ThemedView>
    );
  }

  return (
    <ScrollView
      testID="product-screen"
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[styles.scrollContent, compact && compactStyles.scrollContent]}
      {...scrollProps}
    >
      {product?.image && !imageError ? (
        // `memory-disk` is what makes the hero shot render on an offline
        // launch — RN's own Image keeps nothing across restarts (P8-002).
        <Image
          source={{ uri: product.image }}
          style={styles.heroImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          onError={() => setImageError(true)}
        />
      ) : (
        <View style={[styles.heroPlaceholder, { backgroundColor: colors.icon + '22' }]}>
          <Text style={styles.placeholderIcon}>🍞</Text>
        </View>
      )}

      {isOffline ? (
        <View testID="product-offline-indicator" style={styles.offlineStrip}>
          <Text style={styles.offlineStripText}>
            📴 Offline — showing the last version saved on this device.
          </Text>
        </View>
      ) : null}

      {pendingSync ? (
        <View testID="product-pending-sync" style={styles.offlineStrip}>
          <Text style={styles.offlineStripText}>
            ⏳ Your rating is saved here and not yet sent to the server.
          </Text>
        </View>
      ) : null}

      {/*
        Reviewer banner (P5-002, extended by P5-007). Shown whenever the product
        is in PENDING_REVIEW and the viewer is not its submitter — including
        anonymous viewers, who since P5-007 can see pending products instead of
        hitting a "not found" dead end. Registered users get a tappable banner
        that opens the reviewer screen; anonymous users get the identical
        explanation as a plain, non-interactive note (they cannot vote — the
        server enforces that with `requireRegistered`; this is only the UX side).
      */}
      {product?.unverified && product.submittedByUserId !== userId ? (
        isAnonymous ? (
          <View
            testID="review-product-banner"
            style={[
              styles.reviewBanner,
              compact && compactStyles.reviewBanner,
              { backgroundColor: colors.tint + '22', borderColor: colors.tint },
            ]}
          >
            <Text style={styles.reviewBannerIcon}>🔎</Text>
            <View style={styles.reviewBannerBody}>
              <ThemedText style={styles.reviewBannerTitle}>Needs review</ThemedText>
              <ThemedText style={styles.reviewBannerText}>
                This product was added by a user — does it look correct?
              </ThemedText>
              <ThemedText
                testID="review-product-banner-guest-note"
                style={styles.reviewBannerNote}
              >
                Log in to review this product.
              </ThemedText>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            testID="review-product-banner"
            style={[
              styles.reviewBanner,
              compact && compactStyles.reviewBanner,
              { backgroundColor: colors.tint + '22', borderColor: colors.tint },
            ]}
            onPress={() =>
              router.push({
                pathname: '/(app)/review-product/[id]',
                params: { id },
              })
            }
          >
            <Text style={styles.reviewBannerIcon}>🔎</Text>
            <View style={styles.reviewBannerBody}>
              <ThemedText style={styles.reviewBannerTitle}>Needs review</ThemedText>
              <ThemedText style={styles.reviewBannerText}>
                This product was added by a user — does it look correct?
              </ThemedText>
            </View>
          </TouchableOpacity>
        )
      ) : null}

      {/*
        Edit-review banner (P5-006). Shown to registered users when a VERIFIED
        product has a pending edit they haven't authored, voted on, or dismissed.
      */}
      {pendingEdit &&
      !isAnonymous &&
      !pendingEdit.viewer.isAuthor &&
      !pendingEdit.viewer.dismissed &&
      !pendingEdit.viewer.vote ? (
        <TouchableOpacity
          testID="review-edit-banner"
          style={[
            styles.reviewBanner,
            compact && compactStyles.reviewBanner,
            { backgroundColor: colors.tint + '22', borderColor: colors.tint },
          ]}
          onPress={() =>
            router.push({
              pathname: '/(app)/review-edit/[editId]',
              params: { editId: pendingEdit.editId, productId: id },
            })
          }
        >
          <Text style={styles.reviewBannerIcon}>✏️</Text>
          <View style={styles.reviewBannerBody}>
            <ThemedText style={styles.reviewBannerTitle}>Suggested change</ThemedText>
            <ThemedText style={styles.reviewBannerText}>
              Someone suggested a change to this product — want to review it?
            </ThemedText>
          </View>
        </TouchableOpacity>
      ) : null}

      <View style={[styles.infoSection, compact && compactStyles.infoSection]}>
        <ThemedText type="title" style={styles.productName}>{product?.name}</ThemedText>
        {product?.brand ? (
          <ThemedText style={styles.brand}>{product.brand}</ThemedText>
        ) : null}
        {product?.description ? (
          <ThemedText style={styles.description}>{product.description}</ThemedText>
        ) : null}
        {/*
          A CUSTOM product (TICKET-P6-007 / ADR 0006) has no `packaged` row
          and therefore no GTIN to show — the chip (and the nutrition and
          allergen sections, which this screen never renders at all) is
          omitted entirely rather than shown as "not provided".
        */}
        {product?.packaged ? (
          <ThemedText style={styles.barcodeChip}>{product.packaged.gtin}</ThemedText>
        ) : null}

        {/*
          Edit entry point (P5-006). Registered users only — absent (not
          disabled) for anonymous sessions. PENDING_REVIEW products get the
          "Correct this submission" label (in-place correction path); VERIFIED
          products get "Edit product" unless an edit is already under review,
          in which case the button is hidden and a notice shown instead.
        */}
        {!isAnonymous && product ? (
          product.unverified ? (
            <TouchableOpacity
              testID="edit-product-button"
              style={[styles.editLink, { borderColor: colors.tint }]}
              onPress={() =>
                router.push({ pathname: '/(app)/edit-product/[id]', params: { id } })
              }
            >
              <Text style={[styles.editLinkText, { color: colors.tint }]}>
                ✏️ Correct this submission
              </Text>
            </TouchableOpacity>
          ) : product.status === 'VERIFIED' ? (
            pendingEdit ? (
              <ThemedText style={styles.editNotice} testID="edit-under-review-notice">
                An edit is already under review.
              </ThemedText>
            ) : (
              <TouchableOpacity
                testID="edit-product-button"
                style={[styles.editLink, { borderColor: colors.tint }]}
                onPress={() =>
                  router.push({ pathname: '/(app)/edit-product/[id]', params: { id } })
                }
              >
                <Text style={[styles.editLinkText, { color: colors.tint }]}>✏️ Edit product</Text>
              </TouchableOpacity>
            )
          ) : null
        ) : null}
      </View>

      <View style={[styles.divider, { backgroundColor: colors.icon + '33' }]} />

      <View style={[styles.ratingSection, compact && compactStyles.ratingSection]}>
        <ThemedText type="subtitle" style={styles.sectionTitle}>
          {isUpdate ? 'Your rating' : 'How does it taste?'}
        </ThemedText>
        <ThemedText style={[styles.sectionHint, compact && compactStyles.sectionHint]}>
          {isUpdate
            ? 'You rated this already — adjust the score or comment to update.'
            : 'Drag the slider or use − / + to set your score.'}
        </ThemedText>

        <TasteSlider value={taste} onChange={setTaste} />

        {/*
          Category row (TICKET-P6-003) — the user's own label for this
          rating, beneath the taste control. Never the product's machine
          suggestion shown as fact: the chip here only ever reflects the
          user's own decision (whether that decision started from the
          suggestion or not). Skipping is always allowed — there is no
          "+ Add category" nagging state, just a quiet affordance.
        */}
        <View style={styles.categoryRow} testID="category-row">
          <ThemedText style={[styles.categoryLabel, { color: colors.icon }]}>Category</ThemedText>
          <View style={styles.categoryChipsRow}>
            {categorySelection ? (
              <>
                <TouchableOpacity
                  testID="category-chip-selected"
                  style={[
                    styles.categoryChip,
                    { borderColor: colors.tint, backgroundColor: colors.tint + '18' },
                  ]}
                  onPress={() => setCategoryPickerVisible(true)}
                >
                  <Text style={[styles.categoryChipText, { color: colors.tint }]}>
                    🏷 {categorySelection.name}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="category-chip-remove"
                  accessibilityLabel="Remove category"
                  hitSlop={8}
                  style={styles.categoryRemoveBtn}
                  onPress={handleClearCategory}
                >
                  <Text style={[styles.categoryRemoveText, { color: colors.icon }]}>✕</Text>
                </TouchableOpacity>
              </>
            ) : suggestion?.kind === 'seed' ? (
              <TouchableOpacity
                testID="category-chip-suggestion"
                style={[styles.categoryChip, { borderColor: colors.tint }]}
                onPress={() => {
                  void handleSelectSeedCategory(suggestion).then((result) => {
                    if (!result.ok) setCategoryActionError(result.message);
                  });
                }}
              >
                <Text style={[styles.categoryChipText, { color: colors.tint }]}>
                  + {suggestion.name}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID="category-chip-add"
                style={[styles.categoryChip, { borderColor: colors.icon + '55' }]}
                onPress={() => setCategoryPickerVisible(true)}
              >
                <Text style={[styles.categoryChipText, { color: colors.icon }]}>+ Add category</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              testID="category-change-link"
              onPress={() => setCategoryPickerVisible(true)}
            >
              <Text style={[styles.categoryChangeLink, { color: colors.tint }]}>
                {categorySelection ? 'Change' : 'Browse'}
              </Text>
            </TouchableOpacity>
          </View>
          {categoryActionError ? (
            <ThemedText testID="category-action-error" style={styles.errorText}>
              {categoryActionError}
            </ThemedText>
          ) : null}
        </View>

        <TextInput
          testID="rating-comment-input"
          autoFocus={autoFocusRatingComment}
          style={[
            styles.commentInput,
            compact && compactStyles.commentInput,
            {
              color: colors.text,
              borderColor: colors.icon + '55',
              backgroundColor: colors.icon + '11',
            },
          ]}
          placeholder="Add a comment (optional)"
          placeholderTextColor={colors.icon}
          value={comment}
          onChangeText={setComment}
          multiline
          numberOfLines={3}
          maxLength={500}
          textAlignVertical="top"
        />

        {submitError ? (
          <ThemedText style={styles.errorText}>{submitError}</ThemedText>
        ) : null}

        <TouchableOpacity
          style={[
            styles.button,
            compact && compactStyles.button,
            { backgroundColor: colors.tint },
            submitting && styles.buttonDisabled,
          ]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color={colors.background} size="small" />
          ) : (
            <Text style={[styles.buttonText, { color: colors.background }]}>
              {isUpdate ? 'Update Rating' : 'Submit Rating'}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <CategoryPickerSheet
        visible={categoryPickerVisible}
        onClose={() => setCategoryPickerVisible(false)}
        ownCategories={myCategories}
        currentSelection={categorySelection}
        onSelectExisting={handleSelectExistingCategory}
        onSelectSeed={handleSelectSeedCategory}
        onCreate={handleCreateCategory}
        onClear={handleClearCategory}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  heroImage: {
    width: '100%',
    height: 260,
  },
  heroPlaceholder: {
    width: '100%',
    height: 260,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderIcon: {
    fontSize: 80,
  },
  infoSection: {
    padding: 20,
    gap: 6,
  },
  productName: {
    marginBottom: 2,
  },
  brand: {
    fontSize: 16,
    opacity: 0.6,
  },
  description: {
    fontSize: 14,
    opacity: 0.7,
    lineHeight: 20,
    marginTop: 4,
  },
  barcodeChip: {
    fontSize: 12,
    opacity: 0.4,
    marginTop: 6,
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    marginHorizontal: 20,
  },
  ratingSection: {
    padding: 20,
    gap: 4,
    alignItems: 'center',
  },
  sectionTitle: {
    marginBottom: 2,
    textAlign: 'center',
  },
  sectionHint: {
    fontSize: 13,
    opacity: 0.5,
    textAlign: 'center',
    marginBottom: 12,
  },
  categoryRow: {
    alignSelf: 'stretch',
    marginTop: 20,
    gap: 6,
  },
  categoryLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  categoryChipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  categoryChipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  categoryRemoveBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  categoryRemoveText: {
    fontSize: 15,
  },
  categoryChangeLink: {
    fontSize: 13,
    fontWeight: '600',
  },
  commentInput: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    marginTop: 24,
    minHeight: 80,
  },
  button: {
    alignSelf: 'stretch',
    marginTop: 20,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '700',
  },
  errorText: {
    color: '#e05c5c',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
  },
  successIcon: {
    fontSize: 60,
  },
  successTitle: {
    textAlign: 'center',
  },
  successSubtitle: {
    opacity: 0.6,
    textAlign: 'center',
  },
  successSecondary: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  successSecondaryText: {
    fontSize: 15,
    fontWeight: '600',
  },
  notFoundBody: {
    fontSize: 15,
    textAlign: 'center',
    opacity: 0.8,
    marginTop: 4,
  },
  reviewBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  reviewBannerIcon: {
    fontSize: 22,
  },
  reviewBannerBody: {
    flex: 1,
  },
  reviewBannerTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  reviewBannerText: {
    fontSize: 13,
    opacity: 0.8,
    marginTop: 2,
    lineHeight: 18,
  },
  // Guest-only third line (P5-007) — replaces the tap affordance the
  // registered-user banner carries implicitly.
  reviewBannerNote: {
    fontSize: 13,
    fontWeight: '600',
    opacity: 0.9,
    marginTop: 6,
    lineHeight: 18,
  },
  editLink: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginTop: 10,
  },
  editLinkText: {
    fontSize: 14,
    fontWeight: '600',
  },
  editNotice: {
    fontSize: 13,
    opacity: 0.55,
    fontStyle: 'italic',
    marginTop: 10,
  },
  offlineStrip: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f0c04022',
  },
  offlineStripText: {
    fontSize: 13,
    color: '#a5761b',
    fontWeight: '500',
  },
});

/**
 * Tightened vertical spacing applied when `useFitToScreen()` reports `compact`
 * (P5-006 FE Fixes). Vertical margins/padding/gaps only — no font sizes, and
 * no padding inside a pressable, so touch targets stay at their full size.
 */
const compactStyles = StyleSheet.create({
  scrollContent: {
    paddingBottom: SPACING_COMPACT.screenBottom,
  },
  reviewBanner: {
    marginTop: SPACING_COMPACT.sectionGap,
    paddingVertical: SPACING_COMPACT.cardPaddingV,
  },
  infoSection: {
    paddingVertical: SPACING_COMPACT.sectionPaddingV,
    gap: SPACING_COMPACT.tightGap,
  },
  ratingSection: {
    paddingVertical: SPACING_COMPACT.sectionPaddingV,
  },
  sectionHint: {
    marginBottom: SPACING_COMPACT.sectionGap,
  },
  commentInput: {
    marginTop: SPACING_COMPACT.sectionPaddingV,
  },
  button: {
    marginTop: SPACING_COMPACT.controlGap,
  },
});
