import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SPACING_COMPACT } from '@/constants/spacing';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useFitToScreen } from '@/hooks/use-fit-to-screen';
import { useProductSearch } from '@/hooks/use-product-search';
import { useSession } from '@/hooks/use-session';
import { formatApiError, OFFLINE_MESSAGE } from '@/lib/format-error';

import { createCustomProduct, uploadProductImage } from '@/features/products/api';
import {
  CUSTOM_PRODUCT_NAME_MAX_RAW_CHARS,
  canOfferCreate,
  findLikelyDuplicate,
  isDuplicateNameConflict,
  validateCustomProductName,
} from '@/features/products/custom';
import { captureImage, type CaptureSource } from '@/features/products/image-picker';
import { ImageTooLargeError, processCaptureForUpload } from '@/features/products/image-processing';
import type { ProductSearchResult } from '@/features/search/api';
import { supabase } from '@/lib/supabase';

/**
 * TICKET-P6-007 — Add Custom Product.
 *
 * Opens as a search box (Decision 3: search before create) — results carry
 * both `PACKAGED` and `CUSTOM` products, so typing "Coca-Cola" finds the
 * barcoded product instead of inviting a duplicate. "Create '<query>'" only
 * appears once the query is searchable and results have settled; if the best
 * match is a close name (similarity ≥ 0.6) a "Did you mean…?" confirmation
 * stands between the user and actually creating one. Creation itself is
 * `requireRegistered` server-side — search and browse stay open to guests,
 * only the create action gates on the P5-001 sign-up prompt.
 */

type Mode = 'search' | 'confirm' | 'create' | 'signup-gate';

