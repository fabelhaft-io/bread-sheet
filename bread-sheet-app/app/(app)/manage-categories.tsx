import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';
import { SPACING_COMPACT } from '@/constants/spacing';
import { deleteCategory, mergeCategory, renameCategory } from '@/features/categories/api';
import { sortOwnCategories } from '@/features/categories/picker';
import type { UserCategory } from '@/features/categories/types';
import { CATEGORY_NAME_MAX_RAW_CHARS, validateCategoryName } from '@/features/categories/validation';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useFitToScreen } from '@/hooks/use-fit-to-screen';
import { useMyCategories } from '@/hooks/use-my-categories';
import { useSession } from '@/hooks/use-session';
import { formatApiError } from '@/lib/format-error';

type RowMode = { kind: 'idle' } | { kind: 'rename' } | { kind: 'merge' };

/**
 * TICKET-P6-003 — a profile-tab-reachable screen listing the user's own
 * categories with their rating counts, supporting rename, merge and delete.
 * Renaming/merging/deleting here is online-only (every call is a direct
 * network request, no offline queue) — categories themselves are cheap and
 * the actions are rare enough that this is not worth the outbox's
 * complexity.
 */
export default function ManageCategoriesScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const { compact, scrollProps } = useFitToScreen();

  const { categories, isLoading, isOffline, error, refresh } = useMyCategories(userId);
  const sorted = sortOwnCategories(categories);

  const [rowModes, setRowModes] = useState<Record<string, RowMode>>({});
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);

  const modeFor = (id: string): RowMode => rowModes[id] ?? { kind: 'idle' };
  const setMode = (id: string, mode: RowMode) => setRowModes((prev) => ({ ...prev, [id]: mode }));
  const setRowError = (id: string, message: string | null) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const startRename = (category: UserCategory) => {
    setRenameValue(category.name);
    setRenameError(null);
    setRowError(category.id, null);
    setMode(category.id, { kind: 'rename' });
  };

  const cancelRowAction = (id: string) => setMode(id, { kind: 'idle' });

  const submitRename = async (category: UserCategory) => {
    const validation = validateCategoryName(renameValue);
    if (!validation.valid) {
      setRenameError(validation.message);
      return;
    }
    setRenameError(null);
    setPendingId(category.id);
    try {
      await renameCategory(category.id, validation.name);
      await refresh();
      setMode(category.id, { kind: 'idle' });
    } catch (err) {
      setRowError(category.id, formatApiError(err, 'Could not rename that category. Please try again.'));
    } finally {
      setPendingId(null);
    }
  };

  const startMerge = (category: UserCategory) => {
    setRowError(category.id, null);
    setMode(category.id, { kind: 'merge' });
  };

  const submitMerge = async (source: UserCategory, target: UserCategory) => {
    setPendingId(source.id);
    try {
      await mergeCategory(source.id, target.id);
      await refresh();
      setMode(source.id, { kind: 'idle' });
    } catch (err) {
      setRowError(source.id, formatApiError(err, 'Could not merge that category. Please try again.'));
    } finally {
      setPendingId(null);
    }
  };

  const performDelete = async (category: UserCategory) => {
    setPendingId(category.id);
    try {
      await deleteCategory(category.id);
      await refresh();
    } catch (err) {
      setRowError(category.id, formatApiError(err, 'Could not delete that category. Please try again.'));
    } finally {
      setPendingId(null);
    }
  };

  const confirmDelete = (category: UserCategory) => {
    // Deleting a category never deletes ratings — only this label. The
    // confirmation copy says so explicitly (ticket requirement).
    const message = `Ratings tagged with “${category.name}” will keep their rating but become uncategorised. This cannot be undone.`;
    if (Platform.OS === 'web') {
      if (window.confirm(message)) void performDelete(category);
      return;
    }
    Alert.alert('Delete category', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void performDelete(category) },
    ]);
  };

  return (
    <ScrollView
      testID="manage-categories-screen"
      style={[styles.container, { backgroundColor: colors.background }]}
      {...scrollProps}
    >
      <View style={[styles.header, compact && compactStyles.header]}>
        <ThemedText style={styles.headerText}>
          Rename, merge or delete your own categories. Ratings are never deleted — only the label.
        </ThemedText>
      </View>

      {isLoading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.tint} />
        </View>
      ) : error ? (
        <ThemedText testID="manage-categories-error" style={styles.errorText}>
          {formatApiError(error, 'Could not load your categories.')}
        </ThemedText>
      ) : isOffline && categories.length === 0 ? (
        <ThemedText testID="manage-categories-offline" style={styles.emptyText}>
          You&apos;re offline and haven&apos;t opened this list on this device yet.
        </ThemedText>
      ) : sorted.length === 0 ? (
        <ThemedText testID="manage-categories-empty" style={styles.emptyText}>
          You haven&apos;t created any categories yet. Pick one while rating something to get started.
        </ThemedText>
      ) : (
        sorted.map((category) => {
          const mode = modeFor(category.id);
          const otherCategories = sorted.filter((c) => c.id !== category.id);
          const busy = pendingId === category.id;
          return (
            <View
              key={category.id}
              testID={`manage-categories-row-${category.id}`}
              style={[styles.row, compact && compactStyles.row, { borderColor: colors.icon + '22' }]}
            >
              {mode.kind === 'rename' ? (
                <View style={styles.renameBlock}>
                  <TextInput
                    testID={`manage-categories-rename-input-${category.id}`}
                    value={renameValue}
                    onChangeText={(v) => {
                      setRenameValue(v);
                      setRenameError(null);
                    }}
                    maxLength={CATEGORY_NAME_MAX_RAW_CHARS + 1}
                    style={[
                      styles.renameInput,
                      { color: colors.text, borderColor: colors.icon + '55' },
                    ]}
                    autoFocus
                  />
                  {renameError ? <Text style={styles.errorText}>{renameError}</Text> : null}
                  <View style={styles.actionsRow}>
                    <TouchableOpacity
                      testID={`manage-categories-rename-save-${category.id}`}
                      onPress={() => void submitRename(category)}
                      disabled={busy}
                    >
                      {busy ? (
                        <ActivityIndicator size="small" color={colors.tint} />
                      ) : (
                        <Text style={[styles.actionText, { color: colors.tint }]}>Save</Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`manage-categories-rename-cancel-${category.id}`}
                      onPress={() => cancelRowAction(category.id)}
                    >
                      <Text style={[styles.actionText, { color: colors.icon }]}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : mode.kind === 'merge' ? (
                <View style={styles.renameBlock}>
                  <ThemedText style={styles.mergeLabel}>Merge “{category.name}” into…</ThemedText>
                  {otherCategories.length === 0 ? (
                    <ThemedText style={styles.emptyText}>No other category to merge into.</ThemedText>
                  ) : (
                    otherCategories.map((target) => (
                      <TouchableOpacity
                        key={target.id}
                        testID={`manage-categories-merge-target-${category.id}-${target.id}`}
                        style={styles.mergeTargetRow}
                        onPress={() => void submitMerge(category, target)}
                        disabled={busy}
                      >
                        <Text style={[styles.actionText, { color: colors.text }]}>{target.name}</Text>
                      </TouchableOpacity>
                    ))
                  )}
                  <TouchableOpacity
                    testID={`manage-categories-merge-cancel-${category.id}`}
                    onPress={() => cancelRowAction(category.id)}
                  >
                    <Text style={[styles.actionText, { color: colors.icon }]}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.rowMain}>
                  <View style={styles.rowInfo}>
                    <ThemedText testID={`manage-categories-name-${category.id}`} style={styles.rowName}>
                      {category.name}
                    </ThemedText>
                    <ThemedText
                      testID={`manage-categories-count-${category.id}`}
                      style={[styles.rowCount, { color: colors.icon }]}
                    >
                      {category.ratingCount} rating{category.ratingCount === 1 ? '' : 's'}
                    </ThemedText>
                  </View>
                  <View style={styles.actionsRow}>
                    <TouchableOpacity
                      testID={`manage-categories-rename-${category.id}`}
                      onPress={() => startRename(category)}
                    >
                      <Text style={[styles.actionText, { color: colors.tint }]}>Rename</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`manage-categories-merge-${category.id}`}
                      onPress={() => startMerge(category)}
                    >
                      <Text style={[styles.actionText, { color: colors.tint }]}>Merge</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`manage-categories-delete-${category.id}`}
                      onPress={() => confirmDelete(category)}
                    >
                      <Text style={styles.deleteText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {rowErrors[category.id] ? (
                <ThemedText
                  testID={`manage-categories-row-error-${category.id}`}
                  style={styles.errorText}
                >
                  {rowErrors[category.id]}
                </ThemedText>
              ) : null}
            </View>
          );
        })
      )}

      <View style={[styles.bottomPad, compact && compactStyles.bottomPad]} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { marginHorizontal: 16, marginTop: 16, marginBottom: 8 },
  headerText: { fontSize: 13, opacity: 0.7, lineHeight: 18 },
  loadingRow: { paddingVertical: 24, alignItems: 'center' },
  emptyText: { marginHorizontal: 16, marginTop: 16, fontSize: 14, opacity: 0.7, lineHeight: 20 },
  errorText: { fontSize: 13, color: '#c0392b', fontWeight: '500', marginTop: 6 },
  row: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  rowMain: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowInfo: { flex: 1, gap: 2 },
  rowName: { fontSize: 16, fontWeight: '600' },
  rowCount: { fontSize: 13 },
  actionsRow: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  actionText: { fontSize: 14, fontWeight: '600' },
  deleteText: { fontSize: 14, fontWeight: '600', color: '#c0392b' },
  renameBlock: { gap: 10 },
  renameInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  mergeLabel: { fontSize: 14, fontWeight: '600', marginBottom: 4 },
  mergeTargetRow: { paddingVertical: 8 },
  bottomPad: { height: 32 },
});

const compactStyles = StyleSheet.create({
  header: { marginTop: SPACING_COMPACT.sectionPaddingV, marginBottom: SPACING_COMPACT.tightGap },
  row: { marginBottom: SPACING_COMPACT.tightGap, padding: SPACING_COMPACT.cardPaddingV },
  bottomPad: { height: SPACING_COMPACT.screenBottom },
});
