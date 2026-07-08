import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSession } from '@/hooks/use-session';
import { ApiError, api } from '@/lib/api';
import { formatApiError } from '@/lib/format-error';
import { log } from '@/lib/log';
import { supabase } from '@/lib/supabase';

import {
  correctProduct,
  proposeProductEdit,
  uploadProductImage,
} from '@/features/products/api';
import {
  buildCorrectionPayload,
  buildEditChanges,
  formHasChanges,
  productToFormValues,
  validateFormValues,
  type EditFormField,
  type EditFormValues,
} from '@/features/products/edit-form';
import { captureImage, type CaptureSource } from '@/features/products/image-picker';
import {
  ImageTooLargeError,
  processCaptureForUpload,
} from '@/features/products/image-processing';
import type { ProductDetail } from '@/features/products/types';

/**
 * TICKET-P5-006 — Edit Product screen.
 *
 * Same field layout as Add Product, but every field starts pre-populated with
 * the current product values and the barcode is read-only. The submit path
 * depends on the product status:
 *   - PENDING_REVIEW → PATCH /products/:barcode (in-place correction; the
 *     review cycle restarts and the caller becomes the submitter)
 *   - VERIFIED       → POST /products/:barcode/edits (peer-reviewed proposal;
 *     only the changed fields are sent)
 *
 * Submitting unchanged data is blocked client-side (button disabled).
 * Anonymous users never reach this screen (the entry point is hidden), but the
 * signup gate below is defence-in-depth.
 */
