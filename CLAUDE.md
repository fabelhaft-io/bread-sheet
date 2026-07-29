# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BreadSheet is a food rating/social app. Users scan barcodes, discover products, rate them by taste (0–10), and share within groups. The monorepo has three main pillars:

- `bread-sheet-app/` — React Native/Expo mobile frontend
- `server/` — Node.js/Express REST API backend
- `terraform/` — AWS infrastructure (EKS, RDS, S3, Lambda) + LocalStack for local dev

## Commands

### Frontend (`bread-sheet-app/`)

```sh
npm start           # Expo dev server
npm run ios         # iOS emulator
npm run android     # Android emulator
npm run web         # Web browser
npm run lint        # ESLint
```

### Backend (`server/`)

```sh
npm run dev                # Dev server with nodemon hot-reload
npm run build              # Compile TypeScript to dist/
npm start                  # Run compiled server
npm run lint               # ESLint
npm run prisma:generate    # Regenerate Prisma client (after schema changes)
npm run prisma:migrate     # Create and apply new migration (dev)
npm run db:deploy          # Deploy migrations + generate client (prod/CI)
```

### Local Infrastructure

```sh
# Start DB + LocalStack (default)
docker compose up -d

# Start DB + LocalStack + server (app-dev profile)
docker compose --profile app-dev up -d

# Inspect the database
cd server && npx prisma studio
```

## Architecture

### Frontend

**Routing:** Expo Router (file-based, like Next.js). Route groups:
- `(auth)/` — unauthenticated screens (login, signup, guest)
- `(tabs)/` — main app tab navigation (authenticated)
- `(app)/` — additional authenticated screens (product detail, add-product flow, reviewer screen)
- `(account)/` — account management screens (change email/password, upgrade, verify email)

Authenticated `(app)` routes: `product/[barcode]`, `add-product`, `review-product/[barcode]`, `edit-product/[barcode]`, `review-edit/[editId]`. New routes must be registered in `app/(app)/_layout.tsx`.

**Auth gate:** `app/_layout.tsx` wraps the app in `<SessionProvider>`. The session hook (`hooks/use-session.tsx`) listens to `supabase.auth.onAuthStateChange()` and drives redirects — no session → `/(auth)/login`, session → `/(tabs)`. Before issuing the default post-signin redirect, the layout also checks `pendingReturnTo` (see below) and honours any stored deep-link destination.

**Supabase client** is initialized in `lib/supabase.ts` using `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`. It passes an explicit `storage: AsyncStorage` adapter (P8-001) — without it auth-js falls back to in-memory storage on React Native (there is no `localStorage`), so the session died with the process: registered users saw the login screen after every cold start and anonymous users got a fresh user id that orphaned their earlier ratings. `autoRefreshToken` is driven off `AppState` (paused while backgrounded, resumed on foreground).

**Feature modules** live in `features/`:
- `auth/` — Supabase auth wrappers + validation helpers, plus `isEmailAlreadyRegistered` / `EMAIL_ALREADY_REGISTERED_MESSAGE` for the anonymous-upgrade conflict (P8-003). `signOut()` also calls `clearAllCaches()` — the persisted session and the on-disk caches must go together.
- `products/` — Add Product flow business logic (API helpers, on-device OCR wrapper, image picker + processing, shared constants/types) plus the P5-006 edit-form logic (`edit-form.ts`: pre-population, changed-fields diff, correction payload). Screens import from here; see `docs/architecture/frontend.md#product-submission-ticket-p5-002`.
- `ratings/` — rating wire types (`RatingEntry`, `UserRating`) shared by the Home tab, the product screen and the offline caches.

Keep business logic in these modules — route files stay UI-only.

**Native-optional dependencies** (`@react-native-ml-kit/text-recognition`, `expo-image-picker`, `expo-image-manipulator`) used by `features/products/` are loaded via guarded `require()`. Tests (jest-expo) pass without them; the runtime must install them for the full flow to work end-to-end.

**HTTP client:** `lib/api.ts` exposes a thin typed wrapper around `fetch`. Errors surface as an `ApiError` class carrying the HTTP `status` and parsed `body`, so route files can branch on status codes (e.g. `instanceof ApiError && err.status === 404`) without re-parsing messages. The wrapper extracts an error message from either `body.message` or `body.error` (the two shapes the backend uses). A request that never reaches the server throws **`NetworkError`** (carrying the original `fetch` rejection as `cause`) instead of a bare `TypeError` — "you're offline" and "the server said no" must stay structurally distinguishable, or an offline user gets shown "Product not found — add it?".

