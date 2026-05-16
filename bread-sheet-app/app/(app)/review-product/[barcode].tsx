import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSession } from '@/hooks/use-session';
import { api } from '@/lib/api';

import { approveProduct, rejectProduct } from '@/features/products/api';
import type { ProductDetail } from '@/features/products/types';

/**
 * TICKET-P5-002 — Reviewer screen.
 *
 * Shown when a registered, non-submitter user taps the "Needs review" banner
 * on a `PENDING_REVIEW` product. Renders every submitted field in the same
 * visual layout as the regular product detail — product photo at the top,
 * then every submitted field below, *including* ones that are null (shown as
 * "Not provided") so the reviewer can judge completeness.
 *
 * Bottom of the screen exposes two actions:
 *   - "Looks correct"       → POST /products/:barcode/verify
 *   - "Something looks wrong" → DELETE /products/:barcode/verify
 *                               (semantics: a "no" vote is represented by
 *                                explicitly *not* verifying — P5-003 uses
 *                                the DELETE path to allow retractions, so we
 *                                reuse it here to capture "no" intent.)
 */

export default function ReviewProductScreen() {
  const { barcode } = useLocalSearchParams<{ barcode: string }>();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { session, isAnonymous } = useSession();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    // Skip the fetch when the caller isn't allowed to review — the render
    // branch below short-circuits to the anonymous gate, and firing the GET
    // anyway would 401/403 and surface a misleading error.
    if (!session || isAnonymous) return;
    let cancelled = false;
    setLoadError(null);
    api
      .get<ProductDetail>(`/api/products/${barcode}`)
      .then((data) => {
        if (!cancelled) setProduct(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load product');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [barcode, session, isAnonymous]);

  const goBackToProduct = useCallback(() => {
    router.replace({ pathname: '/(app)/product/[barcode]', params: { barcode } });
  }, [router, barcode]);

  const onApprove = useCallback(async () => {
    if (submitting) return;
    setSubmitting('approve');
    setActionError(null);
    try {
      await approveProduct(barcode);
      goBackToProduct();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not record approval.');
      setSubmitting(null);
    }
  }, [barcode, goBackToProduct, submitting]);

  const onReject = useCallback(async () => {
    if (submitting) return;
    setSubmitting('reject');
    setActionError(null);
    try {
      await rejectProduct(barcode);
      goBackToProduct();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not record rejection.');
      setSubmitting(null);
    }
  }, [barcode, goBackToProduct, submitting]);

  // Access control: anonymous users have no business here. They'd get a
  // 403 from the backend anyway (P5-003 requireRegistered), but the upstream
  // banner is already hidden so this is defence-in-depth.
  if (!session || isAnonymous) {
    return (
      <ThemedView style={styles.center} testID="review-product-anon-gate">
        <Text style={styles.icon}>🔒</Text>
        <ThemedText type="title" style={styles.title}>
          Sign up to review products
        </ThemedText>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={() =>
            router.push({
              pathname: '/(auth)/signup',
              params: { returnTo: `/product/${barcode}` },
            })
          }
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Sign up</Text>
        </TouchableOpacity>
      </ThemedView>
    );
  }

  // A submitter reviewing their own product is also a no-op — the backend
  // returns 403 (P5-003), but hide the buttons up front so the user doesn't
  // try.
  const isOwnSubmission = product?.submittedByUserId === session.user.id;

  if (loading) {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator size="large" color={colors.tint} />
      </ThemedView>
    );
  }
  if (loadError || !product) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText style={styles.errorText}>{loadError ?? 'Not found.'}</ThemedText>
      </ThemedView>
    );
  }

  const submission = product.submission ?? {};
  const rows: [string, string | number | null | undefined][] = [
    ['Name', submission.name ?? product.name],
    ['Brand', submission.brand ?? product.brand],
    ['Generic name', submission.genericName],
    ['Energy (kcal/100 g)', submission.energyKcal],
    ['Carbohydrates (g)', submission.carbohydrates],
    ['Fat (g)', submission.fat],
    ['Protein (g)', submission.protein],
    ['Salt (g)', submission.salt],
    ['Serving size', submission.servingSize],
    ['Ingredients', submission.ingredients],
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.scrollContent}
      testID="review-product-screen"
    >
      {product.image ? (
        <Image source={{ uri: product.image }} style={styles.heroImage} resizeMode="cover" />
      ) : (
        <View style={[styles.heroPlaceholder, { backgroundColor: colors.icon + '22' }]}>
          <Text style={styles.heroPlaceholderIcon}>🍞</Text>
        </View>
      )}

      <View style={styles.infoSection}>
        <ThemedText type="title" style={styles.productName}>
          {product.name}
        </ThemedText>
        <ThemedText style={styles.barcode}>{product.barcode}</ThemedText>
        <ThemedText style={styles.explanation}>
          This product was submitted by a user and is awaiting peer review.
          Please check the details match what&apos;s on the packaging.
        </ThemedText>
      </View>

      <View style={[styles.divider, { backgroundColor: colors.icon + '33' }]} />

      <View style={styles.detailsSection} testID="review-details">
        {rows.map(([label, value]) => (
          <View key={label} style={styles.detailRow}>
            <ThemedText style={styles.detailLabel}>{label}</ThemedText>
            <ThemedText
              style={[
                styles.detailValue,
                (value === null || value === undefined || value === '') &&
                  styles.detailValueMissing,
              ]}
            >
              {value === null || value === undefined || value === ''
                ? 'Not provided'
                : String(value)}
            </ThemedText>
          </View>
        ))}
      </View>

      {isOwnSubmission ? (
        <View style={styles.section}>
          <ThemedText style={styles.explanation} testID="own-submission-note">
            You submitted this product. Waiting on peer review.
          </ThemedText>
        </View>
      ) : (
        <View style={styles.actionsSection}>
          {actionError ? (
            <ThemedText style={styles.errorText} testID="review-action-error">
              {actionError}
            </ThemedText>
          ) : null}
          <TouchableOpacity
            testID="review-approve"
            style={[
              styles.button,
              { backgroundColor: colors.tint },
              submitting && styles.buttonDisabled,
            ]}
            disabled={submitting !== null}
            onPress={onApprove}
          >
            {submitting === 'approve' ? (
              <ActivityIndicator color={colors.background} size="small" />
            ) : (
              <Text style={[styles.buttonText, { color: colors.background }]}>
                Looks correct
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            testID="review-reject"
            style={[styles.secondaryActionButton, { borderColor: colors.tint }]}
            disabled={submitting !== null}
            onPress={onReject}
          >
            {submitting === 'reject' ? (
              <ActivityIndicator color={colors.tint} size="small" />
            ) : (
              <Text style={[styles.buttonText, { color: colors.tint }]}>
                Something looks wrong
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}
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
    paddingBottom: 60,
  },
  heroImage: {
    width: '100%',
    height: 220,
  },
  heroPlaceholder: {
    width: '100%',
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroPlaceholderIcon: {
    fontSize: 80,
  },
  infoSection: {
    padding: 20,
    gap: 6,
  },
  productName: {
    marginBottom: 2,
  },
  barcode: {
    fontSize: 12,
    opacity: 0.5,
    letterSpacing: 0.5,
  },
  explanation: {
    fontSize: 13,
    opacity: 0.7,
    lineHeight: 18,
    marginTop: 4,
  },
  divider: {
    height: 1,
    marginHorizontal: 20,
  },
  detailsSection: {
    padding: 20,
    gap: 14,
  },
  detailRow: {
    gap: 2,
  },
  detailLabel: {
    fontSize: 12,
    opacity: 0.6,
    letterSpacing: 0.3,
  },
  detailValue: {
    fontSize: 15,
  },
  detailValueMissing: {
    fontStyle: 'italic',
    opacity: 0.5,
  },
  actionsSection: {
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 10,
  },
  section: {
    paddingHorizontal: 20,
  },
  button: {
    alignSelf: 'stretch',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  secondaryActionButton: {
    alignSelf: 'stretch',
    borderRadius: 12,
    borderWidth: 1,
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
  },
  icon: {
    fontSize: 48,
  },
  title: {
    textAlign: 'center',
  },
});
