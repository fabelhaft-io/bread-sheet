import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SPACING_COMPACT } from '@/constants/spacing';
import { Colors } from '@/constants/theme';
import type { RatingEntry } from '@/features/ratings/types';
import { useCachedResource } from '@/hooks/use-cached-resource';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useFitToScreen } from '@/hooks/use-fit-to-screen';
import { useOutbox } from '@/hooks/use-outbox';
import { useSession } from '@/hooks/use-session';
import { useRecentProducts, RecentProduct } from '@/hooks/use-recent-products';
import { api } from '@/lib/api';
import { ratingsCache } from '@/lib/offline/caches';
import { formatApiError } from '@/lib/format-error';

// ─── Small helpers ────────────────────────────────────────────────────────────

// Displays a compact taste score badge, e.g. "7.5"
function ScoreBadge({ score }: { score: number }) {
  const label = score % 1 === 0 ? score.toFixed(1) : score.toString();
  // amber below 5, green above 7, yellow in-between
  const color = score >= 7 ? '#4caf50' : score >= 5 ? '#f0c040' : '#f5a623';
  return (
    <View style={[badgeStyles.pill, { borderColor: color }]}>
      <Text style={[badgeStyles.text, { color }]}>{label}</Text>
      <Text style={badgeStyles.outOf}>/10</Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 1,
  },
  text: { fontSize: 14, fontWeight: '700', lineHeight: 18 },
  outOf: { fontSize: 10, color: '#aaa', marginBottom: 1 },
});

function ProductThumb({ image }: { image: string | null }) {
  if (image) {
    // `expo-image` with a memory+disk policy is what makes thumbnails survive
    // an offline launch — RN's own Image has no persistent cache (P8-002).
    return (
      <Image
        source={{ uri: image }}
        style={thumbStyles.image}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
    );
  }
  return (
    <View style={thumbStyles.placeholder}>
      <Text style={thumbStyles.emoji}>🍞</Text>
    </View>
  );
}

const thumbStyles = StyleSheet.create({
  image: { width: 56, height: 56, borderRadius: 10 },
  placeholder: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: '#f0ece4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 26 },
});

