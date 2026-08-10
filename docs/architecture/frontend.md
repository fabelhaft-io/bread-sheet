# Frontend Architecture

React Native / Expo mobile app using **Expo Router** for file-based navigation and **Supabase** for authentication.

---

## Directory Structure

```
bread-sheet-app/
├── app/                         # Expo Router file-based routes (screens only — no business logic)
│   ├── (auth)/                  # Unauthenticated route group (login, signup, post-signup flows)
│   ├── (tabs)/                  # Primary authenticated tab navigation
│   ├── (app)/                   # Authenticated screens without the tab bar (product detail, add/edit product, review screens)
│   └── (account)/               # Account management screens (change email/password, upgrade, verify)
├── features/                    # Business logic grouped by domain
│   ├── auth/                    # Auth actions and validation (no UI)
│   ├── products/                # Product submission flow — API helpers, OCR, image processing, types (no UI)
│   └── ratings/                 # Rating wire types shared by the Home tab, product screen and offline caches
├── hooks/                       # React context and custom hooks
├── lib/                         # Third-party client singletons + small utilities (Supabase, API, pending-return-to)
│   └── offline/                 # On-disk cache: versioned store, typed caches, rating outbox
├── components/                  # Shared UI components and design primitives
│   └── ui/                      # Platform-bridging components (icons, etc.)
└── constants/                   # Design tokens (colours, theme, vertical spacing)
```

---

## Routing

Expo Router maps the file system to routes. Route groups (folders wrapped in parentheses) are invisible in the URL — they exist only to apply a shared layout.

| Group | Auth required | Layout |
|-------|--------------|--------|
| `(auth)/` | No | Stack navigator, no header |
| `(tabs)/` | Yes | Bottom tab bar |
| `(app)/` | Yes | Stack navigator, no tab bar |
| `(account)/` | Yes | Stack navigator, no tab bar |

New authenticated route groups must be added to the `AUTHENTICATED_GROUPS` constant in `app/_layout.tsx` or the navigation guard will redirect them back to `/(tabs)`.

---

## Auth Architecture

### Layer diagram

```
lib/supabase.ts                  ← Supabase client (singleton)
       ↓
features/auth/                   ← All auth actions + validation helpers
       ↓
hooks/use-session.tsx            ← Session state + real-time subscription
       ↓
app/_layout.tsx                  ← Navigation guard (redirects based on session)
       ↓
app/(auth)/ + app/(account)/     ← Screens — call features/auth, handle UI only
```

### 1. Supabase Client — `lib/supabase.ts`

Single `supabase` client created from env vars at startup:

```
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
```

Throws at startup if either var is missing. Only `features/auth/` and `hooks/use-session.tsx` import the client directly — screens never reach for it.

**Session persistence (TICKET-P8-001).** The client is constructed with an explicit `storage: AsyncStorage` adapter. `persistSession` defaults to `true`, but auth-js resolves storage in the order explicit `storage` → `globalThis.localStorage` → in-memory fallback; React Native has no `localStorage`, so without the adapter the session died with the process. Two user-visible consequences of fixing this: registered users are no longer bounced to the login screen after a cold start, and anonymous users keep the same user id across restarts instead of being handed a new one that orphans their previous ratings. `autoRefreshToken` is driven off `AppState` — paused while backgrounded, resumed (and refreshed if expired) on the next foreground.

### 2. Auth Feature — `features/auth/`

All Supabase auth calls and shared validation live here. Screens import named functions instead of calling Supabase directly. This keeps route files free of SDK details.

Responsibilities:
- Wrapping every Supabase auth operation (sign in, sign up, guest sign-in, account upgrade, sign out)
- Shared input validation (email format, password rules)

### 3. Session Context — `hooks/use-session.tsx`

`SessionProvider` wraps the app and exposes `{ session, isLoading, isAnonymous }` via React context.

| Field | Type | Description |
|-------|------|-------------|
| `session` | `Session \| null` | Full Supabase session (includes `session.user`) |
| `isLoading` | `boolean` | `true` until the initial session restore completes |
| `isAnonymous` | `boolean` | `true` when the signed-in user is a guest (no email) |

