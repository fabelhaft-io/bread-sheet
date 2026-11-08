import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  ActivityIndicator,
  NativeScrollEvent,
  NativeSyntheticEvent,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputInstance,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ManualBarcodeSheet } from '@/components/manual-barcode-sheet';
import { SPACING_COMPACT } from '@/constants/spacing';
import { Colors } from '@/constants/theme';
import type { RatingEntry } from '@/features/ratings/types';
import { isSearchableQuery, type ProductSearchResult } from '@/features/search/api';
import { filterRatingsByQuery } from '@/features/search/match';
import { useCachedResource } from '@/hooks/use-cached-resource';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useFitToScreen } from '@/hooks/use-fit-to-screen';
import { useOutbox } from '@/hooks/use-outbox';
import { useProductSearch } from '@/hooks/use-product-search';
import { useSession } from '@/hooks/use-session';
import { useRecentProducts, RecentProduct } from '@/hooks/use-recent-products';
import { api } from '@/lib/api';
import { ratingsCache } from '@/lib/offline/caches';
import { formatApiError, OFFLINE_MESSAGE } from '@/lib/format-error';

/** TICKET-P6-008 — the search bar's scope toggle. Defaults to "Mine". */
type SearchScope = 'mine' | 'all';

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
            <Text testID={`rating-pending-sync-${entry.product.id}`} style={cardStyles.pendingSync}>
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
  unverifiedBadge: { fontSize: 12, fontWeight: '600', marginTop: 2 },
});

function EmptyState({
  icon,
  message,
  color,
  testID,
  action,
}: {
  icon: string;
  message: string;
  color: string;
  testID?: string;
  /** Optional next-step CTA, e.g. "Search all products →" (TICKET-P6-008). */
  action?: { testID: string; label: string; onPress: () => void; color: string };
}) {
  return (
    <View style={emptyStyles.container} testID={testID}>
      <Text style={emptyStyles.icon}>{icon}</Text>
      <Text style={[emptyStyles.text, { color }]}>{message}</Text>
      {action ? (
        <TouchableOpacity testID={action.testID} onPress={action.onPress}>
          <Text style={[emptyStyles.actionText, { color: action.color }]}>{action.label}</Text>
        </TouchableOpacity>
      ) : null}
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
  actionText: { fontSize: 14, fontWeight: '600', marginTop: 4 },
});

// ─── Search (TICKET-P6-008) ────────────────────────────────────────────────────

/**
 * One search bar, two scopes. "Mine" (default) filters the already-loaded
 * ratings list in memory; "All products" calls the backend. The same `query`
 * state drives both — switching scope re-interprets what's typed rather than
 * clearing it.
 */
function SearchBar({
  query,
  onChangeQuery,
  scope,
  onChangeScope,
  colors,
  compact,
  inputRef,
}: {
  query: string;
  onChangeQuery: (value: string) => void;
  scope: SearchScope;
  onChangeScope: (scope: SearchScope) => void;
  colors: typeof Colors.light;
  compact: boolean;
  inputRef: RefObject<TextInputInstance | null>;
}) {
  return (
    <View style={[searchStyles.container, compact && compactStyles.searchContainer]}>
      <TextInput
        testID="home-search-input"
        ref={inputRef}
        value={query}
        onChangeText={onChangeQuery}
        placeholder={scope === 'mine' ? 'Search your ratings' : 'Search all products'}
        placeholderTextColor={colors.icon + '88'}
        style={[searchStyles.input, { color: colors.text, borderColor: colors.icon + '33' }]}
        maxLength={100}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search products"
        returnKeyType="search"
      />
      <View style={searchStyles.scopeRow}>
        <TouchableOpacity
          testID="home-search-scope-mine"
          accessibilityRole="button"
          accessibilityState={{ selected: scope === 'mine' }}
          style={[
            searchStyles.scopePill,
            scope === 'mine' && { backgroundColor: colors.tint + '22', borderColor: colors.tint },
          ]}
          onPress={() => onChangeScope('mine')}
        >
          <Text
            style={[searchStyles.scopeText, { color: scope === 'mine' ? colors.tint : colors.icon }]}
          >
            Mine
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="home-search-scope-all"
          accessibilityRole="button"
          accessibilityState={{ selected: scope === 'all' }}
          style={[
            searchStyles.scopePill,
            scope === 'all' && { backgroundColor: colors.tint + '22', borderColor: colors.tint },
          ]}
          onPress={() => onChangeScope('all')}
        >
          <Text style={[searchStyles.scopeText, { color: scope === 'all' ? colors.tint : colors.icon }]}>
            All products
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const searchStyles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginTop: 12,
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  scopeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  scopePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  scopeText: {
    fontSize: 13,
    fontWeight: '600',
  },
});

