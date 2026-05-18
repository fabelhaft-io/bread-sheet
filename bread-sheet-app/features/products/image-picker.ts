/**
 * Thin wrapper around `expo-image-picker` used by the Add Product flow.
 *
 * Wrapping the SDK here keeps the screen file UI-only and avoids each call
 * site having to remember the `quality: 1` / square-crop defaults. Also
 * allows us to swap to the in-app camera (`expo-camera`) later without
 * touching the screens.
 */

export type CaptureSource = 'camera' | 'library';

export interface CaptureResult {
  /** Local file URI (e.g. `file://...`) or `null` when the user cancelled. */
  uri: string | null;
}

export async function captureImage(source: CaptureSource): Promise<CaptureResult> {
  const mod = await importImagePicker();
  if (!mod) return { uri: null };

  if (source === 'camera') {
    const perm = await mod.requestCameraPermissionsAsync();
    if (!perm.granted) return { uri: null };
    const result = await mod.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });
    return unpack(result);
  }

  const perm = await mod.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { uri: null };
  const result = await mod.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
  });
  return unpack(result);
}

interface ImagePickerResultLike {
  canceled: boolean;
  assets?: { uri: string }[] | null;
}

function unpack(result: ImagePickerResultLike): CaptureResult {
  if (result.canceled) return { uri: null };
  const uri = result.assets?.[0]?.uri ?? null;
  return { uri };
}

type ImagePickerModule = {
  requestCameraPermissionsAsync: () => Promise<{ granted: boolean }>;
  requestMediaLibraryPermissionsAsync: () => Promise<{ granted: boolean }>;
  launchCameraAsync: (opts: unknown) => Promise<ImagePickerResultLike>;
  launchImageLibraryAsync: (opts: unknown) => Promise<ImagePickerResultLike>;
};

async function importImagePicker(): Promise<ImagePickerModule | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-image-picker');
    return (mod?.default ?? mod) as ImagePickerModule | null;
  } catch {
    return null;
  }
}
