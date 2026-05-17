import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { ApiError, api } from '@/lib/api';
import { formatApiError } from '@/lib/format-error';
import { useRecentProducts } from '@/hooks/use-recent-products';
import { useSession } from '@/hooks/use-session';

interface Product {
  id: string;
  barcode: string;
  name: string;
  brand: string | null;
  image: string | null;
  description: string | null;
  /** Present when the product is awaiting peer review (P5-002). */
  unverified?: boolean;
  /** Supabase user id of the submitter, when the product was user-contributed. */
  submittedByUserId?: string | null;
}

interface UserRating {
  id: string;
  taste: number;
  comment: string | null;
}

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
//   • Horizontal draggable track (snaps to 0.5)
//   • –0.5 / +0.5 stepper buttons for fine control
//   • Filled track colour transitions amber → green
//   • Tick marks at whole numbers
//
function TasteSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const TRACK_WIDTH = 280;
  const MIN = 0;
  const MAX = 10;
  const STEP = 0.5;

  const trackRef = useRef<View>(null);
  const startX = useRef(0);
  const startVal = useRef(value);

  const thumbAnim = useRef(new Animated.Value((value / MAX) * TRACK_WIDTH)).current;

  // Keep thumb position in sync when value changes via stepper
  useEffect(() => {
    Animated.spring(thumbAnim, {
      toValue: (value / MAX) * TRACK_WIDTH,
      useNativeDriver: false,
      speed: 30,
      bounciness: 4,
    }).start();
  }, [thumbAnim, value]);

  const snap = (raw: number) => {
    const clamped = Math.max(MIN, Math.min(MAX, raw));
    return Math.round(clamped / STEP) * STEP;
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        startX.current = evt.nativeEvent.pageX;
        startVal.current = value;
      },
      onPanResponderMove: (evt) => {
        const dx = evt.nativeEvent.pageX - startX.current;
        const delta = (dx / TRACK_WIDTH) * MAX;
        const snapped = snap(startVal.current + delta);
        onChange(snapped);
      },
    })
  ).current;

  const step = (dir: 1 | -1) => {
    onChange(snap(value + dir * STEP));
  };

  const color = scoreColor(value);
  const fillWidth = thumbAnim.interpolate({
    inputRange: [0, TRACK_WIDTH],
    outputRange: [0, TRACK_WIDTH],
    extrapolate: 'clamp',
  });

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

        {/* Draggable track */}
        <View
          ref={trackRef}
          style={sliderStyles.track}
          {...panResponder.panHandlers}
        >
          {/* Fill */}
          <Animated.View
            style={[sliderStyles.trackFill, { width: fillWidth, backgroundColor: color, pointerEvents: 'none' }]}
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
            style={[
              sliderStyles.thumb,
              { left: thumbAnim, backgroundColor: color, pointerEvents: 'none' },
            ]}
          />
        </View>

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
  const userId = session?.user.id ?? null;

  const [product, setProduct] = useState<Product | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  const [existingRating, setExistingRating] = useState<UserRating | null>(null);
  const [taste, setTaste] = useState(5);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNotFound(false);
    setLoadError(null);

    // Fetch the product and the caller's existing rating in parallel. Anonymous
    // sessions don't have a persistent rating to fetch yet (P5-004), so skip the
    // /me lookup for them. Any failure on the rating lookup (404 "not rated yet"
    // or otherwise) degrades to "no existing rating" so it never blocks the
    // product screen — the user can still submit a fresh rating.
    const productReq = api.get<Product>(`/api/products/${barcode}`);
    const ratingReq: Promise<UserRating | null> = isAnonymous
      ? Promise.resolve(null)
      : api
          .get<UserRating>(`/api/ratings/me/${barcode}`)
          .catch(() => null);

    productReq
      .then((data) => {
        if (cancelled) return;
        setProduct(data);
        addRecentProduct({ barcode: data.barcode, name: data.name, brand: data.brand, image: data.image });
        return ratingReq.then((rating) => {
          if (cancelled || !rating) return;
          setExistingRating(rating);
          setTaste(rating.taste);
          setComment(rating.comment ?? '');
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setLoadError(formatApiError(err, 'Could not load this product. Please try again.'));
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [addRecentProduct, barcode, isAnonymous]);

  const handleSubmit = useCallback(async () => {
    if (!product || submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await api.post('/api/ratings', {
        barcode: product.barcode,
        taste,
        comment: comment.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err: unknown) {
      setSubmitError(formatApiError(err, 'Could not submit your rating. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }, [product, taste, comment, submitting]);

  const isUpdate = existingRating !== null;

  if (loading) {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator size="large" color={colors.tint} />
      </ThemedView>
    );
  }

  if (loadError) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText style={styles.errorText}>{loadError}</ThemedText>
      </ThemedView>
    );
  }

  if (notFound) {
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
              router.push({
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
      <ThemedView style={styles.center}>
        <Text style={styles.successIcon}>🎉</Text>
        <ThemedText type="title" style={styles.successTitle}>
          {isUpdate ? 'Rating Updated!' : 'Rating Submitted!'}
        </ThemedText>
        <ThemedText style={styles.successSubtitle}>
          You gave it a {taste % 1 === 0 ? taste.toFixed(1) : taste}/10 for taste.
        </ThemedText>
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
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.scrollContent}
    >
      {product?.image ? (
        <Image source={{ uri: product.image }} style={styles.heroImage} resizeMode="cover" />
      ) : (
        <View style={[styles.heroPlaceholder, { backgroundColor: colors.icon + '22' }]}>
          <Text style={styles.placeholderIcon}>🍞</Text>
        </View>
      )}

      {/*
        Reviewer banner (P5-002). Shown to registered, non-submitter users
        when the product is in PENDING_REVIEW. Tapping opens the reviewer
        screen where the user can approve or reject the submission.
      */}
      {product?.unverified && !isAnonymous && product.submittedByUserId !== userId ? (
        <TouchableOpacity
          testID="review-product-banner"
          style={[styles.reviewBanner, { backgroundColor: colors.tint + '22', borderColor: colors.tint }]}
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
      ) : null}

      <View style={styles.infoSection}>
        <ThemedText type="title" style={styles.productName}>{product?.name}</ThemedText>
        {product?.brand ? (
          <ThemedText style={styles.brand}>{product.brand}</ThemedText>
        ) : null}
        {product?.description ? (
          <ThemedText style={styles.description}>{product.description}</ThemedText>
        ) : null}
        <ThemedText style={styles.barcodeChip}>{barcode}</ThemedText>
      </View>

      <View style={[styles.divider, { backgroundColor: colors.icon + '33' }]} />

      <View style={styles.ratingSection}>
        <ThemedText type="subtitle" style={styles.sectionTitle}>
          {isUpdate ? 'Your rating' : 'How does it taste?'}
        </ThemedText>
        <ThemedText style={styles.sectionHint}>
          {isUpdate
            ? 'You rated this already — adjust the score or comment to update.'
            : 'Drag the slider or use − / + to set your score.'}
        </ThemedText>

        <TasteSlider value={taste} onChange={setTaste} />

        <TextInput
          style={[
            styles.commentInput,
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
          style={[styles.button, { backgroundColor: colors.tint }, submitting && styles.buttonDisabled]}
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
});