**User-facing error copy:** `lib/format-error.ts` exposes `formatApiError(err, fallback?)`. Screens that surface caught errors to the user must run them through this helper rather than displaying `err.message` directly. `NetworkError` is checked **first** and always yields `OFFLINE_MESSAGE`, ignoring `fallback` (which describes what the *server* failed to do) — this is also what makes the online-only contribution flows report being offline for free. Otherwise the helper maps each HTTP status class to safe copy — 401 → "Your session has expired…", 403 → server message (validators write safe copy here), 404 → "We could not find what you were looking for.", 429 → rate-limit copy, **5xx → fallback copy only (never the raw server message)**. This is the single chokepoint preventing internal errors (Prisma stack traces, FK constraint names) from being rendered on screen.

**Offline cache (Phase 8):** `lib/offline/store.ts` is a typed, versioned, **user-namespaced** JSON store over `expo-file-system` at `offline/v{VERSION}/{userId}/{name}.json` (AsyncStorage fallback when there is no document directory, i.e. web/tests). Namespacing is not optional — the anon→registered upgrade and account switching must never leak one user's data into another's view. A schema-version mismatch **wipes rather than migrates**; old version directories are pruned once per process. `setActiveCacheUser()` is called from `SessionProvider` before the session lands in state; with no active user reads return `null` and writes are no-ops. `peekCache` is a synchronous memory mirror — that is what lets a screen paint in its first frame.

`lib/offline/caches.ts` layers three typed `ResourceCache<T>` descriptors on top: `products` (barcode → product, LRU-capped at 200 in one map document), `ratings` (the `/api/users/me/ratings` payload), `recents`. `hooks/use-cached-resource.ts` is the stale-while-revalidate hook: seed from memory → disk → revalidate; a `NetworkError` keeps the cached value and raises `isOffline`, an `ApiError` surfaces as `error` so callers can branch (404 → not found). **The product screen reads "my rating" out of the cached ratings list** (`hooks/use-my-rating.ts`) instead of calling `GET /api/ratings/me/:barcode` — that endpoint is no longer used by the app. Product images use `expo-image` with `cachePolicy="memory-disk"`.

**Rating outbox:** `lib/offline/outbox.ts` is a persisted queue flushed on mount, on app foreground, and on pull-to-refresh (`hooks/use-outbox.tsx` provides it app-wide). **Only ratings are queued** — `POST /api/ratings` upserts on `(userId, productId)`, so replay is idempotent and last-write-wins is correct. Product submissions, edits and peer votes depend on server state that is invisible offline (plausibility gate, one-pending-edit `409`, self-vote `403`) and stay online-only. Repeated ratings of the same barcode collapse to the latest value; transient failures (`NetworkError`, 5xx, 401, 408, 429) retry with back-off from 30 s capped at 30 min; any other 4xx drops the item and surfaces the server's message on the Home tab. See `docs/architecture/frontend.md#offline--performance-phase-8`.

**Marginal scroll compaction:** every screen-level `ScrollView` uses `hooks/use-fit-to-screen.ts`. `useFitToScreen()` returns `{ compact, scrollProps }` — spread `scrollProps` onto the `ScrollView` (it supplies `onLayout`/`onContentSizeChange` plus `alwaysBounceVertical={false}` and `overScrollMode="never"`), and use `compact` to swap in the screen's `compactStyles` sheet. `compact` is true only when the content overflows the viewport by ≤ `COMPACT_MAX_OVERFLOW` (32 px); more overflow than that scrolls normally. The hook **latches** — it decides from the last *uncompacted* content height, never from a compacted measurement, otherwise compacting removes the overflow and the screen oscillates. Compaction is skipped entirely above `COMPACT_MAX_FONT_SCALE` (1.3). Spacing tokens live in `constants/spacing.ts` as a `SPACING` / `SPACING_COMPACT` pair; base stylesheets stay untouched so an uncompacted screen is pixel-identical. **Only margins/padding/gaps are compacted — never font sizes, and never the padding inside a pressable** (that is what would push a touch target below 44×44). See `docs/architecture/frontend.md#marginal-scroll-compaction-ticket-p5-006-fe-fixes`.