On mount it:
1. Calls `supabase.auth.getSession()` to restore any persisted session (handles app re-opens)
2. Subscribes to `supabase.auth.onAuthStateChange()` to react to all future auth events

`isLoading` stays `true` until the initial `getSession()` resolves, preventing premature redirects.

### 4. Navigation Guard — `app/_layout.tsx`

`RootLayoutNav` runs a `useEffect` whenever `session`, `isLoading`, or `segments` changes:

```
isLoading = true                      → render null (splash state)
session + not in authenticated group  → router.replace('/(tabs)')
no session                            → router.replace('/(auth)/login')
```

Post-signup deep-link return: before any auth call that triggers email verification, the calling screen persists the intended destination to disk under `pendingReturnTo` (`lib/pending-return-to.ts`, backed by `expo-file-system/legacy` — not AsyncStorage). On `SIGNED_IN`, the guard reads and clears this key and navigates there instead of `/(tabs)`.

---

## Auth Flows

### Guest

```
features/auth → signInAsGuest()
  → onAuthStateChange fires (SIGNED_IN, is_anonymous = true)
  → guard redirects to /(tabs)
```

### Email / Password Sign In

```
features/auth → signIn(email, password)
  → onAuthStateChange fires
  → guard redirects to /(tabs)
```

### Sign Up

```
features/auth → signUp(email, password)
  → persist pendingReturnTo via lib/pending-return-to (if returnTo param is set)
  → email verification required before session is active
  → screen navigates to post-signup confirmation screen in (auth)/
  → user clicks magic link → app cold-launches
  → onAuthStateChange fires (SIGNED_IN)
  → guard reads pendingReturnTo, clears it, navigates there (or /(tabs) if absent)
```

### Upgrade (guest → registered)

Anonymous users can link an email and password from the Profile tab. The Supabase user ID stays the same — all ratings, submissions, and group memberships are preserved.

```
features/auth → upgradeAccount(email, password)
  → verification email sent
  → on verification: isAnonymous becomes false, profile screen updates
```

### Sign Out

```
features/auth → signOut()
  → supabase clears the persisted session from AsyncStorage
  → clearAllCaches() wipes every user-namespaced offline document (P8-001)
  → onAuthStateChange fires, session becomes null
  → guard redirects to /(auth)/login
```

The cache wipe is part of `signOut()` itself, not of the calling screen: the persisted session and the on-disk caches must go together, or the next account to sign in on the device inherits the previous one's ratings, recents and pending outbox.

---

## State Management

React Context is used for lightweight global state. All context providers are composed in `app/_layout.tsx`:

| Provider | Hook | State |
|----------|------|-------|
| `SessionProvider` | `useSession()` | Auth session, loading state, anonymous flag |
| `OutboxProvider` | `useOutbox()` | Queued offline ratings, permanent-failure notices, flush trigger |
| `RecentProductsProvider` | `useRecentProducts()` | Recently viewed products, mirrored to disk per user |

Server data is read through the offline cache described below (`hooks/use-cached-resource.ts`) rather than fetched directly in each screen. Pull-to-refresh remains the manual re-fetch mechanism, and additionally drains the rating outbox.

---

## Profile & Account Management

The **Profile tab** adapts to the user's account state:

**Guest users** see:
- Avatar with "?" and "Guest account" label
- "Create Account" row → upgrade flow in `(account)/`
- Sign Out (warns about data loss for anonymous accounts)

**Registered users** see:
- Avatar with email initial and email address
- "Change Email" and "Change Password" rows → `(account)/`
- Sign Out

On web, confirmation dialogs use `window.confirm` (Alert.alert buttons are unsupported). On native, `Alert.alert` is used.

---

## Icons

`components/ui/` contains a platform-bridging icon component that maps SF Symbols (iOS) to Material Icons (Android/web). New icons require a mapping entry in that component.

---

## Theme

`useColorScheme` detects system light/dark preference. Colour tokens are in `constants/`. The root layout wraps the app in React Navigation's `ThemeProvider`.

---

## Key Patterns

