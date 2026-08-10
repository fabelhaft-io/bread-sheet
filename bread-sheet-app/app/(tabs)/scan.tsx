import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { ManualBarcodeSheet } from '@/components/manual-barcode-sheet';
import { isValidBarcode, sanitizeBarcodeInput } from '@/features/products/barcode';

/**
 * Symbologies the scanner accepts. The four retail codes were always here;
 * `itf14` (case packs) and `code128` (a lot of non-grocery goods) were added
 * with P6-006 — a code the camera refuses to read at all is indistinguishable
 * from a damaged label to the user, and both dead-ended before manual entry.
 * Anything that reads but fails `^\d{8,13}$` opens the manual sheet pre-filled.
 */
const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'itf14'] as const;

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const router = useRouter();
  const scanLock = useRef(false);
  const [torchOn, setTorchOn] = useState(false);
  const [scanningActive, setScanningActive] = useState(true);
  const [manualVisible, setManualVisible] = useState(false);
  // Pre-fill for the sheet: the digits of a code that scanned but is not a
  // barcode we can look up (P6-006).
  const [manualSeed, setManualSeed] = useState('');
  const [manualSubtitle, setManualSubtitle] = useState<string | undefined>(undefined);

  useFocusEffect(
    useCallback(() => {
      setScanningActive(true);
      return () => {
        setScanningActive(false);
        scanLock.current = false;
      };
    }, [])
  );

  const openManualEntry = useCallback(() => {
    setManualSeed('');
    setManualSubtitle(undefined);
    setManualVisible(true);
  }, []);

  const closeManualEntry = useCallback(() => {
    setManualVisible(false);
    scanLock.current = false;
  }, []);

  // What happens when a barcode is read, whether the camera decoded it or a
  // dev-only test seam injected it (TICKET-P9-003). Both callers go through
  // here so the two paths can never drift apart.
  const processScan = useCallback(
    (data: string) => {
      if (scanLock.current) return;
      scanLock.current = true;

      // A code the server would reject with `400 Invalid barcode format` — an
      // ITF-14 case code, a CODE-128 label, a partial read. Hand the user the
      // digits we did get in an editable field instead of a raw error (P6-006).
      if (!isValidBarcode(data)) {
        setManualSeed(sanitizeBarcodeInput(data));
        setManualSubtitle(
          "That code isn't a product barcode we can look up. Check the number under the barcode and correct it below."
        );
        setManualVisible(true);
        return;
      }

      router.push(`/(app)/product/${data}`);
      // Reset lock after navigation so back-press can scan again.
      setTimeout(() => { scanLock.current = false; }, 2000);
    },
    [router]
  );

  // TICKET-P9-003 — dev-only scan injection seam for the Maestro E2E suite.
  //
  // Maestro cannot control what the emulator camera sees, so the pixel-decode
  // step (CameraX → ML Kit) is the one link in the scan chain an on-device E2E
  // test cannot drive. Opening `breadsheet://scan?inject=<barcode>` in a __DEV__
  // build feeds the exact same `processScan` path the camera's onBarcodeScanned
  // callback uses — validation, navigation to `/(app)/product/<barcode>`, and
  // every downstream product-screen state are exercised for real. The seam is
  // dead in release builds (`__DEV__` is false there), and the param is
  // consumed immediately so a later re-focus cannot re-fire the same scan.
  const { inject } = useLocalSearchParams<{ inject?: string }>();
  useEffect(() => {
    if (!__DEV__) return;
    if (typeof inject !== 'string' || inject.length === 0) return;
    router.setParams({ inject: undefined });
    // Defer past the router's own deep-link state update, and out of the effect
    // body so processScan's state updates aren't a synchronous cascading render.
    const id = setTimeout(() => processScan(inject), 0);
    return () => clearTimeout(id);
    // processScan and router are stable useCallback refs — `inject` is the only
    // input that can change between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject]);

  // Rendered in every permission state — manual entry must not require the
  // camera, which is the point of the ticket (web, denied permission, no
  // hardware at all).
  const manualEntry = (
    <>
      <TouchableOpacity
        testID="scan-manual-entry"
        style={styles.manualButton}
        onPress={openManualEntry}
      >
        <Text style={styles.manualButtonText}>⌨️  Enter code manually</Text>
      </TouchableOpacity>
      <ManualBarcodeSheet
        visible={manualVisible}
        onClose={closeManualEntry}
        initialValue={manualSeed}
        subtitle={manualSubtitle}
      />
    </>
  );

  if (!permission) {
    return (
      <View style={styles.container}>
        <View style={styles.manualDock}>{manualEntry}</View>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>
          Camera access is needed to scan barcodes.
        </Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Allow Camera</Text>
        </TouchableOpacity>
        <View style={styles.manualDock}>{manualEntry}</View>
      </View>
    );
  }

  function handleBarcodeScanned({ data }: { data: string }) {
    processScan(data);
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torchOn}
        onBarcodeScanned={scanningActive && !manualVisible ? handleBarcodeScanned : undefined}
        barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
      />

      {/* Dimmed overlay with viewfinder cutout */}
      <View style={[styles.overlay, { pointerEvents: 'none' }]}>
        <View style={styles.overlayTop} />
        <View style={styles.overlayMiddle}>
          <View style={styles.overlaySide} />
          <View style={styles.viewfinder}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={styles.overlaySide} />
        </View>
        <View style={styles.overlayBottom} />
      </View>

      <Text style={styles.hint}>Align barcode within the frame</Text>

      <TouchableOpacity
        testID="scan-torch"
        style={styles.torchButton}
        onPress={() => setTorchOn(v => !v)}
      >
        <Text style={styles.torchText}>{torchOn ? '🔦 Off' : '🔦 On'}</Text>
      </TouchableOpacity>

      <View style={styles.manualDock}>{manualEntry}</View>
    </View>
  );
}

const VIEWFINDER = 260;
const OVERLAY_COLOR = 'rgba(0,0,0,0.55)';
const CORNER_SIZE = 24;
const CORNER_THICKNESS = 3;
const CORNER_COLOR = '#fff';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    marginHorizontal: 32,
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#0a7ea4',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 10,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },

  // Overlay
  overlay: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'column',
  },
  overlayTop: {
    flex: 1,
    backgroundColor: OVERLAY_COLOR,
  },
  overlayMiddle: {
    height: VIEWFINDER,
    flexDirection: 'row',
  },
  overlaySide: {
    flex: 1,
    backgroundColor: OVERLAY_COLOR,
  },
  viewfinder: {
    width: VIEWFINDER,
    height: VIEWFINDER,
  },
  overlayBottom: {
    flex: 1,
    backgroundColor: OVERLAY_COLOR,
  },

  // Corner markers
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderColor: CORNER_COLOR,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderColor: CORNER_COLOR,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderColor: CORNER_COLOR,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderColor: CORNER_COLOR,
  },

  hint: {
    position: 'absolute',
    bottom: '30%',
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
  },
  torchButton: {
    position: 'absolute',
    bottom: 60,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  torchText: {
    color: '#fff',
    fontSize: 14,
  },

  // Manual entry (P6-006). Sits below the torch so it is present in every
  // permission state, including the ones with no viewfinder at all.
  manualDock: {
    position: 'absolute',
    bottom: 14,
    alignSelf: 'center',
  },
  manualButton: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  manualButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
