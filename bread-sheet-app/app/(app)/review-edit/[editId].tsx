import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSession } from '@/hooks/use-session';
import { formatApiError } from '@/lib/format-error';

import {
  dismissProductEdit,
  getPendingEdit,
  voteOnProductEdit,
} from '@/features/products/api';
import { FIELD_LABELS } from '@/features/products/edit-form';
import type { EditVote, PendingEdit } from '@/features/products/types';

const APPROVALS_NEEDED = 2;

/**
 * TICKET-P5-006 — Reviewer diff screen.
 *
 * Opened from the "Someone suggested a change" banner on the product detail.
 * For every changed field: original value (struck through, muted) on the left,
 * proposed value (bold, accent) on the right. Unchanged fields are collapsed
 * beneath so the reviewer can verify what was NOT touched. The baseline comes
 * from the edit's `originalValues` snapshot — not the live product — so it is
 * correct even if the product changed since the proposal.
 *
 * Actions: "Looks correct" (approve), "Something's wrong" (reject), "Dismiss"
 * (server-side, hides the banner across devices; not a vote).
 */
export default function ReviewEditScreen() {
  const { editId, barcode } = useLocalSearchParams<{ editId: string; barcode: string }>();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { session, isAnonymous } = useSession();

  const [edit, setEdit] = useState<PendingEdit | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [acting, setActing] = useState<'APPROVE' | 'REJECT' | 'DISMISS' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || isAnonymous || !barcode) return;
    let cancelled = false;
    getPendingEdit(barcode)
      .then(({ edit: pending }) => {
        if (cancelled) return;
        if (!pending || pending.editId !== editId) {
          setLoadError('This edit is no longer under review.');
        } else {
          setEdit(pending);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(formatApiError(err, 'Could not load this edit. Please try again.'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [barcode, editId, session, isAnonymous]);

  const goBackToProduct = useCallback(() => {
    router.replace({ pathname: '/(app)/product/[barcode]', params: { barcode } });
  }, [router, barcode]);

  const onVote = useCallback(
    async (vote: EditVote) => {
      if (acting) return;
      setActing(vote);
      setActionError(null);
      try {
        await voteOnProductEdit(editId, vote);
        goBackToProduct();
      } catch (err) {
        setActionError(formatApiError(err, 'Could not record your vote. Please try again.'));
        setActing(null);
      }
    },
    [acting, editId, goBackToProduct],
  );

  const onDismiss = useCallback(async () => {
    if (acting) return;
    setActing('DISMISS');
    setActionError(null);
    try {
      await dismissProductEdit(editId);
      goBackToProduct();
    } catch (err) {
      setActionError(formatApiError(err, 'Could not dismiss. Please try again.'));
      setActing(null);
    }
  }, [acting, editId, goBackToProduct]);

  if (!session || isAnonymous) {
    return (
      <ThemedView style={styles.center} testID="review-edit-anon-gate">
        <Text style={styles.icon}>🔒</Text>
        <ThemedText type="title" style={styles.title}>
          Sign up to review edits
        </ThemedText>
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

  if (loadError || !edit) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText style={styles.errorText}>{loadError ?? 'Not found.'}</ThemedText>
      </ThemedView>
    );
  }

  const changedFields = Object.keys(edit.proposedChanges);
  const unchangedFields = Object.keys(edit.originalValues).filter(
    (f) => !changedFields.includes(f),
  );
  const approvalsLeft = Math.max(0, APPROVALS_NEEDED - edit.approvals);

  const display = (v: string | number | null | undefined) =>
    v === null || v === undefined || v === '' ? 'Not provided' : String(v);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.scrollContent}
      testID="review-edit-screen"
    >
      <View style={styles.section}>
        <ThemedText type="subtitle">Suggested change</ThemedText>
        <ThemedText style={styles.explanation}>
          Compare the current values with the suggested ones and confirm whether the
          change looks right. It is applied once {APPROVALS_NEEDED} users approve.
        </ThemedText>
        <ThemedText style={styles.tally} testID="vote-tally">
          {edit.approvals} of {APPROVALS_NEEDED} approvals needed
          {edit.rejections > 0 ? ` · ${edit.rejections} objection${edit.rejections > 1 ? 's' : ''}` : ''}
        </ThemedText>
      </View>

      <View style={[styles.divider, { backgroundColor: colors.icon + '33' }]} />

      {/* Changed fields — old (struck through) vs new (bold, accent) */}
      <View style={styles.section} testID="diff-rows">
        {changedFields.map((field) => (
          <View key={field} style={styles.diffRow} testID={`diff-${field}`}>
            <ThemedText style={styles.diffLabel}>{FIELD_LABELS[field] ?? field}</ThemedText>
            <View style={styles.diffValues}>
              <ThemedText style={styles.diffOld}>
                {display(edit.originalValues[field])}
              </ThemedText>
              <ThemedText style={[styles.diffNew, { color: colors.tint }]}>
                {display(edit.proposedChanges[field])}
              </ThemedText>
            </View>
          </View>
        ))}
      </View>

      {/* Unchanged fields — collapsed by default */}
      {unchangedFields.length > 0 ? (
        <View style={styles.section}>
          <TouchableOpacity
            testID="toggle-unchanged"
            onPress={() => setShowUnchanged((s) => !s)}
          >
            <ThemedText style={styles.unchangedToggle}>
              {showUnchanged ? '▾' : '▸'} Unchanged fields ({unchangedFields.length})
            </ThemedText>
          </TouchableOpacity>
          {showUnchanged
            ? unchangedFields.map((field) => (
                <View key={field} style={styles.unchangedRow} testID={`unchanged-${field}`}>
                  <ThemedText style={styles.diffLabel}>
                    {FIELD_LABELS[field] ?? field}
                  </ThemedText>
                  <ThemedText style={styles.unchangedValue}>
                    {display(edit.originalValues[field])}
                  </ThemedText>
                </View>
              ))
            : null}
        </View>
      ) : null}

      {edit.viewer.isAuthor ? (
        <View style={styles.section}>
          <ThemedText style={styles.explanation} testID="own-edit-note">
            You suggested this change. Waiting on peer review.
          </ThemedText>
        </View>
      ) : edit.viewer.vote ? (
        <View style={styles.section}>
          <ThemedText style={styles.explanation} testID="already-voted-note">
            You already reviewed this change.
          </ThemedText>
        </View>
      ) : (
        <View style={styles.actionsSection}>
          {actionError ? (
            <ThemedText style={styles.errorText} testID="review-edit-action-error">
              {actionError}
            </ThemedText>
          ) : null}
          <TouchableOpacity
            testID="edit-approve"
            style={[styles.button, { backgroundColor: colors.tint }, acting && styles.buttonDisabled]}
            disabled={acting !== null}
            onPress={() => onVote('APPROVE')}
          >
            {acting === 'APPROVE' ? (
              <ActivityIndicator color={colors.background} size="small" />
            ) : (
              <Text style={[styles.buttonText, { color: colors.background }]}>Looks correct</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            testID="edit-reject"
            style={[styles.secondaryButton, { borderColor: colors.tint }]}
            disabled={acting !== null}
            onPress={() => onVote('REJECT')}
          >
            {acting === 'REJECT' ? (
              <ActivityIndicator color={colors.tint} size="small" />
            ) : (
              <Text style={[styles.buttonText, { color: colors.tint }]}>
                Something&apos;s wrong
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            testID="edit-dismiss"
            style={styles.dismissButton}
            disabled={acting !== null}
            onPress={onDismiss}
          >
            {acting === 'DISMISS' ? (
              <ActivityIndicator size="small" />
            ) : (
              <ThemedText style={styles.dismissText}>Dismiss</ThemedText>
            )}
          </TouchableOpacity>
        </View>
      )}
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
    padding: 20,
    gap: 8,
  },
  explanation: {
    fontSize: 13,
    opacity: 0.7,
    lineHeight: 18,
  },
  tally: {
    fontSize: 13,
    fontWeight: '600',
    opacity: 0.8,
  },
  divider: {
    height: 1,
    marginHorizontal: 20,
  },
  diffRow: {
    gap: 4,
  },
  diffLabel: {
    fontSize: 12,
    opacity: 0.6,
    letterSpacing: 0.3,
  },
  diffValues: {
    gap: 2,
  },
  diffOld: {
    fontSize: 15,
    textDecorationLine: 'line-through',
    opacity: 0.45,
  },
  diffNew: {
    fontSize: 15,
    fontWeight: '700',
  },
  unchangedToggle: {
    fontSize: 14,
    fontWeight: '600',
    opacity: 0.7,
  },
  unchangedRow: {
    gap: 2,
    marginTop: 6,
  },
  unchangedValue: {
    fontSize: 14,
    opacity: 0.7,
  },
  actionsSection: {
    paddingHorizontal: 20,
    paddingTop: 4,
    gap: 10,
  },
  button: {
    alignSelf: 'stretch',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  secondaryButton: {
    alignSelf: 'stretch',
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    alignItems: 'center',
  },
  dismissButton: {
    alignSelf: 'center',
    padding: 10,
  },
  dismissText: {
    fontSize: 14,
    opacity: 0.6,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '700',
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
