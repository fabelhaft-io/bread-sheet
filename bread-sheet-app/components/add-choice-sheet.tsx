import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** "Scan or enter a barcode" — the existing P6-006 manual-barcode/scan path. */
  onPickBarcode: () => void;
  /** "Something with no barcode" — TICKET-P6-007's add-custom-product screen. */
  onPickCustom: () => void;
};

/**
 * TICKET-P6-007 — the Home tab's "＋" grew a second option. Before this
 * ticket it opened the P6-006 manual-barcode sheet directly; now it offers a
 * choice first, since not everything worth rating has a barcode (a cocktail,
 * a dish, loose-leaf tea).
 */
export function AddChoiceSheet({ visible, onClose, onPickBarcode, onPickCustom }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="add-choice-sheet"
    >
      {/* Mounted only while open, same convention as `ManualBarcodeSheet` —
          the content genuinely isn't in the tree while closed, rather than
          relying on the platform Modal's own visibility behaviour. */}
      {visible ? (
        <SheetBody onClose={onClose} onPickBarcode={onPickBarcode} onPickCustom={onPickCustom} />
      ) : null}
    </Modal>
  );
}

function SheetBody({ onClose, onPickBarcode, onPickCustom }: Omit<Props, 'visible'>) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  return (
    <View style={styles.backdrop}>
      <Pressable testID="add-choice-backdrop" style={StyleSheet.absoluteFill} onPress={onClose} />

      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={styles.grabber} />
        <Text style={[styles.title, { color: colors.text }]}>Add something</Text>

        <TouchableOpacity
          testID="add-choice-barcode"
          style={[styles.option, { borderColor: colors.tint }]}
          onPress={onPickBarcode}
        >
          <Text style={styles.optionIcon}>📷</Text>
          <View style={styles.optionBody}>
            <Text style={[styles.optionTitle, { color: colors.text }]}>
              Scan or enter a barcode
            </Text>
            <Text style={[styles.optionHint, { color: colors.icon }]}>
              A packaged product with a GTIN printed on it.
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          testID="add-choice-custom"
          style={[styles.option, { borderColor: colors.tint }]}
          onPress={onPickCustom}
        >
          <Text style={styles.optionIcon}>🍸</Text>
          <View style={styles.optionBody}>
            <Text style={[styles.optionTitle, { color: colors.text }]}>
              Something with no barcode
            </Text>
            <Text style={[styles.optionHint, { color: colors.icon }]}>
              A cocktail, a dish, loose-leaf tea — anything else worth rating.
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity testID="add-choice-cancel" style={styles.cancel} onPress={onClose}>
          <Text style={[styles.cancelText, { color: colors.icon }]}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
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
    gap: 10,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#8E8E9355',
    marginBottom: 10,
  },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  optionIcon: { fontSize: 28 },
  optionBody: { flex: 1, gap: 2 },
  optionTitle: { fontSize: 16, fontWeight: '600' },
  optionHint: { fontSize: 13, lineHeight: 18 },
  cancel: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { fontSize: 15 },
});

export default AddChoiceSheet;