export default function EditProductScreen() {
  const { barcode } = useLocalSearchParams<{ barcode: string }>();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { session, isAnonymous } = useSession();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [initialForm, setInitialForm] = useState<EditFormValues | null>(null);
  const [form, setForm] = useState<EditFormValues | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<EditFormField, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Photo replacement (optional): a new photo is uploaded at capture time so
  // the plausibility gate can reject it immediately — same as Add Product.
  const [newPhotoUri, setNewPhotoUri] = useState<string | null>(null);
  const [newImageKey, setNewImageKey] = useState<string | null>(null);
  const [photoProcessing, setPhotoProcessing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || isAnonymous) return;
    let cancelled = false;
    api
      .get<ProductDetail>(`/api/products/${barcode}`)
      .then((data) => {
        if (cancelled) return;
        setProduct(data);
        const values = productToFormValues(data);
        setInitialForm(values);
        setForm(values);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(formatApiError(err, 'Could not load this product. Please try again.'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [barcode, session, isAnonymous]);

  const isCorrection = product?.status === 'PENDING_REVIEW' || product?.unverified === true;

  const hasChanges = useMemo(() => {
    if (!initialForm || !form) return false;
    return formHasChanges(initialForm, form, newImageKey);
  }, [initialForm, form, newImageKey]);

  const handleReplacePhoto = useCallback(
    async (source: CaptureSource) => {
      setPhotoError(null);
      try {
        const { uri } = await captureImage(source);
        if (!uri) return;
        setPhotoProcessing(true);
        const processed = await processCaptureForUpload(uri, 'product');

        const {
          data: { session: currentSession },
        } = await supabase.auth.getSession();
        const authHeader = currentSession ? `Bearer ${currentSession.access_token}` : null;

        const uploaded = await uploadProductImage(processed.uri, 'product', authHeader);
        setNewPhotoUri(processed.uri);
        setNewImageKey(uploaded.imageKey);
      } catch (err) {
        if (err instanceof ImageTooLargeError) {
          setPhotoError(err.message);
        } else if (err instanceof ApiError && err.status === 422) {
          // Plausibility rejection — keep the existing photo, surface the reason.
          setPhotoError(err.message);
          setNewPhotoUri(null);
          setNewImageKey(null);
        } else {
          log.error(`[edit-product] photo replace failed source=${source}`, err);
          setPhotoError('Could not use that photo. Please try again.');
        }
      } finally {
        setPhotoProcessing(false);
      }
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    if (!form || !initialForm || !hasChanges || submitting) return;
    setSubmitError(null);

    const errors = validateFormValues(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    try {
      if (isCorrection) {
        await correctProduct(barcode, buildCorrectionPayload(form, newImageKey));
        Alert.alert('Thanks!', 'Your correction was saved — the review restarts from zero.');
      } else {
        const changes = buildEditChanges(initialForm, form, newImageKey);
        if (!changes) return; // unreachable — hasChanges gates the button
        await proposeProductEdit(barcode, changes);
        Alert.alert('Thanks!', 'Your edit was submitted for peer review.');
      }
      router.replace({ pathname: '/(app)/product/[barcode]', params: { barcode } });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        const code = (err.body as { error?: string } | undefined)?.error;
        setSubmitError(
          code === 'edit_pending'
            ? 'Another edit for this product is already under review.'
            : code === 'product_verified'
              ? 'This product has been verified in the meantime — please reload and propose an edit instead.'
              : formatApiError(err, 'Could not submit your changes. Please try again.'),
        );
      } else if (err instanceof ApiError && err.status === 422) {
        const body = err.body as { reason?: string; field?: EditFormField } | undefined;
        if (body?.field && form[body.field] !== undefined) {
          setFieldErrors({ [body.field]: body.reason ?? err.message });
        } else {
          setSubmitError(body?.reason ?? formatApiError(err, 'Could not submit your changes.'));
        }
      } else {
        setSubmitError(formatApiError(err, 'Could not submit your changes. Please try again.'));
      }
    } finally {
      setSubmitting(false);
    }
  }, [form, initialForm, hasChanges, submitting, isCorrection, barcode, newImageKey, router]);

  // ─── Anonymous gate (defence-in-depth; the entry point is already hidden) ──
  if (!session || isAnonymous) {
    return (
      <ThemedView style={styles.center} testID="edit-product-anon-gate">
        <Text style={styles.icon}>🔒</Text>
        <ThemedText type="title" style={styles.title}>
          Sign up to edit products
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

  if (loading) {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator size="large" color={colors.tint} />
      </ThemedView>
    );
  }

  if (loadError || !product || !form) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText style={styles.errorText}>{loadError ?? 'Not found.'}</ThemedText>
      </ThemedView>
    );
  }

  const set = (key: EditFormField, value: string) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const photoShown = newPhotoUri ?? product.image;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} testID="edit-product-screen">
        <View style={styles.section}>
          <ThemedText type="subtitle" style={styles.sectionTitle}>
            {isCorrection ? 'Correct this submission' : 'Edit product'}
          </ThemedText>
          <ThemedText style={styles.explanation}>
            {isCorrection
              ? 'This product is still under review. Your correction replaces the submitted data and restarts the peer review.'
              : 'Your changes will be applied after two other users confirm them.'}
          </ThemedText>

          {/* Current / replacement photo */}
          {photoShown ? (
            <Image source={{ uri: photoShown }} style={styles.hero} resizeMode="cover" />
          ) : null}
          <View style={styles.photoRow}>
            {photoProcessing ? (
              <ActivityIndicator color={colors.tint} testID="photo-processing" />
            ) : (
              <>
                <TouchableOpacity
                  testID="replace-photo-camera"
                  style={[styles.photoBtn, { borderColor: colors.tint }]}
                  onPress={() => handleReplacePhoto('camera')}
                >
                  <Text style={[styles.photoBtnText, { color: colors.tint }]}>
                    📷 Replace photo
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="replace-photo-library"
                  style={[styles.photoBtn, { borderColor: colors.tint }]}
                  onPress={() => handleReplacePhoto('library')}
                >
                  <Text style={[styles.photoBtnText, { color: colors.tint }]}>🖼 Library</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
          {photoError ? (
            <ThemedText style={styles.errorText} testID="photo-error">
              {photoError}
            </ThemedText>
          ) : null}

          {/* Barcode — read-only by spec */}
          <Field
            label="Barcode"
            testID="field-barcode"
            value={barcode}
            onChangeText={() => {}}
            readOnly
            colors={colors}
          />
          <Field
            label="Name *"
            testID="field-name"
            value={form.name}
            onChangeText={(v) => set('name', v)}
            error={fieldErrors.name}
            colors={colors}
          />
          <Field
            label="Brand"
            testID="field-brand"
            value={form.brand}
            onChangeText={(v) => set('brand', v)}
            colors={colors}
          />
          <Field
            label="Generic name"
            testID="field-genericName"
            value={form.genericName}
            onChangeText={(v) => set('genericName', v)}
            colors={colors}
          />
          <Field
            label="Energy (kcal per 100 g)"
            testID="field-energyKcal"
            value={form.energyKcal}
            onChangeText={(v) => set('energyKcal', v)}
            keyboardType="decimal-pad"
            error={fieldErrors.energyKcal}
            colors={colors}
          />
          <Field
            label="Fat (g)"
            testID="field-fat"
            value={form.fat}
            onChangeText={(v) => set('fat', v)}
            keyboardType="decimal-pad"
            error={fieldErrors.fat}
            colors={colors}
          />
          <Field
            label="of which saturates (g)"
            testID="field-saturatedFat"
            value={form.saturatedFat}
            onChangeText={(v) => set('saturatedFat', v)}
            keyboardType="decimal-pad"
            error={fieldErrors.saturatedFat}
            colors={colors}
          />
          <Field
            label="Carbohydrates (g)"
            testID="field-carbohydrates"
            value={form.carbohydrates}
            onChangeText={(v) => set('carbohydrates', v)}
            keyboardType="decimal-pad"
            error={fieldErrors.carbohydrates}
            colors={colors}
          />
          <Field
            label="of which sugars (g)"
            testID="field-sugars"
            value={form.sugars}
            onChangeText={(v) => set('sugars', v)}
            keyboardType="decimal-pad"
            error={fieldErrors.sugars}
            colors={colors}
          />
          <Field
            label="Protein (g)"
            testID="field-protein"
            value={form.protein}
            onChangeText={(v) => set('protein', v)}
            keyboardType="decimal-pad"
            error={fieldErrors.protein}
            colors={colors}
          />
          <Field
            label="Salt (g)"
            testID="field-salt"
            value={form.salt}
            onChangeText={(v) => set('salt', v)}
            keyboardType="decimal-pad"
            error={fieldErrors.salt}
            colors={colors}
          />
          <Field
            label="Serving size"
            testID="field-servingSize"
            value={form.servingSize}
            onChangeText={(v) => set('servingSize', v)}
            colors={colors}
          />
          <Field
            label="Ingredients"
            testID="field-ingredients"
            value={form.ingredients}
            onChangeText={(v) => set('ingredients', v)}
            multiline
            colors={colors}
          />

          {submitError ? (
            <ThemedText style={styles.errorText} testID="submit-error">
              {submitError}
            </ThemedText>
          ) : null}

          <TouchableOpacity
            testID="submit-edit"
            style={[
              styles.button,
              { backgroundColor: colors.tint },
              (!hasChanges || submitting) && styles.buttonDisabled,
            ]}
            disabled={!hasChanges || submitting}
            onPress={handleSubmit}
          >
            {submitting ? (
              <ActivityIndicator color={colors.background} size="small" />
            ) : (
              <Text style={[styles.buttonText, { color: colors.background }]}>
                {isCorrection ? 'Save correction' : 'Submit for review'}
              </Text>
            )}
          </TouchableOpacity>
          {!hasChanges ? (
            <ThemedText style={styles.noChangesHint} testID="no-changes-hint">
              Change at least one field to submit.
            </ThemedText>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType,
  multiline,
  readOnly,
  error,
  colors,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: 'default' | 'decimal-pad';
  multiline?: boolean;
  readOnly?: boolean;
  error?: string;
  colors: (typeof Colors)['light'];
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <ThemedText style={styles.fieldLabel}>{label}</ThemedText>
      <TextInput
        testID={testID}
        editable={!readOnly}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        multiline={multiline}
        style={[
          styles.fieldInput,
          multiline && styles.fieldInputMultiline,
          readOnly && styles.fieldInputReadOnly,
          {
            color: colors.text,
            borderColor: error ? '#e05c5c' : colors.icon + '55',
            backgroundColor: colors.icon + '11',
          },
        ]}
        placeholderTextColor={colors.icon}
      />
      {error ? (
        <ThemedText style={styles.fieldError} testID={`${testID}-error`}>
          {error}
        </ThemedText>
      ) : null}
    </View>
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
    padding: 20,
    gap: 12,
  },
  sectionTitle: {
    marginBottom: 2,
  },
  explanation: {
    fontSize: 13,
    opacity: 0.7,
    lineHeight: 18,
  },
  hero: {
    width: '100%',
    height: 200,
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
  field: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 12,
    opacity: 0.6,
    letterSpacing: 0.3,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
  },
  fieldInputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  fieldInputReadOnly: {
    opacity: 0.5,
  },
  fieldError: {
    color: '#e05c5c',
    fontSize: 12,
  },
  button: {
    alignSelf: 'stretch',
    marginTop: 8,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '700',
  },
  noChangesHint: {
    fontSize: 12,
    opacity: 0.5,
    textAlign: 'center',
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
