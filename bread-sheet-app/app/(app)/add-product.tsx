import { useCallback, useMemo, useState } from 'react';
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
import { ApiError } from '@/lib/api';
import { supabase } from '@/lib/supabase';

import { submitProduct, uploadProductImage } from '@/features/products/api';
import { extractFromLabelImage } from '@/features/products/extract';
import { captureImage, type CaptureSource } from '@/features/products/image-picker';
import {
  ImageTooLargeError,
  processCaptureForUpload,
} from '@/features/products/image-processing';
import type { ExtractedLabel, ProductSubmission } from '@/features/products/types';

/**
 * TICKET-P5-002 — Add Product, camera-assisted + manual entry.
 *
 * Multi-step flow:
 *   1. Photos        — two capture slots (product display + nutritional label)
 *   2. Extraction    — on-device OCR, then text-or-image backend structuring
 *   3. Review & fill — three modes (manual / pre-fill+edit / accept-all)
 *   4. Submit        — uploads product photo, POSTs JSON submission
 *
 * Business logic is in `features/products/`. This file only orchestrates
 * state transitions and renders the UI.
 *
 * Access control: anonymous users see the signup prompt from TICKET-P5-001,
 * not the form. The deep-link `returnTo` is preserved so they land back here
 * after registration.
 */

type Step = 'photos' | 'extracting' | 'review' | 'submitting';
type FillMode = 'manual' | 'prefill' | 'accept';

interface FormState {
  name: string;
  brand: string;
  genericName: string;
  energyKcal: string;
  fat: string;
  saturatedFat: string;
  carbohydrates: string;
  sugars: string;
  protein: string;
  salt: string;
  servingSize: string;
  ingredients: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  brand: '',
  genericName: '',
  energyKcal: '',
  fat: '',
  saturatedFat: '',
  carbohydrates: '',
  sugars: '',
  protein: '',
  salt: '',
  servingSize: '',
  ingredients: '',
};

/**
 * Front-of-pack identity read off the product photo by the backend plausibility
 * check (P5-005). Independent of (and more reliable than) the label OCR for
 * name/brand, so it wins those fields — see `applyPhotoSuggestion`.
 */
interface PhotoSuggestion {
  name: string | null;
  brand: string | null;
  genericName: string | null;
}

/**
 * Flatten an `ExtractedLabel` response (numbers + nulls) into the text-input
 * form state. `null` becomes `''` so `<TextInput>` receives a controlled
 * value. `0` is preserved so "zero sugar" products don't lose their data.
 */
function hydrateForm(extracted: ExtractedLabel): FormState {
  const toText = (v: string | number | null) =>
    v === null || v === undefined ? '' : String(v);
  return {
    name: extracted.name ?? '',
    brand: extracted.brand ?? '',
    genericName: extracted.genericName ?? '',
    energyKcal: toText(extracted.energyKcal),
    fat: toText(extracted.fat),
    saturatedFat: toText(extracted.saturatedFat),
    carbohydrates: toText(extracted.carbohydrates),
    sugars: toText(extracted.sugars),
    protein: toText(extracted.protein),
    salt: toText(extracted.salt),
    servingSize: extracted.servingSize ?? '',
    ingredients: extracted.ingredients ?? '',
  };
}

/**
 * Overlay the product-photo suggestions onto a form, with the photo winning
 * name/brand/genericName. The label-derived value is kept only where the photo
 * had nothing to offer. Applied across all fill modes because the front-of-pack
 * identity is reliable regardless of how the label was read.
 */
function applyPhotoSuggestion(form: FormState, suggestion: PhotoSuggestion | null): FormState {
  if (!suggestion) return form;
  return {
    ...form,
    name: suggestion.name ?? form.name,
    brand: suggestion.brand ?? form.brand,
    genericName: suggestion.genericName ?? form.genericName,
  };
}