- **Route files are UI-only.** Business logic belongs in `features/` modules. Screens import from feature modules, handle loading/error state, and navigate — nothing more.
- **Supabase is the single source of truth** for auth state — never manage session tokens manually in app code.
- **`isAnonymous`** from `useSession()` is the canonical way to branch UI between guest and registered users — do not inspect `session.user` directly in screens.
- **Email validation** is centralised in `features/auth/` — do not duplicate in screens.
- **HTTP errors must go through `formatApiError`.** `lib/api.ts` throws an `ApiError` (carrying `status` and `body`); `lib/format-error.ts` exposes `formatApiError(err, fallback?)` which maps the error to safe, user-facing copy. Screens that surface caught errors **must not** display `err.message` directly — that is the path that previously leaked Prisma constraint dumps into the iOS UI. The helper produces stable copy per status class (401, 403, 404, 409, 415, 422, 429, 5xx) and for 5xx always returns the caller-supplied `fallback` so internal server text never reaches the screen.
- **Developer logging goes through `lib/log.ts`, not raw `console`.** `log.debug`/`log.info` are developer traces gated on `__DEV__` — they are stripped from release builds, so verbose diagnostics (e.g. the raw on-device OCR text) never reach production device logs. `log.warn`/`log.error` emit in all builds for real failures. This is the developer-facing channel and is strictly separate from user-facing copy (`formatApiError`); logs are never shown to users. Prefix each message with a `[tag]` (`[extract]`, `[image]`, `[add-product]`) for grep-ability in the Metro/device console.
- **Native-optional modules** used by the product-submission flow (`@react-native-ml-kit/text-recognition`, `expo-image-picker`, `expo-image-manipulator`, `expo-file-system` and `expo-file-system/legacy`) are loaded via guarded `require()` inside `features/products/`. This keeps jest-expo tests free of native shims and lets the UI gracefully fall back to manual entry if the runtime bundle doesn't ship the module. Multipart image uploads (`api.ts`) wrap the local URI in an `expo-file-system` `File` (a `Blob`), **not** the legacy React Native `{ uri, name, type }` part — Expo SDK 54+'s WinterCG `fetch` rejects the latter with "Unsupported FormDataPart implementation".
- **Colocated `*.test.tsx` files** under `app/` are excluded from the Metro bundle by `metro.config.js` (`resolver.blockList`). Without this, Expo Router's `require.context` would register them as routes and try to bundle `@testing-library/react-native` for the native runtime, which fails because it imports Node's `console`. Jest doesn't go through Metro, so tests still run via `npm test`.

---

## Product Submission (TICKET-P5-002)

The multi-step Add Product flow is rooted at `app/(app)/add-product.tsx` with all business logic under `features/products/`:

| File | Responsibility |
|------|---------------|
| `constants.ts` | `MIN_OCR_LENGTH`, image size caps, JPEG quality targets — must match the backend contract defined in P5-003 |
| `barcode.ts` | P6-006 manual-entry validation: `BARCODE_RE` (mirrors the server), `validateBarcode` (typed `reason`: `empty` / `non-digit` / `too-short` / `too-long`), `sanitizeBarcodeInput` (digits-only, for seeding from a scan), `stripBarcodeSeparators` (typing normalisation) |
| `types.ts` | `ProductSubmission`, `ExtractedLabel`, `ProductDetail` — shared wire types |
| `api.ts` | `submitProduct`, `uploadProductImage`, `extractLabelFromText`, `extractLabelFromImage`, `approveProduct`, `rejectProduct`, plus the P5-006 edit calls: `correctProduct`, `proposeProductEdit`, `getPendingEdit`, `voteOnProductEdit`, `retractProductEditVote`, `dismissProductEdit` |
| `edit-form.ts` | P5-006 edit-form logic: `productToFormValues` (pre-population), `buildEditChanges` (changed-fields diff for the proposal payload), `buildCorrectionPayload` (full PATCH payload), `formHasChanges` / `validateFormValues`, `FIELD_LABELS` (shared with the diff screen) |
| `ocr.ts` | `recogniseLabelText` — thin wrapper over `@react-native-ml-kit/text-recognition`, returns `{rawText, unavailable}` |
| `image-picker.ts` | `captureImage` — camera or library, returns the raw URI |
| `image-processing.ts` | `processCaptureForUpload` — runs `expo-image-manipulator` to resize/recompress, enforces the 2 MB client cap (`MAX_IMAGE_BYTES`) via `ImageTooLargeError`. Emits one dev-only `log.debug('[image]')` line per capture (kind, whether the resize ran or the module was unavailable, longest-edge cap, quality, processed size) |
| `extract.ts` | `extractFromLabelImage` — orchestrates OCR-then-backend: text path when OCR text ≥ `MIN_OCR_LENGTH`, image fallback otherwise, never throws. Emits one dev-only `log.debug('[extract]')` line per attempt (OCR availability, text length, chosen path, plus the raw OCR text — dev-only so it never ships to prod logs) |

