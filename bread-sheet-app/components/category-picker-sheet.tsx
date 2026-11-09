import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { findNearMatch } from '@/features/categories/match';
import type { CategorySelection } from '@/features/categories/picker';
import { sortOwnCategories, unusedSeeds } from '@/features/categories/picker';
import type { CategorySeed } from '@/features/categories/seeds';
import type { UserCategory } from '@/features/categories/types';
import { CATEGORY_NAME_MAX_RAW_CHARS, validateCategoryName } from '@/features/categories/validation';

/** Either outcome a network-backed action reports back to the sheet. */
export type PickerActionResult = { ok: true } | { ok: false; message: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  /** The caller's own categories (unsorted is fine — this component orders them). */
  ownCategories: UserCategory[];
  currentSelection: CategorySelection | null;
  /** No network call — the category already exists. */
  onSelectExisting: (category: UserCategory) => void;
  /** Tries to materialise the seed (`POST /api/users/me/categories { seedSlug }`); offline, the caller falls back to an unmaterialised selection and still reports `ok`. */
  onSelectSeed: (seed: CategorySeed) => Promise<PickerActionResult>;
  /** Creates a brand-new custom category by name. Online-only. */
  onCreate: (name: string) => Promise<PickerActionResult>;
  /** Explicitly removes the category from the current rating. */
  onClear: () => void;
};

type Mode = 'list' | 'create' | 'confirm';

type NearMatchCandidate = (UserCategory | CategorySeed) & { name: string };

function isUserCategory(candidate: NearMatchCandidate): candidate is UserCategory {
  return 'id' in candidate;
}

/**
 * The rating screen's category picker (TICKET-P6-003): own categories
 * (most-used first), then unused seeds, then "+ New category" — with a
 * "Did you mean…?" near-match nudge in front of creating (rejecting it
 * still creates). Pure presentation — every network call is a prop the
 * screen supplies, so this component never imports `lib/api` directly.
 */
export function CategoryPickerSheet({
  visible,
  onClose,
  ownCategories,
  currentSelection,
  onSelectExisting,
  onSelectSeed,
  onCreate,
  onClear,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="category-picker-sheet"
    >
      {visible ? (
        <SheetBody
          onClose={onClose}
          ownCategories={ownCategories}
          currentSelection={currentSelection}
          onSelectExisting={onSelectExisting}
          onSelectSeed={onSelectSeed}
          onCreate={onCreate}
          onClear={onClear}
        />
      ) : null}
    </Modal>
  );
}

