import { useCallback, useEffect, useRef, useState } from 'react';
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

import { ManualBarcodeSheet } from '@/components/manual-barcode-sheet';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SPACING_COMPACT } from '@/constants/spacing';
import { Colors } from '@/constants/theme';
import { ApiError, NetworkError, api } from '@/lib/api';
import { formatApiError } from '@/lib/format-error';
import { upsertCachedRating, productCache } from '@/lib/offline/caches';
import { useCachedResource } from '@/hooks/use-cached-resource';
import { useFitToScreen } from '@/hooks/use-fit-to-screen';
import { useMyRating } from '@/hooks/use-my-rating';
import { useOutbox } from '@/hooks/use-outbox';
import { useRecentProducts } from '@/hooks/use-recent-products';
import { useSession } from '@/hooks/use-session';
import { getPendingEdit } from '@/features/products/api';
import { sanitizeBarcodeInput } from '@/features/products/barcode';
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

export default function ProductScreen() {
  const { barcode } = useLocalSearchParams<{ barcode: string }>();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const router = useRouter();

  const { addRecentProduct } = useRecentProducts();
  const { isAnonymous, session } = useSession();
  const { enqueue, isQueued } = useOutbox();
  const userId = session?.user.id ?? null;

  const { compact, scrollProps } = useFitToScreen();

  const fetchProduct = useCallback(() => api.get<Product>(`/api/products/${barcode}`), [barcode]);

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
    key: `product:${barcode}`,
    cache: productCache(barcode),
    fetcher: fetchProduct,
  });

  const notFound = loadError instanceof ApiError && loadError.status === 404;

  // The server rejected the code itself (`^\d{8,13}$`). Reachable from a deep
  // link or a scan of an unsupported symbology; P6-006 answers it with the
  // manual-entry sheet pre-filled rather than a raw "Invalid barcode format".
  const invalidBarcode = loadError instanceof ApiError && loadError.status === 400;
  const [manualDismissed, setManualDismissed] = useState(false);

  // Pending edit on a VERIFIED product (P5-006). Drives both the "review this
  // change" banner and the hide-edit-button-with-notice state.
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  const { rating: existingRating, applyLocalRating } = useMyRating(userId, barcode);

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

  useEffect(() => {
    if (product) {
      addRecentProduct({
        barcode: product.barcode,
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
    getPendingEdit(product.barcode)
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
        return;
      }
      void refreshProduct();
    }, [refreshProduct])
  );

  const handleSubmit = useCallback(async () => {
    if (!product || submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    setSubmittedAsUpdate(existingRating !== null);
    const trimmed = comment.trim();
    try {
      const saved = await api.post<RatingEntry>('/api/ratings', {
        barcode: product.barcode,
        taste,
        comment: trimmed || undefined,
      });
      if (saved?.product?.barcode) {
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
        const optimistic: RatingEntry = {
          id: existingRating?.id ?? `local:${product.barcode}`,
          score: taste,
          taste,
          comment: trimmed || null,
          createdAt: new Date().toISOString(),
          product: {
            id: product.id,
            barcode: product.barcode,
            name: product.name,
            brand: product.brand,
            image: product.image,
          },
        };
        await enqueue({ barcode: product.barcode, taste, comment: trimmed || null });
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
  }, [product, taste, comment, submitting, existingRating, enqueue, applyLocalRating]);

  const isUpdate = existingRating !== null;
  const pendingSync = product ? isQueued(product.barcode) : false;

  if (loading || (!product && !notFound && !loadError && !isOffline)) {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator size="large" color={colors.tint} />
      </ThemedView>
    );
  }

  // Offline with nothing cached for this barcode. Deliberately *not* the
  // not-found state: we have no idea whether this product exists (P8-002).
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
        <ThemedText style={styles.barcodeChip}>{barcode}</ThemedText>
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

  if (invalidBarcode && !product) {
    return (
      <ThemedView style={styles.center} testID="product-invalid-barcode">
        <Text style={styles.successIcon}>🔢</Text>
        <ThemedText type="title" style={styles.successTitle}>
          That code doesn&apos;t look right
        </ThemedText>
        <ThemedText style={styles.notFoundBody}>
          Product barcodes are 8–13 digits. Check the number printed under the barcode.
        </ThemedText>
        <TouchableOpacity
          testID="product-invalid-barcode-retry"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={() => setManualDismissed(false)}
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Enter code manually</Text>
        </TouchableOpacity>
        <ManualBarcodeSheet
          visible={!manualDismissed}
          onClose={() => setManualDismissed(true)}
          initialValue={sanitizeBarcodeInput(barcode)}
          subtitle="Product barcodes are 8–13 digits. Correct the number below."
          // `replace`, not `push`: the corrected code takes the place of the
          // broken screen instead of stacking a second one behind it.
          onSubmit={(code) => router.replace(`/(app)/product/${code}`)}
        />
      </ThemedView>
    );
  }

  if (loadError && !notFound && !product) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText style={styles.errorText}>
          {formatApiError(loadError, 'Could not load this product. Please try again.')}
        </ThemedText>
      </ThemedView>
    );
  }

  if (notFound && !product) {
    return (
      <ThemedView style={styles.center} testID="product-not-found">
        <Text style={styles.successIcon}>🤔</Text>
        <ThemedText type="title" style={styles.successTitle}>
          Product not found
        </ThemedText>
        <ThemedText style={styles.notFoundBody}>
          This product isn&apos;t in the database yet.
        </ThemedText>
        <ThemedText style={styles.barcodeChip}>{barcode}</ThemedText>

        {isAnonymous ? (
          <>
            <ThemedText style={styles.notFoundHint}>
              Sign up to help add it.
            </ThemedText>
            <TouchableOpacity
              testID="product-not-found-signup"
              style={[styles.button, { backgroundColor: colors.tint }]}
              onPress={() =>
                router.push({
                  pathname: '/(auth)/signup',
                  params: { returnTo: `/product/${barcode}` },
                })
              }
            >
              <Text style={[styles.buttonText, { color: colors.background }]}>
                Sign up
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            testID="product-not-found-add"
            style={[styles.button, { backgroundColor: colors.tint }]}
            onPress={() =>
              router.replace({
                pathname: '/(app)/add-product',
                params: { barcode },
              })
            }
          >
            <Text style={[styles.buttonText, { color: colors.background }]}>
              Add this product
            </Text>
          </TouchableOpacity>
        )}
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
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={() => router.back()}
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Go Back</Text>
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
                pathname: '/(app)/review-product/[barcode]',
                params: { barcode },
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
              params: { editId: pendingEdit.editId, barcode },
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
        <ThemedText style={styles.barcodeChip}>{barcode}</ThemedText>

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
                router.push({ pathname: '/(app)/edit-product/[barcode]', params: { barcode } })
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
                  router.push({ pathname: '/(app)/edit-product/[barcode]', params: { barcode } })
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

        <TextInput
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
  notFoundBody: {
    fontSize: 15,
    textAlign: 'center',
    opacity: 0.8,
    marginTop: 4,
  },
  notFoundHint: {
    fontSize: 14,
    textAlign: 'center',
    opacity: 0.6,
    marginTop: 8,
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