### Capture feedback

`processCaptureForUpload` (the resize + recompress) runs synchronously-awaited inside the screen's `handleCapture`. Because it can take a noticeable beat on Android, the screen tracks a `processingSlot` (`'product' | 'label' | null`) and renders an in-slot indicator — an `ActivityIndicator` plus a "Processing photo…" label (testID `${slot}-photo-slot-processing`) — in place of the empty placeholder while the resize is in flight. The slot's Camera/Library buttons are disabled for the duration. Only the active slot shows the indicator; the other is unaffected. The indicator is indeterminate (a spinner, not a progress bar) because `expo-image-manipulator` does not surface resize progress.

### Reviewer flow

`app/(app)/review-product/[barcode].tsx` is the reviewer screen for peer approval. It's surfaced from the product detail screen via a "Needs review" banner that is shown when:
- the product response carries `unverified: true`
- the caller is not the submitter (`submittedByUserId !== session.user.id`)

**Anonymous viewers see the banner too (P5-007), but as a plain note.** Since P5-007 the backend no longer hides `PENDING_REVIEW` products from anonymous callers, so a guest who scans a barcode a neighbour just submitted lands on the product rather than a "not found" dead end. They read the identical title and explanation ("Needs review" / "This product was added by a user — does it look correct?") plus a third line, **"Log in to review this product."**, and the banner renders as a `View`, not a `TouchableOpacity` — no tap, no navigation to the reviewer screen. It is deliberately not a link into signup; the P5-001 `returnTo` pattern is available if that changes. The submitter check still passes for guests because the anonymous copy of the response omits `submittedByUserId` entirely.

None of this is the security boundary: `POST`/`DELETE /api/products/:barcode/verify` keep `requireRegistered` and answer an anonymous token with `403`. The reviewer screen also keeps its own `!session || isAnonymous` guard for deep links.

The reviewer screen renders every submitted field — including `null` values, shown as "Not provided" — so the reviewer can judge completeness. "Looks correct" calls `POST /api/products/:barcode/verify`; "Something looks wrong" calls `DELETE /api/products/:barcode/verify` (reused as the "no" vote channel).

---

## Manual Barcode Entry (TICKET-P6-006)

Before P6-006 the only navigation into `app/(app)/add-product.tsx` was the 404 branch of a barcode the
camera had **already read successfully**. A damaged label, an unsupported symbology, bad lighting or a
device with no camera left the user with no way in at all.

`components/manual-barcode-sheet.tsx` is the fix: a modal numeric-entry sheet that navigates to
`/(app)/product/<code>` — deliberately the *same* destination a scan produces, so every downstream state
(found, `PENDING_REVIEW`, the 404 "Add this product" screen, the P5-001 anonymous sign-up gate) is reached
identically and nothing new was added to the backend.

Three entry points, all rendering the same component:

| Where | Trigger | Notes |
|---|---|---|
| Scan tab (`app/(tabs)/scan.tsx`) | "Enter code manually" below the viewfinder | Rendered in **every** permission state — undetermined, denied, granted. Requiring the camera to reach the camera-free path would defeat the ticket. |
| Home tab (`app/(tabs)/index.tsx`) | "＋" in the header | Adding without going through the camera tab at all. P6-007 turns this into a two-choice sheet; this is the single-purpose version. |
| Product screen | Automatic, on a `400` from `GET /api/products/:barcode` | Opens pre-filled with the salvageable digits and submits via `router.replace`, so the corrected code takes the place of the broken screen instead of stacking behind it. |