export default function AddCustomProductScreen() {
  const router = useRouter();
  const { session, isAnonymous } = useSession();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const { compact, scrollProps } = useFitToScreen();

  const [mode, setMode] = useState<Mode>('search');
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim();

  const {
    results,
    isLoading: searchLoading,
    isLoadingMore: searchLoadingMore,
    isOffline: searchOffline,
    error: searchError,
    hasMore: searchHasMore,
    loadMore: searchLoadMore,
  } = useProductSearch(query, mode === 'search');

  const [duplicateCandidate, setDuplicateCandidate] = useState<ProductSearchResult | null>(null);

  // ─── Create-form state ──────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [imageKey, setImageKey] = useState<string | null>(null);
  const [photoProcessing, setPhotoProcessing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const canOfferCreateAction = canOfferCreate(query) && !searchLoading;

  const startCreate = useCallback((prefillName: string) => {
    setName(prefillName);
    setNameError(null);
    setPhotoUri(null);
    setImageKey(null);
    setPhotoError(null);
    setSubmitError(null);
    setMode('create');
  }, []);

  const handleCreatePress = useCallback(() => {
    if (!session || isAnonymous) {
      setMode('signup-gate');
      return;
    }
    const duplicate = findLikelyDuplicate(results);
    if (duplicate) {
      setDuplicateCandidate(duplicate);
      setMode('confirm');
    } else {
      startCreate(trimmedQuery);
    }
  }, [session, isAnonymous, results, trimmedQuery, startCreate]);

  const handleCapturePhoto = useCallback(async (source: CaptureSource) => {
    setPhotoError(null);
    try {
      const { uri } = await captureImage(source);
      if (!uri) return;
      setPhotoProcessing(true);
      // Local resize profile ('product': 1200px longest edge) is independent
      // of the server-side upload classification below — a custom item's
      // photo is sized the same as a product photo, just tagged `item` so
      // the plausibility gate uses the "real thing someone could have
      // consumed" prompt instead of "packaged product" (ADR 0006).
      const processed = await processCaptureForUpload(uri, 'product');

      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();
      const authHeader = currentSession ? `Bearer ${currentSession.access_token}` : null;

      const uploaded = await uploadProductImage(processed.uri, 'item', authHeader);
      setPhotoUri(processed.uri);
      setImageKey(uploaded.imageKey);
    } catch (err) {
      if (err instanceof ImageTooLargeError) {
        setPhotoError(err.message);
      } else {
        setPhotoError(formatApiError(err, 'Could not use that photo. Please try again.'));
        setPhotoUri(null);
        setImageKey(null);
      }
    } finally {
      setPhotoProcessing(false);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    const validation = validateCustomProductName(name);
    if (!validation.valid) {
      setNameError(validation.message);
      return;
    }
    setNameError(null);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await createCustomProduct({
        name: validation.name,
        ...(imageKey ? { imageKey } : {}),
      });
      router.replace({
        pathname: '/(app)/product/[id]',
        params: { id: result.id, focusRating: '1' },
      });
    } catch (err) {
      if (isDuplicateNameConflict(err)) {
        // The hard server-side gate fired even though the soft client gate
        // didn't (e.g. someone else created the same name moments ago) —
        // open the product that already exists rather than erroring.
        router.replace({
          pathname: '/(app)/product/[id]',
          params: { id: err.body.productId },
        });
      } else {
        setSubmitError(formatApiError(err, 'Could not create this product. Please try again.'));
      }
    } finally {
      setSubmitting(false);
    }
  }, [submitting, name, imageKey, router]);

  // ─── Sign-up gate (P5-001) — only the create action is gated ───────────
  if (mode === 'signup-gate') {
    return (
      <ThemedView style={styles.center} testID="add-custom-product-signup-gate">
        <Text style={styles.icon}>🔒</Text>
        <ThemedText type="title" style={styles.title}>
          Sign up to add something new
        </ThemedText>
        <ThemedText style={styles.body}>
          Searching and rating are open to everyone — creating a new item needs an account.
        </ThemedText>
        <TouchableOpacity
          testID="add-custom-product-signup"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={() =>
            router.push({
              pathname: '/(auth)/signup',
              params: { returnTo: '/add-custom-product' },
            })
          }
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Sign up</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="add-custom-product-signup-back"
          style={styles.secondaryButton}
          onPress={() => setMode('search')}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.tint }]}>
            Back to search
          </Text>
        </TouchableOpacity>
      </ThemedView>
    );
  }

  // ─── "Did you mean…?" confirmation (Decision 3's soft duplicate gate) ──
  if (mode === 'confirm' && duplicateCandidate) {
    return (
      <ThemedView style={styles.center} testID="custom-product-duplicate-confirm">
        <Text style={styles.icon}>🤔</Text>
        <ThemedText type="title" style={styles.title}>
          Did you mean {duplicateCandidate.name}?
        </ThemedText>
        <ThemedText style={styles.body}>
          Something very similar already exists. Rating the existing one keeps everyone&apos;s
          ratings together.
        </ThemedText>
        <TouchableOpacity
          testID="custom-product-duplicate-open"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={() =>
            router.push({ pathname: '/(app)/product/[id]', params: { id: duplicateCandidate.id } })
          }
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>
            Open {duplicateCandidate.name}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="custom-product-duplicate-create-anyway"
          style={styles.secondaryButton}
          onPress={() => startCreate(trimmedQuery)}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.tint }]}>
            No, create &quot;{trimmedQuery}&quot;
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="custom-product-duplicate-back"
          style={styles.secondaryButton}
          onPress={() => setMode('search')}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.icon }]}>Back to search</Text>
        </TouchableOpacity>
      </ThemedView>
    );
  }

  // ─── Short create form (Decision 1/2) ──────────────────────────────────
  if (mode === 'create') {
    const photoShown = photoUri;
    return (
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: colors.background }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.scrollContent, compact && compactStyles.scrollContent]}
          keyboardShouldPersistTaps="handled"
          testID="custom-product-create-form"
          {...scrollProps}
        >
          <View style={[styles.section, compact && compactStyles.section]}>
            <ThemedText type="subtitle">Add it</ThemedText>
            <ThemedText style={styles.body}>
              Just a name is enough — a photo is optional. It starts under review, same as any
              user-submitted product, and you can rate it right away.
            </ThemedText>

            <View style={styles.field}>
              <ThemedText style={styles.fieldLabel}>Name *</ThemedText>
              <TextInput
                testID="custom-product-name-input"
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  setNameError(null);
                }}
                // One over the cap — a 81st character is how the user
                // discovers the limit, rather than the field swallowing it.
                maxLength={CUSTOM_PRODUCT_NAME_MAX_RAW_CHARS + 1}
                style={[
                  styles.fieldInput,
                  {
                    color: colors.text,
                    borderColor: nameError ? '#e05c5c' : colors.icon + '55',
                    backgroundColor: colors.icon + '11',
                  },
                ]}
                placeholder="e.g. Negroni"
                placeholderTextColor={colors.icon}
              />
              {nameError ? (
                <ThemedText style={styles.errorText} testID="custom-product-name-error">
                  {nameError}
                </ThemedText>
              ) : null}
            </View>

            {photoShown ? (
              <Image source={{ uri: photoShown }} style={styles.photoPreview} resizeMode="cover" />
            ) : null}
            <View style={styles.photoRow}>
              {photoProcessing ? (
                <ActivityIndicator color={colors.tint} testID="custom-product-photo-processing" />
              ) : (
                <>
                  <TouchableOpacity
                    testID="custom-product-photo-camera"
                    style={[styles.photoBtn, { borderColor: colors.tint }]}
                    onPress={() => handleCapturePhoto('camera')}
                  >
                    <Text style={[styles.photoBtnText, { color: colors.tint }]}>📷 Camera</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID="custom-product-photo-library"
                    style={[styles.photoBtn, { borderColor: colors.tint }]}
                    onPress={() => handleCapturePhoto('library')}
                  >
                    <Text style={[styles.photoBtnText, { color: colors.tint }]}>🖼 Library</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
            {photoError ? (
              <ThemedText style={styles.errorText} testID="custom-product-photo-error">
                {photoError}
              </ThemedText>
            ) : null}

            {submitError ? (
              <ThemedText style={styles.errorText} testID="custom-product-submit-error">
                {submitError}
              </ThemedText>
            ) : null}

            <TouchableOpacity
              testID="custom-product-submit"
              style={[
                styles.button,
                compact && compactStyles.button,
                { backgroundColor: colors.tint },
                submitting && styles.buttonDisabled,
              ]}
              disabled={submitting}
              onPress={handleSubmit}
            >
              {submitting ? (
                <ActivityIndicator color={colors.background} size="small" />
              ) : (
                <Text style={[styles.buttonText, { color: colors.background }]}>Create & rate</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              testID="custom-product-back-to-search"
              style={styles.secondaryButton}
              onPress={() => setMode('search')}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.tint }]}>
                Back to search
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ─── Search (default mode) ─────────────────────────────────────────────
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[styles.scrollContent, compact && compactStyles.scrollContent]}
      keyboardShouldPersistTaps="handled"
      testID="add-custom-product-screen"
      {...scrollProps}
    >
      <View style={[styles.section, compact && compactStyles.section]}>
        <ThemedText type="subtitle">Add something with no barcode</ThemedText>
        <ThemedText style={styles.body}>
          A cocktail, a dish, loose-leaf tea… search first — someone may have already added it.
        </ThemedText>

        <TextInput
          testID="custom-product-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name"
          placeholderTextColor={colors.icon + '88'}
          style={[
            styles.fieldInput,
            { color: colors.text, borderColor: colors.icon + '33', backgroundColor: colors.icon + '11' },
          ]}
          autoCorrect={false}
          autoCapitalize="none"
          maxLength={100}
          returnKeyType="search"
        />
      </View>

      {searchLoading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.tint} />
        </View>
      ) : searchOffline ? (
        <View style={[styles.section, compact && compactStyles.section]}>
          <ThemedText testID="custom-product-search-offline" style={styles.body}>
            {OFFLINE_MESSAGE}
          </ThemedText>
        </View>
      ) : searchError ? (
        <View style={[styles.section, compact && compactStyles.section]}>
          <ThemedText testID="custom-product-search-error" style={styles.errorText}>
            {formatApiError(searchError, 'Could not search products.')}
          </ThemedText>
        </View>
      ) : (
        <View style={[styles.section, compact && compactStyles.section]} testID="custom-product-results">
          {results.map((result) => (
            <TouchableOpacity
              key={result.id}
              testID={`custom-product-result-${result.id}`}
              style={[styles.resultRow, { borderColor: colors.icon + '22' }]}
              onPress={() => router.push({ pathname: '/(app)/product/[id]', params: { id: result.id } })}
            >
              <View style={styles.resultBody}>
                <ThemedText style={styles.resultName}>{result.name}</ThemedText>
                {result.brand ? (
                  <ThemedText style={styles.resultBrand}>{result.brand}</ThemedText>
                ) : null}
                {result.unverified ? (
                  <ThemedText
                    testID={`custom-product-result-unverified-${result.id}`}
                    style={[styles.resultUnverified, { color: colors.tint }]}
                  >
                    🔎 Needs review
                  </ThemedText>
                ) : null}
              </View>
            </TouchableOpacity>
          ))}
          {searchHasMore ? (
            <TouchableOpacity
              testID="custom-product-load-more"
              style={styles.secondaryButton}
              onPress={searchLoadMore}
              disabled={searchLoadingMore}
            >
              {searchLoadingMore ? (
                <ActivityIndicator size="small" color={colors.tint} />
              ) : (
                <Text style={[styles.secondaryButtonText, { color: colors.tint }]}>Load more</Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      )}

      {canOfferCreateAction ? (
        <View style={[styles.section, compact && compactStyles.section]}>
          <TouchableOpacity
            testID="custom-product-create"
            style={[styles.button, { backgroundColor: colors.tint }]}
            onPress={handleCreatePress}
          >
            <Text style={[styles.buttonText, { color: colors.background }]}>
              Create &quot;{trimmedQuery}&quot;
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
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
  section: {
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 12,
  },
  icon: {
    fontSize: 48,
  },
  title: {
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    opacity: 0.75,
    lineHeight: 20,
  },
  field: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 13,
    opacity: 0.7,
    letterSpacing: 0.3,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  loadingRow: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  resultRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  resultBody: {
    gap: 2,
  },
  resultName: {
    fontSize: 15,
    fontWeight: '600',
  },
  resultBrand: {
    fontSize: 13,
    opacity: 0.6,
  },
  resultUnverified: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  photoPreview: {
    width: '100%',
    height: 180,
    borderRadius: 12,
  },
  photoRow: {
    flexDirection: 'row',
    gap: 10,
  },
  photoBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  photoBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  button: {
    alignSelf: 'stretch',
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
  secondaryButton: {
    alignSelf: 'stretch',
    padding: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  errorText: {
    color: '#e05c5c',
    fontSize: 13,
  },
});

/**
 * Tightened vertical spacing applied when `useFitToScreen()` reports `compact`
 * (P5-006 FE Fixes convention). Vertical margins/padding/gaps only.
 */
const compactStyles = StyleSheet.create({
  scrollContent: {
    paddingBottom: SPACING_COMPACT.screenBottom,
  },
  section: {
    paddingTop: SPACING_COMPACT.sectionPaddingV,
    gap: SPACING_COMPACT.sectionGap,
  },
  button: {
    marginTop: SPACING_COMPACT.tightGap,
  },
});