**Pending return-to:** `lib/pending-return-to.ts` persists a single deep-link destination on disk via `expo-file-system/legacy`. This survives the cold app restart triggered by email magic links. The signup screen writes it before kicking off auth; `app/_layout.tsx` reads + clears it on the post-signin redirect.

**Anonymous ratings (P8-003):** anonymous ratings have always been stored server-side (`POST /api/ratings` is guarded by `requireAuth` only) and `upgradeAccount` keeps the same Supabase user id, so **no migration code exists or should be written**. The Home tab and the product screen show a guest their own ratings; the sign-up prompt sits above the list rather than replacing it. Every contribution gate is unchanged.

**Test mocks:** `lib/__mocks__/api.ts` is the manual mock behind a bare `jest.mock('@/lib/api')` — it keeps `ApiError` and `NetworkError` as real classes because screens branch on `instanceof`. `jest.config.js` maps `@react-native-async-storage/async-storage` to the package's own in-memory jest mock (it throws at import time without its native module).

### Backend

**Pattern:** Routes → Controllers → Services → Database (MVC)

**Middleware stack** (in order in `app.ts`):
1. `requestLogger` — emits one structured `request:start` (debug) and one `request:finish` (info/warn/error depending on status) line per request with `method`, `path`, `status`, `durationMs`, `userId`, `isAnonymous`, `ip`, and `x-request-id` (when supplied). Mounted before rate-limiting so even throttled requests are recorded.
2. Rate limiting: `apiLimiter` (100 req/15min) on `/api/*`, `authLimiter` (10 req/hr) on auth endpoints
3. `requireAuth` — verifies Supabase Bearer token, injects `user` into `req` (including `isAnonymous` flag derived from the JWT `is_anonymous` claim)
4. `requireRegistered` — composable second-layer guard for contribution routes; rejects anonymous sessions with `403 { error: 'Registration required' }`. Applied after `requireAuth` on `POST /api/products`, `POST /api/products/extract-label`, both `POST`/`DELETE /api/products/:barcode/verify`, and all P5-006 edit write paths (`PATCH /api/products/:barcode`, `POST /api/products/:barcode/edits`, `POST`/`DELETE /api/products/edits/:editId/votes`, `POST /api/products/edits/:editId/dismissals`).
5. Controllers handle request/response
6. `errorHandler` — centralized error middleware with a two-channel design. **Server side:** logs full detail (stack, Prisma `code`, `meta`, original message, path, method, userId) via winston. **Client side:** sanitized JSON body of shape `{ message, code? }`. 5xx errors and unknown Prisma errors collapse to a generic message (`"Something went wrong on our end. Please try again."`); the original `err.message` is only forwarded when the status is 4xx and the error does not set `expose: false`. Known Prisma codes are mapped to safe copy: `P2002` → 409 `unique_violation`, `P2003` → 409 `foreign_key_violation`, `P2025` → 404 `not_found`. The `AppError` interface exposes `status`, `code?`, and `expose?` for controllers that want stricter sanitisation.

**Prisma client** is generated to a custom location: `src/generated/prisma_client`. Always import from there, not from `@prisma/client` directly.

**Image processing:** `services/imageService.ts` converts uploads to JPEG (format normalisation) and stores the raw file in S3 at `raw/{kind}/{uuid}.jpg`, returning the predicted `processed/{uuid}.jpg` object **key** immediately (`{ imageKey }`; the client echoes it back as `productImageKey` in the submission). The S3 client's addressing style is selected by `S3_MODE` (`localstack` forces path-style, which LocalStack requires; `aws` uses the SDK default). A Lambda function (triggered by S3 `ObjectCreated` events on the `raw/` prefix) handles the definitive resize (1200 px for product photos, 1600 px for label images) and writes to `processed/`. The S3 bucket and Lambda are provisioned in `terraform/` for AWS; locally, `scripts/localstack-init.sh` provisions all three (bucket, Lambda, S3 trigger) on LocalStack startup — build the Lambda first (`cd server/lambda/imageResizer && npm run build`), no local Terraform needed.