**Validation is client-side and mirrors the server** (`BARCODE_RE` ≡ `productController.ts`'s
`^\d{8,13}$`). The reasons are typed and the copy is distinguishable — "too short, this has 7" is a
different mistake from "digits only, remove any letters", and a single "invalid barcode" tells the user
which of them they made: neither. Separators (space, dash, slash, dot) are stripped as the user types
because that is how codes are *written*; letters are deliberately **kept**, since silently deleting the
`X` out of a misread `4006381X33931` looks like acceptance and then fails somewhere further away.

The sheet's field state is seeded at mount (`key={initialValue}`, mounted only while open) rather than
re-synced by an effect — a pre-filled bad scan is per-opening state.

**Scanner symbologies** were widened in the same change: `ean13`, `ean8`, `upc_a`, `upc_e` plus
`code128` (much non-grocery stock) and `itf14` (case packs). A code that now reads but fails
`^\d{8,13}$` opens the sheet pre-filled with its digits instead of dead-ending; scanning is suspended
while the sheet is open.

---

## Product Detail & Rating (`app/(app)/product/[barcode].tsx`)

The product itself is read through `useCachedResource` (see *Offline & Performance* below): painted from the on-disk cache first, then revalidated with `GET /api/products/:barcode` in the background. Three terminal states, and keeping them distinct is the point:

| Outcome | State |
|---------|-------|
| `ApiError` 404 and nothing cached | "Product not found" + add/sign-up CTA (P5-001) |
| `NetworkError` and nothing cached | "You're offline" + retry (P8-002) — **never** the add CTA |
| `ApiError` 400 (bad code) and nothing cached | "That code doesn't look right" + the manual-entry sheet, pre-filled (P6-006) |
| Anything cached | The product renders; an offline strip appears if revalidation failed |

**"My rating" comes from the cached ratings list, not a second request.** `hooks/use-my-rating.ts` reads the cached `/api/users/me/ratings` payload and looks the barcode up in it. Only when this device has never cached that list (fresh install, or a deep link straight into a product) does it fetch the list once — still one request, and it primes the Home tab at the same time. The old per-product `GET /api/ratings/me/:barcode` call is gone.

When a rating is found, the slider and comment field are pre-populated, the section title flips from "How does it taste?" to "Your rating", and the submit button reads "Update Rating". This applies to anonymous users too (P8-003) — their ratings are stored server-side under their anonymous user id, which now survives a restart.

Submission always calls `POST /api/ratings`, which the backend upserts on `(userId, productId)` — there is no separate `PUT` endpoint. The screen does not differentiate between the create (`201`) and update (`200`) status codes; the wording switch is driven off whether a rating was found before submitting. A `NetworkError` on submit queues the rating in the outbox and reports success ("Saved on this device") rather than an error.

For registered users on `VERIFIED` products the screen additionally calls `GET /api/products/:barcode/edits/pending` (failures degrade to "no pending edit") to drive the P5-006 edit entry point and review banner, described below.

---

## Product Editing & Peer Review (TICKET-P5-006)

**Edit entry point (product detail screen).** Registered users see an edit affordance below the product info; it is entirely *absent* for anonymous users (no disabled state). The label and target behaviour depend on product state:

| Product state | Affordance | Submit path |
|---------------|-----------|-------------|
| `PENDING_REVIEW` | "Correct this submission" | `PATCH /api/products/:barcode` — in-place correction; verifications reset, corrector becomes submitter |
| `VERIFIED`, no pending edit | "Edit product" | `POST /api/products/:barcode/edits` — peer-reviewed proposal, changed fields only |
| `VERIFIED`, pending edit exists | Hidden; notice "An edit is already under review." | — |

**Edit form** (`app/(app)/edit-product/[barcode].tsx`): same field layout as Add Product but pre-populated from the current product values; the barcode is read-only. The submit button stays disabled until something actually changed (`formHasChanges`). The product photo can optionally be replaced — the new photo is uploaded at capture time (plausibility-gated, like Add Product) and its key is included as `productImageKey` only when replaced. All form logic lives in `features/products/edit-form.ts`.