function parseNumeric(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export default function AddProductScreen() {
  const { barcode } = useLocalSearchParams<{ barcode?: string }>();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { isAnonymous, session } = useSession();

  // ─── Anonymous-user guard (defence-in-depth for P5-001) ───────────────
  if (!session || isAnonymous) {
    return (
      <ThemedView style={styles.center} testID="add-product-anon-gate">
        <Text style={styles.icon}>🔒</Text>
        <ThemedText type="title" style={styles.title}>
          Sign up to add products
        </ThemedText>
        <ThemedText style={styles.body}>
          You need an account to contribute missing products.
        </ThemedText>
        <TouchableOpacity
          testID="add-product-signup"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={() =>
            router.push({
              pathname: '/(auth)/signup',
              params: barcode ? { returnTo: `/product/${barcode}` } : {},
            })
          }
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Sign up</Text>
        </TouchableOpacity>
      </ThemedView>
    );
  }

  return (
    <AddProductFlow
      key={barcode ?? 'no-barcode'}
      barcode={barcode}
      colors={colors}
      onSubmitted={(b) =>
        router.replace({ pathname: '/(app)/product/[barcode]', params: { barcode: b } })
      }
    />
  );
}

/**
 * Split from the default export so the anonymous guard short-circuits before
 * any of the form state is initialised. Keeping the `barcode` in a `key`
 * above also resets the whole flow if the user navigates here with a
 * different barcode param mid-session.
 */
function AddProductFlow({
  barcode,
  colors,
  onSubmitted,
}: {
  barcode: string | undefined;
  colors: (typeof Colors)['light'];
  onSubmitted: (barcode: string) => void;
}) {
  // ─── Flow state ───────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>('photos');
  const [productPhotoUri, setProductPhotoUri] = useState<string | null>(null);
  // S3 URL returned by the upload-image endpoint at capture time; reused at
  // submit so the photo is uploaded (and plausibility-checked) exactly once.
  const [productImageUrl, setProductImageUrl] = useState<string | null>(null);
  // Front-of-pack name/brand/genericName read off the product photo.
  const [suggestion, setSuggestion] = useState<PhotoSuggestion | null>(null);
  const [labelPhotoUri, setLabelPhotoUri] = useState<string | null>(null);
  const [processingSlot, setProcessingSlot] = useState<'product' | 'label' | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractedLabel | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [barcodeInput, setBarcodeInput] = useState(barcode ?? '');
  const [fillMode, setFillMode] = useState<FillMode>('manual');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ─── Photos step handlers ─────────────────────────────────────────────
  const handleCapture = useCallback(
    async (slot: 'product' | 'label', source: CaptureSource) => {
      setCaptureError(null);
      try {
        const { uri } = await captureImage(source);
        if (!uri) return;
        // Resize/compress can take a few seconds;
        // show the in-slot spinner for its duration so the slot isn't left blank.
        setProcessingSlot(slot);
        const processed = await processCaptureForUpload(uri, slot);
        if (slot === 'product') {
          // Upload the product photo now (not at submit) so the plausibility
          // check can reject a bad photo immediately and the front-of-pack
          // name/brand suggestions are available before the review step.
          const {
            data: { session: currentSession },
          } = await supabase.auth.getSession();
          const authHeader = currentSession
            ? `Bearer ${currentSession.access_token}`
            : null;

          const uploaded = await uploadProductImage(processed.uri, 'product', authHeader);
          setProductPhotoUri(processed.uri);
          setProductImageUrl(uploaded.url);
          setSuggestion({
            name: uploaded.name,
            brand: uploaded.brand,
            genericName: uploaded.genericName,
          });
        } else {
          setLabelPhotoUri(processed.uri);
        }
      } catch (err) {
        if (err instanceof ImageTooLargeError) {
          setCaptureError(err.message);
        } else if (err instanceof ApiError && err.status === 422) {
          // Plausibility rejection (not a product / blurry / abusive). Surface the
          // reason and clear any prior product photo so the user must re-capture.
          setCaptureError(err.message);
          if (slot === 'product') {
            setProductPhotoUri(null);
            setProductImageUrl(null);
            setSuggestion(null);
          }
        } else {
          setCaptureError('Could not use that photo. Please try again.');
        }
      } finally {
        setProcessingSlot(null);
      }
    },
    [],
  );

  const startExtraction = useCallback(async () => {
    if (!labelPhotoUri) return;
    setStep('extracting');
    setExtractionError(null);

    const outcome = await extractFromLabelImage(labelPhotoUri);
    if (outcome.kind === 'ok') {
      setExtracted(outcome.data);
      setFillMode(outcome.data.confidence === 'low' ? 'manual' : 'prefill');
      setForm(
        applyPhotoSuggestion(
          outcome.data.confidence === 'low' ? EMPTY_FORM : hydrateForm(outcome.data),
          suggestion,
        ),
      );
    } else {
      setExtracted(null);
      setFillMode('manual');
      setForm(applyPhotoSuggestion(EMPTY_FORM, suggestion));
      if (outcome.reason === 'backend_error') {
        setExtractionError(
          'We could not read the label. You can still fill in the details by hand.',
        );
      }
    }
    setStep('review');
  }, [labelPhotoUri, suggestion]);

  const skipExtraction = useCallback(() => {
    setExtracted(null);
    setFillMode('manual');
    setForm(applyPhotoSuggestion(EMPTY_FORM, suggestion));
    setExtractionError(null);
    setStep('review');
  }, [suggestion]);

  // ─── Fill-mode switching ──────────────────────────────────────────────
  const applyFillMode = useCallback(
    (mode: FillMode) => {
      setFillMode(mode);
      if (mode === 'manual') {
        setForm(applyPhotoSuggestion(EMPTY_FORM, suggestion));
      } else if ((mode === 'prefill' || mode === 'accept') && extracted) {
        setForm(applyPhotoSuggestion(hydrateForm(extracted), suggestion));
      }
    },
    [extracted, suggestion],
  );

  // ─── Submit ───────────────────────────────────────────────────────────
  const formIsReadOnly = fillMode === 'accept';
  const canSubmit = useMemo(() => {
    if (!productPhotoUri) return false;
    if (!form.name.trim()) return false;
    if (!barcodeInput.trim()) return false;
    return true;
  }, [productPhotoUri, form.name, barcodeInput]);

  const handleSubmit = useCallback(async () => {
    if (!productPhotoUri || !canSubmit) return;
    setSubmitError(null);
    setFieldErrors({});

    // Required-field validation (P5-002 acceptance criteria).
    const errors: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) errors.name = 'Product name is required.';
    const numericFields = [
      'energyKcal',
      'fat',
      'saturatedFat',
      'carbohydrates',
      'sugars',
      'protein',
      'salt',
    ] as const;
    for (const field of numericFields) {
      if (form[field] !== '' && parseNumeric(form[field]) === null) {
        errors[field] = 'Must be a positive number.';
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    if (!productImageUrl) {
      setSubmitError('The product photo is still uploading. Please wait a moment and try again.');
      return;
    }

    setStep('submitting');
    try {
      const payload: ProductSubmission = {
        barcode: barcodeInput.trim(),
        name: form.name.trim(),
        brand: form.brand.trim() || null,
        genericName: form.genericName.trim() || null,
        energyKcal: parseNumeric(form.energyKcal),
        fat: parseNumeric(form.fat),
        saturatedFat: parseNumeric(form.saturatedFat),
        carbohydrates: parseNumeric(form.carbohydrates),
        sugars: parseNumeric(form.sugars),
        protein: parseNumeric(form.protein),
        salt: parseNumeric(form.salt),
        servingSize: form.servingSize.trim() || null,
        productImageUrl,
        ingredients: form.ingredients.trim() || null,
      };

      const result = await submitProduct(payload);

      // Alert is used for the "under review" toast — this is a skeleton; a
      // proper toast component is a nice-to-have in a follow-up.
      Alert.alert('Thanks!', 'Your product is under review.');
      onSubmitted(result.barcode);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 422) {
        // Plausibility rejection — surface the reason inline.
        const reason =
          (err.body as { reason?: string; field?: keyof FormState } | undefined)?.reason ??
          err.message;
        const field = (err.body as { field?: keyof FormState } | undefined)?.field;
        if (field) {
          setFieldErrors({ [field]: reason } as Partial<Record<keyof FormState, string>>);
        } else {
          setSubmitError(reason);
        }
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Submission failed.');
      }
      setStep('review');
    }
  }, [productPhotoUri, productImageUrl, canSubmit, form, barcodeInput, onSubmitted]);

  // ─── Rendering ────────────────────────────────────────────────────────
  if (step === 'extracting') {
    return (
      <ThemedView style={styles.center} testID="add-product-extracting">
        <ActivityIndicator size="large" color={colors.tint} />
        <ThemedText style={styles.body}>Reading the label…</ThemedText>
      </ThemedView>
    );
  }

  if (step === 'submitting') {
    return (
      <ThemedView style={styles.center} testID="add-product-submitting">
        <ActivityIndicator size="large" color={colors.tint} />
        <ThemedText style={styles.body}>Submitting…</ThemedText>
      </ThemedView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        testID="add-product-screen"
      >
        <View style={styles.infoSection}>
          <ThemedText type="title">Add a product</ThemedText>
          <ThemedText style={styles.body}>
            Take two photos — a product shot for the listing and a nutritional
            label for the details. We&apos;ll do our best to read the label
            for you.
          </ThemedText>
        </View>

        {/* ── Photos step ─────────────────────────────────────────── */}
        {step === 'photos' ? (
          <View style={styles.section}>
            <PhotoSlot
              label="Product photo"
              hint="Front of packaging — what people will see in listings."
              uri={productPhotoUri}
              processing={processingSlot === 'product'}
              colors={colors}
              testID="product-photo-slot"
              onPickFromCamera={() => handleCapture('product', 'camera')}
              onPickFromLibrary={() => handleCapture('product', 'library')}
            />
            <PhotoSlot
              label="Nutritional label photo"
              hint="Used to read the ingredients & nutrition table. Never leaves the device unless we need to."
              uri={labelPhotoUri}
              processing={processingSlot === 'label'}
              colors={colors}
              testID="label-photo-slot"
              onPickFromCamera={() => handleCapture('label', 'camera')}
              onPickFromLibrary={() => handleCapture('label', 'library')}
            />
            {captureError ? (
              <ThemedText style={styles.errorText} testID="capture-error">
                {captureError}
              </ThemedText>
            ) : null}
            <TouchableOpacity
              testID="photos-continue"
              style={[
                styles.button,
                { backgroundColor: colors.tint },
                !labelPhotoUri && styles.buttonDisabled,
              ]}
              disabled={!labelPhotoUri}
              onPress={startExtraction}
            >
              <Text style={[styles.buttonText, { color: colors.background }]}>
                Read the label
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="photos-skip"
              style={styles.secondaryButton}
              onPress={skipExtraction}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.tint }]}>
                Skip — I&apos;ll fill it in by hand
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* ── Review step ─────────────────────────────────────────── */}
        {step === 'review' ? (
          <ReviewStep
            form={form}
            setForm={setForm}
            barcode={barcodeInput}
            setBarcode={setBarcodeInput}
            fillMode={fillMode}
            applyFillMode={applyFillMode}
            extracted={extracted}
            readOnly={formIsReadOnly}
            colors={colors}
            fieldErrors={fieldErrors}
            extractionError={extractionError}
            productPhotoUri={productPhotoUri}
          />
        ) : null}

        {/* ── Submit ──────────────────────────────────────────────── */}
        {step === 'review' ? (
          <View style={styles.section}>
            {submitError ? (
              <ThemedText style={styles.errorText} testID="submit-error">
                {submitError}
              </ThemedText>
            ) : null}
            <TouchableOpacity
              testID="submit-product"
              style={[
                styles.button,
                { backgroundColor: colors.tint },
                !canSubmit && styles.buttonDisabled,
              ]}
              disabled={!canSubmit}
              onPress={handleSubmit}
            >
              <Text style={[styles.buttonText, { color: colors.background }]}>
                Submit product
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="back-to-photos"
              style={styles.secondaryButton}
              onPress={() => setStep('photos')}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.tint }]}>
                Back to photos
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Photo slot component ──────────────────────────────────────────────

function PhotoSlot({
  label,
  hint,
  uri,
  processing,
  colors,
  testID,
  onPickFromCamera,
  onPickFromLibrary,
}: {
  label: string;
  hint: string;
  uri: string | null;
  processing?: boolean;
  colors: (typeof Colors)['light'];
  testID: string;
  onPickFromCamera: () => void;
  onPickFromLibrary: () => void;
}) {
  return (
    <View style={styles.slot} testID={testID}>
      <ThemedText style={styles.slotLabel}>{label}</ThemedText>
      <ThemedText style={styles.slotHint}>{hint}</ThemedText>
      {processing ? (
        <View
          style={[styles.slotPlaceholder, styles.slotProcessing, { borderColor: colors.tint }]}
          testID={`${testID}-processing`}
        >
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={styles.slotProcessingText}>Processing photo…</ThemedText>
        </View>
      ) : uri ? (
        <Image source={{ uri }} style={styles.slotPreview} resizeMode="cover" />
      ) : (
        <View style={[styles.slotPlaceholder, { borderColor: colors.icon + '55' }]}>
          <Text style={styles.slotPlaceholderIcon}>📷</Text>
        </View>
      )}
      <View style={styles.slotButtonRow}>
        <TouchableOpacity
          style={[
            styles.slotButton,
            { borderColor: colors.tint },
            processing && styles.buttonDisabled,
          ]}
          onPress={onPickFromCamera}
          disabled={processing}
          testID={`${testID}-camera`}
        >
          <Text style={[styles.slotButtonText, { color: colors.tint }]}>Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.slotButton,
            { borderColor: colors.tint },
            processing && styles.buttonDisabled,
          ]}
          onPress={onPickFromLibrary}
          disabled={processing}
          testID={`${testID}-library`}
        >
          <Text style={[styles.slotButtonText, { color: colors.tint }]}>Library</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Review & fill step ────────────────────────────────────────────────

function ReviewStep({
  form,
  setForm,
  barcode,
  setBarcode,
  fillMode,
  applyFillMode,
  extracted,
  readOnly,
  colors,
  fieldErrors,
  extractionError,
  productPhotoUri,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  barcode: string;
  setBarcode: (v: string) => void;
  fillMode: FillMode;
  applyFillMode: (m: FillMode) => void;
  extracted: ExtractedLabel | null;
  readOnly: boolean;
  colors: (typeof Colors)['light'];
  fieldErrors: Partial<Record<keyof FormState, string>>;
  extractionError: string | null;
  productPhotoUri: string | null;
}) {
  const set = <K extends keyof FormState>(key: K, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <View style={styles.section}>
      {productPhotoUri ? (
        <Image source={{ uri: productPhotoUri }} style={styles.reviewHero} resizeMode="cover" />
      ) : null}
      <ThemedText type="subtitle" style={styles.sectionTitle}>
        Review the details
      </ThemedText>
      {extractionError ? (
        <ThemedText style={styles.warnText} testID="extraction-warning">
          {extractionError}
        </ThemedText>
      ) : null}

      {/* Fill-mode switcher — only offered when we actually have extracted data. */}
      {extracted ? (
        <View style={styles.modeRow} testID="fill-mode-row">
          <ModePill
            label="Manual"
            active={fillMode === 'manual'}
            onPress={() => applyFillMode('manual')}
            colors={colors}
            testID="fill-mode-manual"
          />
          <ModePill
            label="Pre-fill & edit"
            active={fillMode === 'prefill'}
            onPress={() => applyFillMode('prefill')}
            colors={colors}
            testID="fill-mode-prefill"
          />
          <ModePill
            label="Accept all"
            active={fillMode === 'accept'}
            onPress={() => applyFillMode('accept')}
            colors={colors}
            testID="fill-mode-accept"
          />
        </View>
      ) : null}

      <Field
        label="Barcode"
        testID="field-barcode"
        value={barcode}
        onChangeText={setBarcode}
        readOnly={readOnly}
        colors={colors}
      />
      <Field
        label="Name *"
        testID="field-name"
        value={form.name}
        onChangeText={(v) => set('name', v)}
        readOnly={readOnly}
        error={fieldErrors.name}
        colors={colors}
      />
      <Field
        label="Brand"
        testID="field-brand"
        value={form.brand}
        onChangeText={(v) => set('brand', v)}
        readOnly={readOnly}
        colors={colors}
      />
      <Field
        label="Generic name"
        testID="field-genericName"
        value={form.genericName}
        onChangeText={(v) => set('genericName', v)}
        readOnly={readOnly}
        colors={colors}
      />
      <Field
        label="Energy (kcal per 100 g)"
        testID="field-energyKcal"
        value={form.energyKcal}
        onChangeText={(v) => set('energyKcal', v)}
        keyboardType="decimal-pad"
        readOnly={readOnly}
        error={fieldErrors.energyKcal}
        colors={colors}
      />
      <Field
        label="Fat (g)"
        testID="field-fat"
        value={form.fat}
        onChangeText={(v) => set('fat', v)}
        keyboardType="decimal-pad"
        readOnly={readOnly}
        error={fieldErrors.fat}
        colors={colors}
      />
      <Field
        label="of which saturates (g)"
        testID="field-saturatedFat"
        value={form.saturatedFat}
        onChangeText={(v) => set('saturatedFat', v)}
        keyboardType="decimal-pad"
        readOnly={readOnly}
        error={fieldErrors.saturatedFat}
        colors={colors}
      />
      <Field
        label="Carbohydrates (g)"
        testID="field-carbohydrates"
        value={form.carbohydrates}
        onChangeText={(v) => set('carbohydrates', v)}
        keyboardType="decimal-pad"
        readOnly={readOnly}
        error={fieldErrors.carbohydrates}
        colors={colors}
      />
      <Field
        label="of which sugars (g)"
        testID="field-sugars"
        value={form.sugars}
        onChangeText={(v) => set('sugars', v)}
        keyboardType="decimal-pad"
        readOnly={readOnly}
        error={fieldErrors.sugars}
        colors={colors}
      />
      <Field
        label="Protein (g)"
        testID="field-protein"
        value={form.protein}
        onChangeText={(v) => set('protein', v)}
        keyboardType="decimal-pad"
        readOnly={readOnly}
        error={fieldErrors.protein}
        colors={colors}
      />
      <Field
        label="Salt (g)"
        testID="field-salt"
        value={form.salt}
        onChangeText={(v) => set('salt', v)}
        keyboardType="decimal-pad"
        readOnly={readOnly}
        error={fieldErrors.salt}
        colors={colors}
      />
      <Field
        label="Serving size"
        testID="field-servingSize"
        value={form.servingSize}
        onChangeText={(v) => set('servingSize', v)}
        readOnly={readOnly}
        colors={colors}
      />
      <Field
        label="Ingredients"
        testID="field-ingredients"
        value={form.ingredients}
        onChangeText={(v) => set('ingredients', v)}
        multiline
        readOnly={readOnly}
        colors={colors}
      />
    </View>
  );
}

function ModePill({
  label,
  active,
  onPress,
  colors,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  colors: (typeof Colors)['light'];
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      style={[
        styles.pill,
        { borderColor: colors.tint },
        active && { backgroundColor: colors.tint },
      ]}
      onPress={onPress}
    >
      <Text
        style={[
          styles.pillText,
          { color: active ? colors.background : colors.tint },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
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
  infoSection: {
    padding: 24,
    gap: 8,
  },
  section: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 12,
  },
  icon: {
    fontSize: 48,
  },
  title: {
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    opacity: 0.75,
    lineHeight: 22,
  },
  sectionTitle: {
    marginBottom: 4,
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
  secondaryButton: {
    alignSelf: 'stretch',
    padding: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  slot: {
    gap: 6,
  },
  slotLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
  slotHint: {
    fontSize: 12,
    opacity: 0.6,
    lineHeight: 16,
  },
  slotPreview: {
    width: '100%',
    height: 200,
    borderRadius: 12,
  },
  slotPlaceholder: {
    width: '100%',
    height: 200,
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotPlaceholderIcon: {
    fontSize: 48,
    opacity: 0.5,
  },
  slotProcessing: {
    borderStyle: 'solid',
    gap: 12,
  },
  slotProcessingText: {
    fontSize: 14,
    fontWeight: '600',
    opacity: 0.8,
  },
  slotButtonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  slotButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  slotButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  reviewHero: {
    width: '100%',
    height: 220,
    borderRadius: 12,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
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
    padding: 12,
    fontSize: 15,
  },
  fieldInputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  fieldInputReadOnly: {
    opacity: 0.7,
  },
  fieldError: {
    color: '#e05c5c',
    fontSize: 12,
    marginTop: 2,
  },
  errorText: {
    color: '#e05c5c',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
  },
  warnText: {
    color: '#a05a00',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
});