**Image URLs — keys in DB, resolved at read time:** `Product.image` stores S3 object keys (`processed/{uuid}.jpg`) for user uploads, or absolute external URLs for Open Food Facts products. `imageService.resolveImageUrl()` converts stored values to client-usable URLs at serialization time: `http(s)://` values pass through, keys get prefixed with `ASSET_BASE_URL`. Every endpoint serializing a product must apply it (currently `GET /products/:barcode` and rating responses that include the product). Never persist absolute URLs for our own uploads — the asset base (LocalStack host, S3 region, future CDN) must stay a config-only concern.

**Image plausibility / abuse gate (P5-005):** `services/imagePlausibilityService.ts` runs an AI check (Gemini multimodal, gated by `PLAUSIBILITY_MODE=mock|gemini`) inside `uploadImage` **before** the S3 write — so a rejected image is never persisted (no orphans). Both `kind=product` and `kind=label` uploads are gated. It returns one of four verdicts: `ok` (proceeds; for `product` also returns front-of-pack `name`/`brand`/`genericName` suggestions used to pre-fill the Add Product form), `not_a_product`/`unusable` (`422` with actionable copy, no record), or `abuse` (`422` with generic copy + a `UserAbuseFlag` row recording the model's free-text reason server-side). The specific abuse reason is never returned to the client.

### Data Model (Prisma schema at `server/prisma/schema.prisma`)

Core models: `User`, `Product` (barcode, name, brand, status `VERIFIED|PENDING_REVIEW|REJECTED`, `submittedByUserId?` — original author, never changes after creation; `lastModifiedByUserId?` — set when a `ProductEdit` is APPLIED; nutrition fields: `energyKcal`, `carbohydrates`, `sugars`, `fat`, `saturatedFat`, `protein`, `salt`, `servingSize`, `ingredients`), `Rating` (taste score 0–10 in 0.5 steps + optional comment; `@@unique([userId, productId])` — one rating per user per product; resubmissions upsert the existing row), `Group`, `GroupMember` (roles: ADMIN/MEMBER), `ProductVerification` (`productId`, `userId`, `vote`; `@@unique([productId, userId])`; 2 net-approvals → VERIFIED, 2 net-rejections → REJECTED), `UserAbuseFlag` (`userId`, `reason?`, `createdAt`; moderation record raised when an uploaded image is judged abusive — see the image plausibility gate. Count + free-text reason only, no category), plus the P5-006 edit family: `ProductEdit` (`barcode`, `authorUserId`, `originalValues`/`proposedChanges` JSON, status `PENDING|APPLIED|REJECTED|EXPIRED`, `expiresAt` = createdAt + 2 years; a partial unique index `one_pending_edit_per_product` — hand-written SQL in the migration, Prisma's DSL can't express it — enforces one PENDING edit per barcode at the DB layer), `ProductEditVote` (`@@unique([editId, userId])`; duplicate votes are 409s, not upserts), `ProductEditDismissal` (`@@unique([editId, userId])`; persists review-banner dismissals server-side).

**Product visibility (P5-007):** `GET /api/products/:barcode` returns `PENDING_REVIEW` products to **every** caller — anonymous included — with `unverified: true` and the `submission` block; the anonymous copy omits `submittedByUserId` (it links a user UUID to content and only the registered client uses it, to suppress the banner on your own submission). `REJECTED` products are `404` for everyone. The visibility change is UX only: every write path keeps `requireRegistered`, so an anonymous token still gets `403` from the verify routes. Client side, the "Needs review" banner renders for guests as a non-interactive `View` with an extra "Log in to review this product." line instead of a `TouchableOpacity` into the reviewer screen. Known and accepted side effect: pending products are now also ratable by anonymous users, since `POST /api/ratings` is `requireAuth`-only.

**Product editing & peer review (P5-006):** `PATCH /api/products/:barcode` corrects a `PENDING_REVIEW` product in place (verifications reset, corrector becomes submitter — the only shortcut). Every change to a `VERIFIED` product goes through `POST /api/products/:barcode/edits` and peer voting; 2 approvals apply the changes (same `Product.id`, so ratings stay attached; `lastModifiedByUserId` set to the edit author), 2 rejections discard them, 1–1 waits for a third voter. Logic lives in `services/productEditService.ts`. A daily in-process job (`src/jobs/editExpiryJob.ts`, plain `setInterval` started in `server.ts`) expires voteless PENDING edits after 2 years. In-app notifications and OFF sync enqueueing are deferred (`TODO(P5-006-followup)` / `TODO(P6-005)` markers in the service).

### Auth Flow

1. Guest: `supabase.auth.signInAnonymously()` — immediate access, email is optional
2. Registered: `signInWithPassword()` / `signUp()`
3. Backend: `authMiddleware.ts` validates the Bearer JWT via Supabase and populates `req.user`

### Infrastructure

Local dev uses Docker Compose:
- PostgreSQL 18-Alpine on port 5432 (`admin:password@localhost:5432/breadsheet`)
- LocalStack on port 4566 (emulates S3, Lambda, IAM, STS)

Cloud environments (`dev`, `production`) run on EKS (Terraform-provisioned: VPC + EKS + RDS + S3 + image-resizer Lambda) with ArgoCD for GitOps. Database migrations run as an initContainer (`npm run db:deploy`) before the server pod starts. The server **container image** is published to **GitHub Container Registry** (`ghcr.io/fabelhaft-io/bread-sheet-server`, free public package) by `.github/workflows/build-image.yml` — not ECR.

**Terraform layout (`terraform/`):** one root, three environments selected by `-var-file` (`environments/{local,dev,production}.tfvars`). Cloud resources (VPC/EKS/RDS/IRSA in `network.tf`/`eks.tf`/`rds.tf`/`irsa.tf`, plus GCP WIF in `gcp-wif.tf`) are gated on `local.cloud_count` — created only when `localstack_endpoint == ""`, so the `local` environment provisions S3 + Lambda only. State is an S3 remote backend with per-env keys (`backend.tf` + `environments/<env>.s3.tfbackend`). The server pod accesses S3 via IRSA, and Google Cloud (Vision/Vertex) via **Workload Identity Federation** — both keyless (no static keys). k8s manifests live in `terraform/k8s/`. See `docs/architecture/infrastructure.md` for the bootstrap + apply runbook.

## Coding Conventions

### Environment Variables — Fail Fast, No Inline Defaults

Never use inline fallback values for environment variables that configure runtime behaviour (e.g. `process.env.VISION_MODE ?? 'mock'`). If a required variable is absent or invalid the process must throw at startup, not silently assume a local-dev default.

**Why:** Silent defaults mask misconfiguration. A server that boots quietly in `mock` mode when `VISION_MODE` is unset will return stale fixture data in production without any log or error — the bug is invisible until someone notices wrong results. Failing fast surfaces the missing config immediately, at the place where it is owned.

**How to apply:**
- Read and validate all env vars in `server/src/configs/config.ts` at startup.
- Throw a descriptive error if a required var is absent or has an unexpected value.
- Mode-style vars (e.g. `VISION_MODE`) must be in an explicit allowlist; anything outside it is an error, not a fallback.
- Local dev values belong in `.env` files (which are git-ignored), never hardcoded in source.

### Regexes Over User Input — No Ambiguous Quantifiers, Always Bounded

Any regex applied to client-supplied text must be unable to backtrack super-linearly, and the text it runs on must have a length cap.

**Why:** Node is single-threaded, so a quadratic regex is a full-API outage, not a slow request. This is not hypothetical here — four patterns in `labelExtractionService.ts` wrote an optional dash as `[ \t]*[-]?[ \t]*`, where both `[ \t]*` runs match a space. One legal 97.7 KB `POST /api/products/extract-label` blocked the event loop for **~27 seconds** for every user of the service (CodeQL `js/polynomial-redos`). The rewrite to `[ \t]*(?:-[ \t]*)?` accepts identical input and runs in ~8 ms.

**How to apply:**
- Two adjacent quantifiers must not accept the same character. Put an optional separator *inside* one group (`(?:-[ \t]*)?`) instead of between two runs of the same class.
- A `[^…]*` run must be disjoint from whatever follows it (`[^\d\n]*` before `\d+`).
- Cap the input length at the controller before parsing, and measure the **raw** string — `.trim().length` reports 0 for a body that is almost entirely whitespace, which is the attack shape.
- Add a timing regression test where the pre-fix and post-fix costs differ by orders of magnitude, so the budget can't flake (see the `ReDoS resistance` block in `labelExtractionService.test.ts`).

## Key Environment Variables

**Server (`server/.env`):**
```
PORT=3000
NODE_ENV=development
DATABASE_URL="postgresql://admin:password@localhost:5432/breadsheet"

# TLS for the runtime pg connection pool (the `@prisma/adapter-pg` driver adapter in
# src/db.ts — a different TLS stack from the Prisma migration engine). No default —
# must be explicit: disabled | verify-full.
#   - disabled    : local Postgres (docker-compose) speaks no TLS.
#   - verify-full : RDS. Verifies the server cert against the RDS CA bundle shipped
#                   in the Docker image (configs/databaseConfig.ts strips `sslmode`
#                   from the URL and sets ssl:{ ca, rejectUnauthorized:true }).
# Note: pg >= 8.22 treats URL `sslmode=require` as verify-full against the *default*
# trust store, which the RDS CA is NOT in — so relying on the URL alone aborts the
# handshake at query time ("could not accept SSL connection: EOF"). Hence this var.
DB_SSL=disabled

# DB authentication method.
#   - password : static password in DATABASE_URL (local, legacy prod).
#   - iam      : RDS IAM auth — mints a 15-min token per connection via @aws-sdk/rds-signer.
#                Requires DB_SSL=verify-full, AWS_REGION, and the DB user to have rds_iam grant.
#                The ECS startup script (scripts/start.sh) also mints a token for the Prisma
#                migration engine (which reads DATABASE_URL directly).
DB_AUTH=password                              # password | iam  (defaults to password if unset)

# When DB_AUTH=iam, these are used by scripts/start.sh to assemble a token-bearing
# DATABASE_URL for the migration engine:
# DB_HOST=breadsheet-dev-database-1.cna48wy46m01.eu-west-1.rds.amazonaws.com
# DB_PORT=5432
# DB_USER=breadsheet_iam
# DB_NAME=breadsheet

SUPABASE_URL=...
SUPABASE_PUBLISHABLE_DEFAULT_KEY=...

# S3 image storage
AWS_ENDPOINT_URL=http://localhost:4566    # SDK endpoint only — LocalStack locally (docker-compose overrides to
                                          # http://localstack:4566); unset/real endpoint in prod.
S3_BUCKET_NAME=breadsheet-images-local
S3_MODE=localstack                        # localstack | aws  (no default — must be explicit). localstack forces
                                          # path-style addressing, which LocalStack requires (its virtual-hosted
                                          # bucket hostnames don't resolve inside the Docker network).
# Public base URL where stored image KEYS resolve (includes the bucket part).
# Must be reachable from the DEVICE running the app — locally use the same LAN
# host as EXPO_PUBLIC_API_URL. AWS: https://<bucket>.s3.<region>.amazonaws.com
# (or a CDN domain). No default — must be explicit.
ASSET_BASE_URL=http://192.168.x.x:4566/breadsheet-images-local

# Logging
# LOG_LEVEL overrides the default (debug in dev, info in prod, warn in test).
# Useful values: error | warn | info | http | verbose | debug | silly
LOG_LEVEL=debug

# Vision / OCR / structured extraction
VISION_MODE=mock                          # mock | live | llm  (no default — must be explicit)
# For `live` (Google Cloud Vision OCR) locally: run `gcloud auth application-default login` on the
# HOST machine (not inside Docker). docker-compose mounts the resulting ADC file into the container
# at /root/.config/gcloud/application_default_credentials.json automatically.
# In prod (Fargate): keyless via Workload Identity Federation — see the GCP_WORKLOAD_IDENTITY_* vars
# below; both the Vision and Gemini/Vertex clients use it. No credential file is mounted.
# For `llm` (Gemini multimodal — image → ExtractedLabel JSON in one call):

# Image plausibility / abuse gate on uploads (P5-005). Independent of VISION_MODE.
PLAUSIBILITY_MODE=mock                     # mock | gemini  (no default — must be explicit)

# Gemini credentials (shared by VISION_MODE=llm and PLAUSIBILITY_MODE=gemini via
# services/geminiClient.ts). Auth method is chosen by env — the calling code is identical:
#   - Local default: GEMINI_API_KEY (Google AI Studio Developer API).
GEMINI_API_KEY=...                        # required unless GOOGLE_GENAI_USE_VERTEXAI=true
#   - Prod (keyless): Vertex AI via Workload Identity Federation — set the vars below INSTEAD of
#     GEMINI_API_KEY. SA needs roles/aiplatform.user.
# GOOGLE_GENAI_USE_VERTEXAI=true
# GOOGLE_CLOUD_PROJECT=...
# GOOGLE_CLOUD_LOCATION=europe-west1
#
# GCP Workload Identity Federation (Fargate, keyless). When BOTH are set, services/gcpWorkloadIdentity.ts
# builds a google-auth AwsClient that federates the ECS *task role* into GCP and impersonates the SA;
# the Gemini (Vertex) and Cloud Vision clients use it. Unset (local) → default ADC. AWS creds come from
# the ECS container endpoint via the AWS SDK default provider chain (NOT IMDS — IMDS doesn't serve
# task-role creds on Fargate). Set BOTH or neither.
# GCP_WORKLOAD_IDENTITY_AUDIENCE=//iam.googleapis.com/projects/<num>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
# GCP_SERVICE_ACCOUNT_EMAIL=<sa>@<project>.iam.gserviceaccount.com

# Deep link scheme used by GET /auth/callback to bounce users back into the app after email
# verification. exp+breadsheet for Expo Go; breadsheet for a production build.
APP_DEEP_LINK_SCHEME=exp+breadsheet
```

**Frontend (`bread-sheet-app/.env`):**
```
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=...

# URL of the server's /auth/callback endpoint. Supabase redirects here after email
# verification; the server bounces the user into the app via the deep link scheme.
EXPO_PUBLIC_AUTH_REDIRECT_URL=http://localhost:3000/auth/callback
```

## Documentation

Architecture and data documentation lives in `docs/architecture/`:

| File | Scope |
|------|-------|
| `overview.md` | System-wide component map, data flow, external services |
| `frontend.md` | Expo/React Native app — routing, auth layers, state management, key patterns |
| `backend.md` | Express API — middleware stack, endpoints, data model, image pipeline, background jobs |
| `infrastructure.md` | Terraform/AWS resources, Docker Compose local dev, GitOps deployment pipeline |
| `cheap-prod-fargate.md` | Plan: low-cost always-on prod on ECS Fargate (replaces EKS); EKS kept as a sandbox |
| `fargate-handbuild.md` | Living runbook: build the Fargate stack by hand (learn-by-doing) then import to Terraform; tracks per-step status |
| `data.md` | Data inventory, third-party flows, user content rights, GDPR obligations |

Ad-hoc API testing: open `docs/bruno/` as a collection in [Bruno](https://www.usebruno.com/). Copy `docs/bruno/environments/.env.example` to `docs/bruno/environments/.env` and fill in your Supabase credentials. Run **Auth › Sign in with password** (or **Sign in anonymously**) once — the post-response script stores the JWT in `accessToken` automatically. All other requests use it via their bearer auth.

## ADRs

Architecture decisions are tracked in `docs/architecture-decision-records/`. Current ADRs:
- `0001-auth-provider.md` — Why Supabase Auth was chosen over alternatives
- `0002-rds-database-credentials.md` — RDS auth: SSM password now, keyless IAM auth (Prisma driver adapter + `pg` password callback) deferred as a post-build adaptation

## Mandatory Post-Implementation Steps

These steps are **required** after every implementation or code change, without exception:

### 1. Tests
- After implementing or modifying any feature, add or update tests to cover the new behaviour.
- Backend: integration tests live in `server/src/__tests__/`. Run `npm test` in `server/` to verify the full suite passes before considering work done.
- Frontend: component and hook tests live alongside their source files. Run `npm test` in `bread-sheet-app/` to verify.
- Never leave a test suite in a failing state. If pre-existing tests break due to your change, fix them — do not skip or comment them out.

### 2. Documentation
After any implementation, update all affected documentation files before finishing:
- **`CLAUDE.md`** (this file) — update if the architecture, middleware stack, data model, commands, or environment variables change.
- **`README.md`** — update if setup steps, running instructions, or project structure change.
- **`docs/architecture/`** — update the relevant file (`overview.md`, `frontend.md`, `backend.md`, `infrastructure.md`, or `data.md`) if the implementation changes anything in that file's scope.
- **`docs/architecture-decision-records/`** — add a new ADR if the implementation introduces a significant architectural choice (new library, infrastructure pattern, auth approach, etc.).
- **`docs/bruno/`** — add or update `.bru` request files for any new or changed endpoints; update `script:post-response` blocks if response shapes change.
- Any inline code comments or JSDoc on public interfaces that are now outdated.

The documentation must reflect the code as shipped, not the code as it was before your change.