**Review banner + diff screen.** When a registered non-author opens a product with a pending edit they haven't voted on or dismissed, a "Someone suggested a change" banner links to `app/(app)/review-edit/[editId].tsx`. The diff screen renders, per changed field, the `originalValues` snapshot (struck through, muted) against the proposed value (bold, accent) — the baseline comes from the edit record, not the live product. Unchanged fields sit in a collapsed section. Actions: "Looks correct" (`APPROVE`), "Something's wrong" (`REJECT`), and "Dismiss" (`POST /edits/:editId/dismissals`, a server-side record so the banner stays hidden across devices; not a vote). The current tally is shown ("1 of 2 approvals needed") without revealing who voted. Authors and users who already voted see a passive note instead of the action buttons.

---

## Marginal Scroll Compaction (TICKET-P5-006 FE Fixes)

A screen that overflows the viewport by only a handful of pixels reads as broken: the scroll indicator flashes, the content rubber-bands, and there is nothing meaningful below the fold. Every screen-level `ScrollView` host therefore measures itself and tightens its vertical spacing when — and only when — that closes the gap.

**The hook — `hooks/use-fit-to-screen.ts`.** `useFitToScreen()` returns `{ compact, scrollProps }`. Spread `scrollProps` onto the `ScrollView`; it supplies `onLayout` (viewport height), `onContentSizeChange` (content height), and the bounce suppressors `alwaysBounceVertical={false}` / `overScrollMode="never"`.

| Constant | Default | Meaning |
|----------|---------|---------|
| `COMPACT_MAX_OVERFLOW` | 32 px | Compact only when `0 < content − viewport ≤ this`. More overflow than this is a screen that genuinely needs to scroll. |
| `COMPACT_RELEASE_SLACK` | 8 px | Compaction is released only when the *relaxed* content fits with at least this much room to spare. |
| `COMPACT_MAX_FONT_SCALE` | 1.3 | Above this OS font scale compaction is skipped entirely — a user who asked for large text is better served by scrolling. |

**The latch (why this is not a one-liner).** Compacting removes the overflow, so re-deciding from the new measurement reports "it fits", un-compacts, re-introduces the overflow, and flickers forever. The hook never decides from a compacted measurement: it tracks the content height as it measures *uncompacted* and compares that against the viewport in both directions. While compacted the relaxed height cannot be observed, so changes to the compacted height (a section appears, text rewraps, the device rotates) are carried over to the baseline as a delta — spacing savings are constant, so the two heights move together.

**The spacing tokens — `constants/spacing.ts`.** `SPACING` documents the relaxed baseline; `SPACING_COMPACT` is its tightened counterpart. Screens keep their existing (relaxed) `StyleSheet` untouched and add a single `compactStyles` sheet built from `SPACING_COMPACT`, applied as `[styles.x, compact && compactStyles.x]`. Keeping the two sheets separate means an uncompacted screen renders exactly as it did before this feature existed, and the compaction stays one reviewable block per file.

**Accessibility guardrails (non-negotiable).**
- Only margins, padding and gaps are compacted — never font sizes.
- Never the padding *inside* a pressable. Tightening a container is free; tightening a button's own padding is what drives a touch target below 44×44. Compact overrides adjust the margin around controls, not the padding within them.
- Above `COMPACT_MAX_FONT_SCALE` the screen scrolls normally.

**Screens wired up:** `product/[barcode]`, `add-product`, `edit-product/[barcode]`, `review-product/[barcode]`, `review-edit/[editId]`, `(tabs)/index`, `(tabs)/profile`. The parallax header in `components/parallax-scroll-view.tsx` is deliberately excluded — its scroll is the point.

> Testing note: `PixelRatio.getFontScale()` falls back to the pixel *density* when the window carries no `fontScale`. That never happens on a device, but jest-expo's default window reports `fontScale: 2`, so any test that exercises the compaction path must stub `PixelRatio.getFontScale`.

---

## Offline & Performance (Phase 8)

Before this phase the app had no cache layer at all: every screen called `api.get` inside a focus effect, so re-focusing refetched and being offline meant a spinner followed by error text. "Recently Opened" lived in plain `useState` and was empty on every cold start — the single biggest contributor to the app feeling unresponsive at launch.

**Substrate: JSON files via `expo-file-system`, not SQLite.** The data is small (~200 products, at most one rating per product) and this avoids another native module, keeping jest-expo green without shims. SQLite only earns its place if offline product *search by name* is added.

### The store — `lib/offline/store.ts`

