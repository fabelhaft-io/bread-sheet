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
│   └── products/                # Product submission flow — API helpers, OCR, image processing, types (no UI)
├── hooks/                       # React context and custom hooks
├── lib/                         # Third-party client singletons + small utilities (Supabase, API, pending-return-to)
├── components/                  # Shared UI components and design primitives
│   └── ui/                      # Platform-bridging components (icons, etc.)
└── constants/                   # Design tokens (colours, theme)
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

Post-signup deep-link return: before any auth call that triggers email verification, the calling screen persists the intended destination to `AsyncStorage` under `pendingReturnTo`. On `SIGNED_IN`, the guard reads and clears this key and navigates there instead of `/(tabs)`.

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
  → onAuthStateChange fires, session becomes null
  → guard redirects to /(auth)/login
```

---

## State Management

React Context is used for lightweight global state. All context providers are composed in `app/_layout.tsx`:

| Provider | Hook | State |
|----------|------|-------|
| `SessionProvider` | `useSession()` | Auth session, loading state, anonymous flag |
| `RecentProductsProvider` | `useRecentProducts()` | In-memory list of recently viewed product barcodes |

For server data (ratings, products, groups), hooks fetch directly from the API — no global cache layer. Pull-to-refresh is the primary re-fetch mechanism.

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
| `types.ts` | `ProductSubmission`, `ExtractedLabel`, `ProductDetail` — shared wire types |
| `api.ts` | `submitProduct`, `uploadProductImage`, `extractLabelFromText`, `extractLabelFromImage`, `approveProduct`, `rejectProduct`, plus the P5-006 edit calls: `correctProduct`, `proposeProductEdit`, `getPendingEdit`, `voteOnProductEdit`, `retractProductEditVote`, `dismissProductEdit` |
| `edit-form.ts` | P5-006 edit-form logic: `productToFormValues` (pre-population), `buildEditChanges` (changed-fields diff for the proposal payload), `buildCorrectionPayload` (full PATCH payload), `formHasChanges` / `validateFormValues`, `FIELD_LABELS` (shared with the diff screen) |
| `ocr.ts` | `recogniseLabelText` — thin wrapper over `@react-native-ml-kit/text-recognition`, returns `{rawText, unavailable}` |
| `image-picker.ts` | `captureImage` — camera or library, returns the raw URI |
| `image-processing.ts` | `processCaptureForUpload` — runs `expo-image-manipulator` to resize/recompress, enforces the 5 MB client cap via `ImageTooLargeError`. Emits one dev-only `log.debug('[image]')` line per capture (kind, whether the resize ran or the module was unavailable, longest-edge cap, quality, processed size) |
| `extract.ts` | `extractFromLabelImage` — orchestrates OCR-then-backend: text path when OCR text ≥ `MIN_OCR_LENGTH`, image fallback otherwise, never throws. Emits one dev-only `log.debug('[extract]')` line per attempt (OCR availability, text length, chosen path, plus the raw OCR text — dev-only so it never ships to prod logs) |

### Capture feedback

`processCaptureForUpload` (the resize + recompress) runs synchronously-awaited inside the screen's `handleCapture`. Because it can take a noticeable beat on Android, the screen tracks a `processingSlot` (`'product' | 'label' | null`) and renders an in-slot indicator — an `ActivityIndicator` plus a "Processing photo…" label (testID `${slot}-photo-slot-processing`) — in place of the empty placeholder while the resize is in flight. The slot's Camera/Library buttons are disabled for the duration. Only the active slot shows the indicator; the other is unaffected. The indicator is indeterminate (a spinner, not a progress bar) because `expo-image-manipulator` does not surface resize progress.

### Reviewer flow

`app/(app)/review-product/[barcode].tsx` is the reviewer screen for peer approval. It's surfaced from the product detail screen via a "Needs review" banner that is shown when:
- the product response carries `unverified: true`
- the caller is registered (not anonymous)
- the caller is not the submitter (`submittedByUserId !== session.user.id`)

The reviewer screen renders every submitted field — including `null` values, shown as "Not provided" — so the reviewer can judge completeness. "Looks correct" calls `POST /api/products/:barcode/verify`; "Something looks wrong" calls `DELETE /api/products/:barcode/verify` (reused as the "no" vote channel).

---

## Product Detail & Rating (`app/(app)/product/[barcode].tsx`)

The product screen does two GETs in parallel on mount:

1. `GET /api/products/:barcode` — load-blocking. A `404` flips the screen to the "Product not found" state (P5-001).
2. `GET /api/ratings/me/:barcode` — issued only for registered users. **Any failure (including the `404` that means "not rated yet") degrades silently to "no existing rating"** so an outage on this optional lookup never blocks the product screen.

When the rating lookup returns a row, the slider and comment field are pre-populated with the existing values, the section title flips from "How does it taste?" to "Your rating", and the submit button reads "Update Rating" instead of "Submit Rating". The success screen mirrors the same wording ("Rating Updated!" vs "Rating Submitted!").

Submission always calls `POST /api/ratings`, which the backend upserts on `(userId, productId)` — there is no separate `PUT` endpoint. The screen does not differentiate between the create (`201`) and update (`200`) status codes; the wording switch is driven entirely off whether the pre-load fetch found an existing rating.

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
