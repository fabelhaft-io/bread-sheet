import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  BARCODE_MAX_DIGITS,
  BARCODE_MIN_DIGITS,
  sanitizeBarcodeInput,
  stripBarcodeSeparators,
  validateBarcode,
} from '@/features/products/barcode';

type Props = {
  visible: boolean;
  onClose: () => void;
  /**
   * Pre-fills the field — used when a scan produced something the server would
   * reject, so the user corrects a code rather than retyping it (P6-006).
   */
  initialValue?: string;
  /**
   * Overrides the default navigation. The product screen passes `router.replace`
   * semantics here so correcting a bad code does not stack a second product
   * screen on top of the broken one.
   */
  onSubmit?: (barcode: string) => void;
  /** Replaces the default explanatory line, e.g. on the invalid-scan path. */
  subtitle?: string;
};

/**
 * Manual barcode entry (TICKET-P6-006).
 *
 * Before this, the only route into the Add Product flow was the 404 branch of a
 * *successfully scanned* barcode — a damaged label, an unsupported symbology or
 * a device without a camera left the user with no way in. The sheet lands on
 * `/(app)/product/<code>`, which is exactly where a scan lands, so every
 * downstream state (found, pending review, 404 "add this product", the P5-001
 * anonymous sign-up gate) is reached identically.
 *
 * Validation is client-side and mirrors the server's `^\d{8,13}$` so the user
 * never sees a raw `400 Invalid barcode format`.
 */
export function ManualBarcodeSheet({
  visible,
  onClose,
  initialValue = '',
  onSubmit,
  subtitle,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="manual-barcode-sheet"
    >
      {/*
        Mounted only while open and keyed on the seed, so the field state is
        seeded from props at mount instead of being re-synced by an effect:
        a pre-filled bad scan is per-opening state, and a value left over from
        a previous opening would be confusing.
      */}
      {visible ? (
        <SheetBody
          key={initialValue}
          onClose={onClose}
          initialValue={initialValue}
          onSubmit={onSubmit}
          subtitle={subtitle}
        />
      ) : null}
    </Modal>
  );
}

function SheetBody({
  onClose,
  initialValue,
  onSubmit,
  subtitle,
}: Omit<Props, 'visible' | 'initialValue'> & { initialValue: string }) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const router = useRouter();

  const [value, setValue] = useState(() => sanitizeBarcodeInput(initialValue));
  // Errors appear on submit, not on the first keystroke — a half-typed code is
  // not a mistake, and flagging it as one while the user is still typing reads
  // as the field arguing with them.
  const [touched, setTouched] = useState(false);

  const result = validateBarcode(value);
  const error = touched && !result.valid ? result.message : null;

  const handleSubmit = () => {
    setTouched(true);
    if (!result.valid) return;
    const { barcode } = result;
    onClose();
    if (onSubmit) onSubmit(barcode);
    else router.push(`/(app)/product/${barcode}`);
  };

  return (
    <KeyboardAvoidingView
      style={styles.backdrop}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Tapping the dimmed area dismisses, matching every other sheet. */}
      <Pressable
        testID="manual-barcode-backdrop"
        style={StyleSheet.absoluteFill}
        onPress={onClose}
      />

      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={styles.grabber} />

        <Text style={[styles.title, { color: colors.text }]}>Enter barcode</Text>
        <Text style={[styles.subtitle, { color: colors.icon }]}>
          {subtitle ??
            `Type the ${BARCODE_MIN_DIGITS}–${BARCODE_MAX_DIGITS} digit number printed under the barcode.`}
        </Text>

        <TextInput
          testID="manual-barcode-input"
          style={[
            styles.input,
            {
              color: colors.text,
              borderColor: error ? '#c0392b' : colors.icon + '55',
            },
          ]}
          value={value}
          onChangeText={(text) => setValue(stripBarcodeSeparators(text))}
          keyboardType="number-pad"
          inputMode="numeric"
          autoFocus
          // One over the maximum: a 14th character is how the user discovers
          // the code is too long, rather than the field swallowing it silently.
          maxLength={BARCODE_MAX_DIGITS + 1}
          placeholder="4006381333931"
          placeholderTextColor={colors.icon + '77'}
          returnKeyType="go"
          onSubmitEditing={handleSubmit}
          accessibilityLabel="Barcode number"
        />

        {error ? (
          <Text testID="manual-barcode-error" style={styles.error}>
            {error}
          </Text>
        ) : (
          <Text style={[styles.counter, { color: colors.icon }]}>
            {value.length}/{BARCODE_MAX_DIGITS} digits
          </Text>
        )}

        <TouchableOpacity
          testID="manual-barcode-submit"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={handleSubmit}
        >
          <Text style={[styles.buttonText, { color: colors.background }]}>Look up product</Text>
        </TouchableOpacity>

        <TouchableOpacity testID="manual-barcode-cancel" style={styles.cancel} onPress={onClose}>
          <Text style={[styles.cancelText, { color: colors.icon }]}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 32,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    gap: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#8E8E9355',
    marginBottom: 10,
  },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 13, lineHeight: 18 },
  input: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 20,
    letterSpacing: 2,
  },
  error: { fontSize: 13, color: '#c0392b', fontWeight: '500' },
  counter: { fontSize: 12 },
  button: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  cancel: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { fontSize: 15 },
});

export default ManualBarcodeSheet;