A typed, versioned, **user-namespaced** document store laid out as `<documentDirectory>offline/v<VERSION>/<userId>/<name>.json`.

| Property | Why |
|----------|-----|
| Namespaced by Supabase user id | The anonymous→registered upgrade and account switching must never leak one user's data into another's view. |
| Schema mismatch **wipes**, never migrates | These are caches; the server is the source of truth, so re-fetching always beats migration code for throwaway data. Directories from older versions are pruned once per process. |
| Failures are non-fatal | A cache that cannot be read or written degrades to "no cache", never to a broken screen. |
| Synchronous memory mirror (`peekCache`) | Lets a screen paint in its *first frame* rather than after a disk round trip. |

`setActiveCacheUser(userId)` is called from `SessionProvider` before the session lands in state, so a consumer's first render already peeks into the right namespace. With no active user every read returns `null` and every write is a no-op. When there is no document directory (web, tests) the store falls back to AsyncStorage, which is `localStorage` on web.

### The caches — `lib/offline/caches.ts`

Three documents, exposed as `ResourceCache<T>` descriptors (`peek` / `read` / `write`):

| Document | Contents | Notes |
|----------|----------|-------|
| `products` | `barcode → { data, touchedAt }` | LRU-capped at `PRODUCT_CACHE_LIMIT` (200). One map document rather than a file per barcode: eviction becomes a sort instead of a directory walk. |
| `ratings` | The `/api/users/me/ratings` payload verbatim | Also serves as the "my rating for this barcode" lookup table. |
| `recents` | The "Recently Opened" list | `viewedAt` is stored as an ISO string and revived on read. |

### Stale-while-revalidate — `hooks/use-cached-resource.ts`

```
seed synchronously from memory  → paint (no spinner on a warm hit)
  ↓ miss
read from disk                  → paint
  ↓
revalidate over the network
  ├─ success        → swap in, write through to the cache, clear isOffline
  ├─ NetworkError   → keep the cached value, raise isOffline / isStale
  └─ ApiError       → surface as `error` so the caller can branch (404 → not found)
```

The `error` / `isOffline` split is the contract: `error` means the server gave an answer, `isOffline` means it never got the question.

### `NetworkError` — `lib/api.ts`

`fetch` rejects with a bare `TypeError` when a request never leaves the device, which is indistinguishable from a programming mistake and, worse, from an HTTP failure at the call site. `lib/api.ts` now wraps that into a `NetworkError` carrying the original rejection as `cause`. `formatApiError` checks it **before** `ApiError` and returns `OFFLINE_MESSAGE` regardless of the caller's `fallback` — the fallback describes what the *server* failed to do. That single check is also what makes the online-only contribution flows (add product, edits, verification votes) report "you're offline" for free.

### Images

Product images use `expo-image` with `cachePolicy="memory-disk"`. React Native's own `Image` keeps nothing across restarts, so without this the text would render offline and the pictures would not.

### The rating outbox — `lib/offline/outbox.ts` (TICKET-P8-004)

A persisted queue of `{ barcode, taste, comment, queuedAt, attempts, nextAttemptAt }`, flushed on mount, on every app foreground, and on pull-to-refresh.

**Only ratings are queued, and that is deliberate.** A rating is owned by exactly one user and `POST /api/ratings` upserts on `(userId, productId)`, so replay is idempotent and last-write-wins is *correct* — the queued value is the user's latest intent and there is no server state that could disagree. Product submissions, edits and peer votes hinge on state that is invisible offline (the image plausibility gate, the one-pending-edit `409`, the self-vote `403`); those stay online-only.

| Behaviour | Rule |
|-----------|------|
| Collapse | Re-rating the same barcode replaces the queued item (original `queuedAt` preserved), so five slider fiddles cost one request. |
| Transient failure | `NetworkError`, 5xx, 401, 408, 429 → retry with exponential back-off from 30 s, capped at 30 min. A `NetworkError` stops the pass early — the rest of the queue would fail too. |
| Permanent failure | Any other 4xx → dropped, and the server's message is surfaced on the Home tab. Retrying a malformed request forever only hides it. |
| Optimistic UI | The queued rating is folded into the cached ratings list immediately and marked "not yet synced" on the Home tab and product screen; on success the server's version replaces it. |