function SheetBody({
  onClose,
  ownCategories,
  currentSelection,
  onSelectExisting,
  onSelectSeed,
  onCreate,
  onClear,
}: Omit<Props, 'visible'>) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const [mode, setMode] = useState<Mode>('list');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [match, setMatch] = useState<NearMatchCandidate | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const sortedOwn = sortOwnCategories(ownCategories);
  const seeds = unusedSeeds(ownCategories);

  const handlePickExisting = (category: UserCategory) => {
    onSelectExisting(category);
    onClose();
  };

  const handlePickSeed = async (seed: CategorySeed) => {
    setActionError(null);
    setPending(true);
    const result = await onSelectSeed(seed);
    setPending(false);
    if (result.ok) {
      onClose();
    } else {
      setActionError(result.message);
    }
  };

  const startCreate = () => {
    setName('');
    setNameError(null);
    setActionError(null);
    setMatch(null);
    setMode('create');
  };

  const handleSubmitName = () => {
    const validation = validateCategoryName(name);
    if (!validation.valid) {
      setNameError(validation.message);
      return;
    }
    setNameError(null);
    const candidates: NearMatchCandidate[] = [...ownCategories, ...seeds];
    const found = findNearMatch(validation.name, candidates);
    if (found) {
      setMatch(found);
      setMode('confirm');
    } else {
      void doCreate(validation.name);
    }
  };

  const doCreate = async (finalName: string) => {
    setActionError(null);
    setPending(true);
    const result = await onCreate(finalName);
    setPending(false);
    if (result.ok) {
      onClose();
    } else {
      setActionError(result.message);
    }
  };

  const useMatch = async () => {
    if (!match) return;
    if (isUserCategory(match)) {
      onSelectExisting(match);
      onClose();
      return;
    }
    setActionError(null);
    setPending(true);
    const result = await onSelectSeed(match);
    setPending(false);
    if (result.ok) {
      onClose();
    } else {
      setActionError(result.message);
    }
  };

  // ─── "Did you mean…?" (near-match nudge, not a gate) ──────────────────
  if (mode === 'confirm' && match) {
    const validated = validateCategoryName(name);
    const rawName = validated.valid ? validated.name : name.trim();
    return (
      <Backdrop onClose={onClose} colors={colors}>
        <Text style={[styles.title, { color: colors.text }]}>Did you mean {match.name}?</Text>
        <Text style={[styles.subtitle, { color: colors.icon }]}>
          A similar category already exists.
        </Text>
        {actionError ? (
          <Text testID="category-picker-error" style={styles.error}>
            {actionError}
          </Text>
        ) : null}
        <TouchableOpacity
          testID="category-picker-use-match"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={useMatch}
          disabled={pending}
        >
          {pending ? (
            <ActivityIndicator color={colors.background} size="small" />
          ) : (
            <Text style={[styles.buttonText, { color: colors.background }]}>Use {match.name}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          testID="category-picker-create-anyway"
          style={styles.secondary}
          onPress={() => void doCreate(rawName)}
          disabled={pending}
        >
          <Text style={[styles.secondaryText, { color: colors.tint }]}>
            No, create &quot;{rawName}&quot;
          </Text>
        </TouchableOpacity>
        <TouchableOpacity testID="category-picker-back" style={styles.secondary} onPress={() => setMode('create')}>
          <Text style={[styles.secondaryText, { color: colors.icon }]}>Back</Text>
        </TouchableOpacity>
      </Backdrop>
    );
  }

  // ─── "+ New category" ───────────────────────────────────────────────
  if (mode === 'create') {
    return (
      <Backdrop onClose={onClose} colors={colors}>
        <Text style={[styles.title, { color: colors.text }]}>New category</Text>
        <TextInput
          testID="category-picker-name-input"
          autoFocus
          value={name}
          onChangeText={(v) => {
            setName(v);
            setNameError(null);
          }}
          maxLength={CATEGORY_NAME_MAX_RAW_CHARS + 1}
          placeholder="e.g. Wine"
          placeholderTextColor={colors.icon + '77'}
          style={[
            styles.input,
            {
              color: colors.text,
              borderColor: nameError ? '#c0392b' : colors.icon + '55',
            },
          ]}
          returnKeyType="done"
          onSubmitEditing={handleSubmitName}
        />
        {nameError ? (
          <Text testID="category-picker-name-error" style={styles.error}>
            {nameError}
          </Text>
        ) : null}
        {actionError ? (
          <Text testID="category-picker-error" style={styles.error}>
            {actionError}
          </Text>
        ) : null}
        <TouchableOpacity
          testID="category-picker-submit-name"
          style={[styles.button, { backgroundColor: colors.tint }]}
          onPress={handleSubmitName}
          disabled={pending}
        >
          {pending ? (
            <ActivityIndicator color={colors.background} size="small" />
          ) : (
            <Text style={[styles.buttonText, { color: colors.background }]}>Add</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity testID="category-picker-cancel-create" style={styles.secondary} onPress={() => setMode('list')}>
          <Text style={[styles.secondaryText, { color: colors.icon }]}>Back</Text>
        </TouchableOpacity>
      </Backdrop>
    );
  }

  // ─── List: own categories, then unused seeds, then "+ New category" ──
  return (
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable testID="category-picker-backdrop" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={styles.grabber} />
        <Text style={[styles.title, { color: colors.text }]}>Choose a category</Text>

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {currentSelection ? (
            <TouchableOpacity
              testID="category-picker-clear"
              style={styles.row}
              onPress={() => {
                onClear();
                onClose();
              }}
            >
              <Text style={[styles.rowText, { color: colors.icon }]}>✕ No category</Text>
            </TouchableOpacity>
          ) : null}

          {sortedOwn.length > 0 ? (
            <Text style={[styles.sectionLabel, { color: colors.icon }]}>Your categories</Text>
          ) : null}
          {sortedOwn.map((category) => {
            const selected =
              currentSelection?.kind === 'existing' && currentSelection.id === category.id;
            return (
              <TouchableOpacity
                key={category.id}
                testID={`category-picker-own-${category.id}`}
                style={styles.row}
                onPress={() => handlePickExisting(category)}
              >
                <Text style={[styles.rowText, { color: colors.text }, selected && { fontWeight: '700' }]}>
                  {selected ? '✓ ' : ''}
                  {category.name}
                </Text>
                <Text style={[styles.rowCount, { color: colors.icon }]}>{category.ratingCount}</Text>
              </TouchableOpacity>
            );
          })}

          {seeds.length > 0 ? (
            <Text style={[styles.sectionLabel, { color: colors.icon }]}>Starter categories</Text>
          ) : null}
          {seeds.map((seed) => (
            <TouchableOpacity
              key={seed.slug}
              testID={`category-picker-seed-${seed.slug}`}
              style={styles.row}
              onPress={() => void handlePickSeed(seed)}
              disabled={pending}
            >
              <Text style={[styles.rowText, { color: colors.text }]}>+ {seed.name}</Text>
            </TouchableOpacity>
          ))}

          <TouchableOpacity testID="category-picker-new" style={styles.row} onPress={startCreate}>
            <Text style={[styles.rowText, { color: colors.tint, fontWeight: '600' }]}>+ New category</Text>
          </TouchableOpacity>
        </ScrollView>

        {actionError ? (
          <Text testID="category-picker-error" style={styles.error}>
            {actionError}
          </Text>
        ) : null}

        <TouchableOpacity testID="category-picker-close" style={styles.secondary} onPress={onClose}>
          <Text style={[styles.secondaryText, { color: colors.icon }]}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Shared "slide-up card" chrome for the create/confirm sub-screens. */
function Backdrop({
  onClose,
  colors,
  children,
}: {
  onClose: () => void;
  colors: typeof Colors.light;
  children: ReactNode;
}) {
  return (
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable testID="category-picker-backdrop" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={styles.grabber} />
        {children}
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
    maxHeight: '80%',
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
  list: { marginTop: 4 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 14,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  rowText: { fontSize: 15, flexShrink: 1 },
  rowCount: { fontSize: 13 },
  input: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  error: { fontSize: 13, color: '#c0392b', fontWeight: '500', marginTop: 4 },
  button: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  secondary: { paddingVertical: 12, alignItems: 'center' },
  secondaryText: { fontSize: 15 },
});

export default CategoryPickerSheet;
