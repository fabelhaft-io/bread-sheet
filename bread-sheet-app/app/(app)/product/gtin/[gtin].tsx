import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ManualBarcodeSheet } from '@/components/manual-barcode-sheet';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSession } from '@/hooks/use-session';
import { lookupProductByGtin } from '@/features/products/api';
import { sanitizeBarcodeInput } from '@/features/products/barcode';
import { ApiError, NetworkError } from '@/lib/api';
import { formatApiError } from '@/lib/format-error';
import { peekProductIdByGtin, productCache, readProductIdByGtin } from '@/lib/offline/caches';

/**
 * TICKET-P6-009 — the GTIN resolver.
 *
 * `Product.id` is the only key the rest of the app understands, but a scan or
 * a typed code only ever produces a GTIN. Every code-shaped entry point
 * (scan, manual entry, a deep link, the add-product 404 path) routes here
 * first; this screen's only successful outcome is `router.replace`-ing into
 * `/(app)/product/<id>` once it has one. The states that used to live on the
 * product screen when it was keyed by barcode — invalid code, not-found,
 * offline-with-nothing-cached — moved here verbatim (JSX and `testID`s
 * included) so the Maestro flows, which assert on those `testID`s, keep
 * matching.
 */
export default function ProductGtinResolverScreen() {
  const { gtin } = useLocalSearchParams<{ gtin: string }>();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { isAnonymous } = useSession();

  const [state, setState] = useState<'resolving' | 'invalid' | 'not-found' | 'offline' | 'error'>(
    'resolving',
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [manualDismissed, setManualDismissed] = useState(false);
  // Bumped by the "Try again" buttons to re-run the effect below.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting for a retry
    setState('resolving');
    setLoadError(null);
    setManualDismissed(false);

    (async () => {
      // Checked before any network call: an offline scan of a product
      // already known to this device must paint instantly, not wait on a
      // request that is about to fail.
      const cachedId = peekProductIdByGtin(gtin) ?? (await readProductIdByGtin(gtin));
      if (cancelled) return;
      if (cachedId) {
        router.replace(`/(app)/product/${cachedId}`);
        return;
      }
      try {
        const product = await lookupProductByGtin(gtin);
        if (cancelled) return;
        await productCache(product.id).write(product);
        if (cancelled) return;
        router.replace(`/(app)/product/${product.id}`);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof NetworkError) {
          setState('offline');
        } else if (err instanceof ApiError && err.status === 400) {
          setState('invalid');
        } else if (err instanceof ApiError && err.status === 404) {
          setState('not-found');
        } else {
          setLoadError(err);
          setState('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [gtin, router, attempt]);

  if (state === 'resolving') {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator size="large" color={colors.tint} />
      </ThemedView>
    );
  }

  // The server rejected the code itself (`^\d{8,13}$`). Reachable from a deep
  // link or a scan of an unsupported symbology; P6-006 answers it with the
  // manual-entry sheet pre-filled rather than a raw "Invalid barcode format".
  if (state === 'invalid') {
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
          initialValue={sanitizeBarcodeInput(gtin)}
          subtitle="Product barcodes are 8–13 digits. Correct the number below."
          // `replace`, not `push`: the corrected code takes the place of the
          // broken resolver screen instead of stacking a second one behind it.
          onSubmit={(code) => router.replace(`/(app)/product/gtin/${code}`)}
        />
      </ThemedView>
    );
  }

  // Offline with nothing cached for this GTIN. Deliberately *not* the
  // not-found state: we have no idea whether this product exists (P8-002).
  if (state === 'offline') {
    return (
      <ThemedView style={styles.center} testID="product-offline">
        <Text style={styles.successIcon}>📴</Text>
        <ThemedText type="title" style={styles.successTitle}>
          You&apos;re offline
        </ThemedText>
        <ThemedText style={styles.notFoundBody}>
          We haven&apos;t saved this product on this device yet. Reconnect to look it up.
        </ThemedText>
        <ThemedText style={styles.barcodeChip}>{gtin}</ThemedText>
        <TouchableOpacity
          testID="product-offline-retry"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={retry}
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Try again</Text>
        </TouchableOpacity>
      </ThemedView>
    );
  }

  if (state === 'not-found') {
    return (
      <ThemedView style={styles.center} testID="product-not-found">
        <Text style={styles.successIcon}>🤔</Text>
        <ThemedText type="title" style={styles.successTitle}>
          Product not found
        </ThemedText>
        <ThemedText style={styles.notFoundBody}>
          This product isn&apos;t in the database yet.
        </ThemedText>
        <ThemedText style={styles.barcodeChip}>{gtin}</ThemedText>

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
                  params: { returnTo: `/product/gtin/${gtin}` },
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
                params: { gtin },
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

  // `error`: a non-400/404 failure from the lookup (5xx, 429, …). Not a ticket
  // acceptance case, but the product screen always had this branch and losing
  // it would turn a transient backend hiccup into a dead end with no retry.
  return (
    <ThemedView style={styles.center} testID="product-error">
      <ThemedText style={styles.errorText}>
        {formatApiError(loadError, 'Could not look up this product. Please try again.')}
      </ThemedText>
      <TouchableOpacity
        testID="product-error-retry"
        style={[styles.button, { backgroundColor: colors.tint }]}
        onPress={retry}
      >
        <Text style={[styles.buttonText, { color: colors.background }]}>Try again</Text>
      </TouchableOpacity>
    </ThemedView>
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
  button: {
    alignSelf: 'stretch',
    marginTop: 20,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
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
  barcodeChip: {
    fontSize: 12,
    opacity: 0.4,
    marginTop: 6,
    letterSpacing: 0.5,
  },
});