**Connectivity detection.** No `@react-native-community/netinfo`. `AppState` foreground plus failure-driven retry covers the cases that matter without another native dependency; add it only if the UX proves sloppy in practice.

### Anonymous ratings (TICKET-P8-003)

Anonymous ratings were never a storage problem — `POST /api/ratings` is guarded by `requireAuth` only, and Supabase anonymous sessions satisfy it, so they have always been stored server-side under the anonymous user id. `upgradeAccount` calls `updateUser` on the *existing* session, which keeps that id, so the ratings are already attached to the right user the moment the upgrade completes. **There is no migration step and none should be written.**

What was broken was durability (fixed by P8-001) and visibility. The gates that hid a guest's own ratings from them are gone: the Home tab lists them, with the sign-up prompt sitting *above* the list rather than replacing it, and the product screen pre-fills a guest's previous score. Every contribution gate is unchanged — `requireRegistered` still guards submissions, edits, verification votes and label extraction.

Upgrading to an email that already has an account fails at `updateUser` and leaves the ratings on the anonymous id; the upgrade screen surfaces `EMAIL_ALREADY_REGISTERED_MESSAGE` inline rather than Supabase's raw copy. Merging two existing accounts is explicitly out of scope.

> Testing note: `lib/__mocks__/api.ts` is the manual mock behind a bare `jest.mock('@/lib/api')`. It keeps `ApiError` and `NetworkError` as real classes, because screens and `formatApiError` branch on `instanceof`. Tests that exercise the caches mock `expo-file-system/legacy` with an in-memory `Map` and call `setActiveCacheUser` / `__resetOfflineStoreForTests` in `beforeEach`.

## Native E2E: Android emulator + Maestro (TICKET-P9-003)

Playwright covers everything reachable through Expo web; the flows it structurally
cannot reach — camera, barcode scan, on-device OCR — are covered by Maestro against a
debug build on a headless Android emulator. `npm run test:maestro` is the single
entry point (`scripts/test-maestro.js`); the reviewer's test matrix runs it
conditionally for tickets whose diff touches camera/scan code, and the script is
self-provisioning so no per-run manual setup is needed: it resolves the Android SDK
(`ANDROID_HOME`, else common install paths) and a JDK 17+ (`JAVA_HOME`, else the
Android Studio JBR), creates a `breadsheet-e2e` AVD if none exists (installing a
system image via `sdkmanager` when needed, falling back to an existing AVD when
cmdline-tools are missing), boots the emulator headless
(`-no-window -gpu swiftshader_indirect -camera-back virtualscene`), runs
`expo prebuild` + `gradlew :app:installDebug`, starts Metro on :8081 (with
`adb reverse` so the device reaches it), wipes app data + pre-grants the CAMERA
permission, and runs `maestro test e2e/maestro`. Flows:

- `e2e/maestro/barcode-scan.yaml` — guest sign-in → Scan tab → camera UI live →
  scan → product screen.
- `e2e/maestro/manual-entry.yaml` — the camera-free manual-entry path (P6-006).

**Why the camera flow drives the scan with a deep link.** Maestro cannot control
what the emulator camera sees, so the pixel-decode step (CameraX → ML Kit) is the
one link in the chain an on-device test cannot drive. `scan.tsx` therefore has a
`__DEV__`-only seam: opening `breadsheet://scan?inject=<barcode>` feeds the exact
same `processScan` path the camera's `onBarcodeScanned` callback uses (validation →
navigation → product screen), so everything downstream of the decode is exercised
for real. The seam is dead in release builds and consumed the moment it fires.
`scripts/test-maestro-wiring.test.js` guards the wiring (npm script present, flows
target the app, runner parses) so it cannot silently rot.

**Prerequisites** are the same as `npm run test:e2e`: a reachable Supabase project
via `bread-sheet-app/.env` (guest sign-in + product lookup). Plus JDK 17+ and an
Android SDK for the Gradle build; the first Gradle run downloads dependencies and
can take 10–40 minutes. On a machine without the SDK/AVD, the runner reports the
exact missing prerequisite instead of failing confusingly (environment-prerequisite
gaps are recorded in the findings doc, not treated as code failures).