function SearchResultCard({
  result,
  bg,
  textColor,
  iconColor,
  tint,
  onPress,
}: {
  result: ProductSearchResult;
  bg: string;
  textColor: string;
  iconColor: string;
  tint: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      testID={`search-result-${result.id}`}
      style={[cardStyles.card, { backgroundColor: bg }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <ProductThumb image={result.image} />
      <View style={cardStyles.info}>
        <Text style={[cardStyles.name, { color: textColor }]} numberOfLines={1}>
          {result.name}
        </Text>
        {result.brand ? (
          <Text style={[cardStyles.brand, { color: iconColor }]} numberOfLines={1}>
            {result.brand}
          </Text>
        ) : null}
        {result.unverified ? (
          <Text
            testID={`search-result-unverified-${result.id}`}
            style={[cardStyles.unverifiedBadge, { color: tint }]}
          >
            🔎 Needs review
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

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
  // Manual barcode entry (P6-006) — an add path that never touches the camera.
  const [manualVisible, setManualVisible] = useState(false);

  // ─── Search (TICKET-P6-008) ─────────────────────────────────────────────
  const [searchScope, setSearchScope] = useState<SearchScope>('mine');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInputInstance>(null);

  // The scan tab's "Search by name" affordance lands here with
  // `?focusSearch=all` (there is no route for a focused search mode, so a
  // param is the clean mechanism). Consumed once per arrival, mirroring the
  // P9-003 scan-injection seam's pattern, so re-focusing the tab later
  // doesn't re-trigger it.
  const { focusSearch } = useLocalSearchParams<{ focusSearch?: string }>();
  const consumedFocusSearch = useRef<string | null>(null);
  useEffect(() => {
    if (typeof focusSearch !== 'string' || focusSearch.length === 0) {
      consumedFocusSearch.current = null;
      return;
    }
    if (consumedFocusSearch.current === focusSearch) return;
    consumedFocusSearch.current = focusSearch;
    setSearchScope('all');
    router.setParams({ focusSearch: undefined });
    searchInputRef.current?.focus();
  }, [focusSearch, router]);

  // Slice A: filters the already-cached ratings list in memory — no network
  // request, works offline, instant. `null` ratings (nothing loaded yet /
  // errored) stays `null` so the existing loading/error/offline branches
  // below are unaffected by the query.
  const mineResults = ratings ? filterRatingsByQuery(ratings, searchQuery) : ratings;
  const trimmedQuery = searchQuery.trim();

  // Slice B: global search, active only in the "All products" scope. Makes
  // zero requests while scoped to "Mine".
  const {
    results: searchResults,
    isLoading: searchLoading,
    isLoadingMore: searchLoadingMore,
    isOffline: searchOffline,
    error: searchError,
    loadMore: searchLoadMore,
  } = useProductSearch(searchQuery, searchScope === 'all');

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (searchScope !== 'all') return;
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
      if (distanceFromBottom < 120) searchLoadMore();
    },
    [searchScope, searchLoadMore],
  );

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
      onScroll={handleScroll}
      scrollEventThrottle={200}
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
        <View style={styles.headlineRow}>
          <Text style={[styles.headline, { color: colors.text }]}>
            {isAnonymous ? 'Welcome, Guest 👋' : `Welcome back 👋`}
          </Text>
          {/* Adding a product without going through the camera tab (P6-006).
              P6-007 turns this into a two-choice sheet; this is the
              single-purpose version. */}
          <TouchableOpacity
            testID="home-add-product"
            accessibilityLabel="Add a product by barcode"
            style={[styles.addButton, { backgroundColor: colors.tint + '18' }]}
            onPress={() => setManualVisible(true)}
          >
            <Text style={[styles.addButtonText, { color: colors.tint }]}>＋</Text>
          </TouchableOpacity>
        </View>
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

      {/* Search (TICKET-P6-008) — one bar, two scopes, defaulting to Mine. */}
      <SearchBar
        query={searchQuery}
        onChangeQuery={setSearchQuery}
        scope={searchScope}
        onChangeScope={setSearchScope}
        colors={colors}
        compact={compact}
        inputRef={searchInputRef}
      />

      {/* Offline / sync-failure notices */}
      {isOffline && searchScope === 'mine' ? (
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

      {searchScope === 'mine' ? (
        <>
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
            // "Nothing rated yet" — true regardless of what's typed in the
            // search box, which is what distinguishes this from "no match"
            // below (TICKET-P6-008).
            <EmptyState
              testID="home-search-nothing-rated"
              icon="⭐"
              message={"You haven't rated anything yet.\nScan a barcode to get started!"}
              color={colors.icon}
            />
          ) : trimmedQuery && mineResults && mineResults.length === 0 ? (
            // Ratings exist, but none match the query — a different empty
            // state from "nothing rated yet", with a next step into Slice B.
            <EmptyState
              testID="home-search-no-match"
              icon="🔍"
              message={`No matches in your ratings for “${trimmedQuery}”.`}
              color={colors.icon}
              action={{
                testID: 'home-search-switch-to-all',
                label: 'Search all products →',
                color: colors.tint,
                onPress: () => setSearchScope('all'),
              }}
            />
          ) : (
            (mineResults ?? ratings ?? []).map((entry) => (
              <RatingCard
                key={entry.id}
                entry={entry}
                bg={colors.background}
                textColor={colors.text}
                iconColor={colors.icon}
                pendingSync={isQueued(entry.product.id)}
                onPress={() => router.push(`/(app)/product/${entry.product.id}`)}
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
                key={item.id}
                item={item}
                bg={colors.background}
                textColor={colors.text}
                iconColor={colors.icon}
                onPress={() => router.push(`/(app)/product/${item.id}`)}
              />
            ))
          )}
        </>
      ) : (
        <>
          {/* All products (TICKET-P6-008 Slice B) */}
          <SectionHeader title="All products" compact={compact} />

          {!isSearchableQuery(searchQuery) ? (
            <EmptyState
              testID="home-search-hint"
              icon="🔎"
              message="Type at least 2 characters to search all products."
              color={colors.icon}
            />
          ) : searchLoading ? (
            <View style={[styles.loadingRow, compact && compactStyles.loadingRow]}>
              <ActivityIndicator size="small" color={colors.tint} />
            </View>
          ) : searchOffline ? (
            <EmptyState
              testID="home-search-offline"
              icon="📴"
              message={OFFLINE_MESSAGE}
              color={colors.icon}
              action={{
                testID: 'home-search-switch-to-mine',
                label: 'Switch to Mine →',
                color: colors.tint,
                onPress: () => setSearchScope('mine'),
              }}
            />
          ) : searchError ? (
            <EmptyState
              testID="home-search-error"
              icon="⚠️"
              message={formatApiError(searchError, 'Could not search products.')}
              color={colors.icon}
            />
          ) : searchResults.length === 0 ? (
            <EmptyState
              testID="home-search-empty"
              icon="🤷"
              message={`No products found for “${trimmedQuery}”.`}
              color={colors.icon}
            />
          ) : (
            <>
              {searchResults.map((result) => (
                <SearchResultCard
                  key={result.id}
                  result={result}
                  bg={colors.background}
                  textColor={colors.text}
                  iconColor={colors.icon}
                  tint={colors.tint}
                  onPress={() => router.push(`/(app)/product/${result.id}`)}
                />
              ))}
              {searchLoadingMore ? (
                <View style={[styles.loadingRow, compact && compactStyles.loadingRow]}>
                  <ActivityIndicator size="small" color={colors.tint} />
                </View>
              ) : null}
            </>
          )}
        </>
      )}

      <View style={[styles.bottomPad, compact && compactStyles.bottomPad]} />

      <ManualBarcodeSheet visible={manualVisible} onClose={() => setManualVisible(false)} />
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
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headline: {
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: {
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 28,
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
  searchContainer: {
    marginTop: SPACING_COMPACT.tightGap,
  },
});