function relativeTime(dateStr: string | Date): string {
  const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Section components ───────────────────────────────────────────────────────

function SectionHeader({ title, compact }: { title: string; compact: boolean }) {
  return (
    <Text style={[sectionStyles.header, compact && sectionStyles.headerCompact]}>
      {title.toUpperCase()}
    </Text>
  );
}

const sectionStyles = StyleSheet.create({
  header: {
    fontSize: 13,
    fontWeight: '500',
    color: '#8E8E93',
    marginHorizontal: 16,
    marginTop: 24,
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  headerCompact: {
    marginTop: SPACING_COMPACT.sectionPaddingV,
    marginBottom: SPACING_COMPACT.tightGap,
  },
});

function RatingCard({
  entry,
  bg,
  textColor,
  iconColor,
  pendingSync,
  onPress,
}: {
  entry: RatingEntry;
  bg: string;
  textColor: string;
  iconColor: string;
  /** The rating is still sitting in the offline outbox (P8-004). */
  pendingSync: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={[cardStyles.card, { backgroundColor: bg }]} onPress={onPress} activeOpacity={0.7}>
      <ProductThumb image={entry.product.image} />
      <View style={cardStyles.info}>
        <Text style={[cardStyles.name, { color: textColor }]} numberOfLines={1}>
          {entry.product.name}
        </Text>
        {entry.product.brand ? (
          <Text style={[cardStyles.brand, { color: iconColor }]} numberOfLines={1}>
            {entry.product.brand}
          </Text>
        ) : null}
        <View style={cardStyles.scoreRow}>
          <ScoreBadge score={entry.score} />
          <Text style={[cardStyles.time, { color: iconColor }]}>{relativeTime(entry.createdAt)}</Text>
          {pendingSync ? (
            <Text testID={`rating-pending-sync-${entry.product.barcode}`} style={cardStyles.pendingSync}>
              ⏳ Not synced yet
            </Text>
          ) : null}
        </View>
        {entry.comment ? (
          <Text style={[cardStyles.comment, { color: iconColor }]} numberOfLines={2}>
            {'"'}{entry.comment}{'"'}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function RecentCard({
  item,
  bg,
  textColor,
  iconColor,
  onPress,
}: {
  item: RecentProduct;
  bg: string;
  textColor: string;
  iconColor: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={[cardStyles.card, { backgroundColor: bg }]} onPress={onPress} activeOpacity={0.7}>
      <ProductThumb image={item.image} />
      <View style={cardStyles.info}>
        <Text style={[cardStyles.name, { color: textColor }]} numberOfLines={1}>
          {item.name}
        </Text>
        {item.brand ? (
          <Text style={[cardStyles.brand, { color: iconColor }]} numberOfLines={1}>
            {item.brand}
          </Text>
        ) : null}
        <Text style={[cardStyles.time, { color: iconColor }]}>{relativeTime(item.viewedAt)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    gap: 12,
  },
  info: { flex: 1, gap: 3 },
  name: { fontSize: 15, fontWeight: '600' },
  brand: { fontSize: 13 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' },
  time: { fontSize: 12 },
  pendingSync: { fontSize: 12, color: '#c98a1a', fontWeight: '600' },
  comment: { fontSize: 13, fontStyle: 'italic', marginTop: 2 },
});

function EmptyState({ icon, message, color }: { icon: string; message: string; color: string }) {
  return (
    <View style={emptyStyles.container}>
      <Text style={emptyStyles.icon}>{icon}</Text>
      <Text style={[emptyStyles.text, { color }]}>{message}</Text>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    paddingVertical: 24,
    alignItems: 'center',
    gap: 8,
  },
  icon: { fontSize: 36 },
  text: { fontSize: 14, textAlign: 'center', lineHeight: 20, opacity: 0.7 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session, isAnonymous } = useSession();
  const { recentProducts } = useRecentProducts();
  const { isQueued, failures, dismissFailures, flush } = useOutbox();

  const userId = session?.user.id ?? null;

  const fetchRatings = useCallback(() => api.get<RatingEntry[]>('/api/users/me/ratings'), []);

  // Anonymous sessions are no longer skipped (P8-003): their ratings live on
  // the server under their anonymous user id, and now that the session survives
  // a restart they are the same ratings tomorrow as they were today.
  const {
    data: ratings,
    isLoading: loadingRatings,
    isOffline,
    error: ratingsError,
    refresh,
  } = useCachedResource<RatingEntry[]>({
    key: userId ? `ratings:${userId}` : null,
    cache: ratingsCache,
    fetcher: fetchRatings,
  });

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // A pull-to-refresh is also the clearest "I expect to be online now"
    // signal we get without a connectivity library — drain the outbox too.
    await Promise.all([refresh(), flush()]);
    setRefreshing(false);
  }, [refresh, flush]);

  // Greeting based on time of day
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const containerBg = colorScheme === 'dark' ? '#1C1C1E' : '#F2F2F7';

  const { compact, scrollProps } = useFitToScreen();

  return (
    <ScrollView
      testID="home-screen"
      style={[styles.container, { backgroundColor: containerBg }]}
      {...scrollProps}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={colors.tint}
        />
      }
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          compact && compactStyles.header,
          { backgroundColor: colors.background, marginTop: insets.top + 12 },
        ]}
      >
        <Text style={[styles.greeting, { color: colors.icon }]}>{greeting}</Text>
        <Text style={[styles.headline, { color: colors.text }]}>
          {isAnonymous ? 'Welcome, Guest 👋' : `Welcome back 👋`}
        </Text>
        {isAnonymous && (
          <TouchableOpacity
            testID="guest-upgrade-banner"
            style={[
              styles.guestBanner,
              compact && compactStyles.guestBanner,
              { backgroundColor: colors.tint + '15' },
            ]}
            onPress={() => router.push('/(account)/upgrade')}
          >
            <Text style={[styles.guestBannerText, { color: colors.tint }]}>
              Create an account so these ratings don&apos;t stay tied to this device →
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Offline / sync-failure notices */}
      {isOffline ? (
        <View testID="offline-indicator" style={styles.notice}>
          <Text style={styles.noticeText}>
            📴 You&apos;re offline — showing your last saved data.
          </Text>
        </View>
      ) : null}

      {failures.length ? (
        <TouchableOpacity testID="outbox-failures" style={styles.noticeError} onPress={dismissFailures}>
          <Text style={styles.noticeErrorText}>
            {failures.length === 1
              ? `A rating could not be saved: ${failures[0].message}`
              : `${failures.length} ratings could not be saved.`}
            {'\n'}Tap to dismiss.
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* My Ratings */}
      <SectionHeader title="My Ratings" compact={compact} />

      {loadingRatings ? (
        <View style={[styles.loadingRow, compact && compactStyles.loadingRow]}>
          <ActivityIndicator size="small" color={colors.tint} />
        </View>
      ) : ratingsError && !ratings ? (
        <EmptyState
          icon="⚠️"
          message={formatApiError(ratingsError, 'Could not load your ratings.')}
          color={colors.icon}
        />
      ) : isOffline && !ratings ? (
        <EmptyState
          icon="📴"
          message={"You're offline and haven't opened this list on this device yet."}
          color={colors.icon}
        />
      ) : !ratings || ratings.length === 0 ? (
        <EmptyState
          icon="⭐"
          message={"You haven't rated anything yet.\nScan a barcode to get started!"}
          color={colors.icon}
        />
      ) : (
        ratings.map((entry) => (
          <RatingCard
            key={entry.id}
            entry={entry}
            bg={colors.background}
            textColor={colors.text}
            iconColor={colors.icon}
            pendingSync={isQueued(entry.product.barcode)}
            onPress={() => router.push(`/(app)/product/${entry.product.barcode}`)}
          />
        ))
      )}

      {/* Recently Opened */}
      <SectionHeader title="Recently Opened" compact={compact} />

      {recentProducts.length === 0 ? (
        <EmptyState
          icon="🔍"
          message={"Products you open will appear here.\nTry scanning a barcode!"}
          color={colors.icon}
        />
      ) : (
        recentProducts.map((item) => (
          <RecentCard
            key={item.barcode}
            item={item}
            bg={colors.background}
            textColor={colors.text}
            iconColor={colors.icon}
            onPress={() => router.push(`/(app)/product/${item.barcode}`)}
          />
        ))
      )}

      <View style={[styles.bottomPad, compact && compactStyles.bottomPad]} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    marginHorizontal: 16,
    marginBottom: 4,
    padding: 20,
    borderRadius: 16,
    gap: 4,
  },
  greeting: {
    fontSize: 14,
  },
  headline: {
    fontSize: 22,
    fontWeight: '700',
  },
  guestBanner: {
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  guestBannerText: {
    fontSize: 13,
    fontWeight: '500',
  },
  loadingRow: {
    marginHorizontal: 16,
    paddingVertical: 24,
    alignItems: 'center',
  },
  notice: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f0c04022',
  },
  noticeText: {
    fontSize: 13,
    color: '#a5761b',
    fontWeight: '500',
  },
  noticeError: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#e05c5c22',
  },
  noticeErrorText: {
    fontSize: 13,
    color: '#c0392b',
    fontWeight: '500',
    lineHeight: 18,
  },
  bottomPad: {
    height: 32,
  },
});

/**
 * Tightened vertical spacing applied when `useFitToScreen()` reports `compact`
 * (P5-006 FE Fixes). Vertical margins/padding/gaps only — no font sizes, and
 * no padding inside a pressable, so touch targets stay at their full size.
 */
const compactStyles = StyleSheet.create({
  header: {
    paddingVertical: SPACING_COMPACT.sectionPaddingV,
  },
  guestBanner: {
    marginTop: SPACING_COMPACT.tightGap,
  },
  loadingRow: {
    paddingVertical: SPACING_COMPACT.sectionPaddingV,
  },
  bottomPad: {
    height: SPACING_COMPACT.screenBottom,
  },
});
