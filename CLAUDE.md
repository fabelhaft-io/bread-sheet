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

Authenticated `(app)` routes: `product/[barcode]`, `add-product`, `review-product/[barcode]`. New routes must be registered in `app/(app)/_layout.tsx`.

**Auth gate:** `app/_layout.tsx` wraps the app in `<SessionProvider>`. The session hook (`hooks/use-session.tsx`) listens to `supabase.auth.onAuthStateChange()` and drives redirects — no session → `/(auth)/login`, session → `/(tabs)`. Before issuing the default post-signin redirect, the layout also checks `pendingReturnTo` (see below) and honours any stored deep-link destination.

**Supabase client** is initialized in `lib/supabase.ts` using `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`.

**Feature modules** live in `features/`:
- `auth/` — Supabase auth wrappers + validation helpers
- `products/` — Add Product flow business logic (API helpers, on-device OCR wrapper, image picker + processing, shared constants/types). Screens import from here; see `docs/architecture/frontend.md#product-submission-ticket-p5-002`.

Keep business logic in these modules — route files stay UI-only.

**Native-optional dependencies** (`@react-native-ml-kit/text-recognition`, `expo-image-picker`, `expo-image-manipulator`) used by `features/products/` are loaded via guarded `require()`. Tests (jest-expo) pass without them; the runtime must install them for the full flow to work end-to-end.

**HTTP client:** `lib/api.ts` exposes a thin typed wrapper around `fetch`. Errors surface as an `ApiError` class carrying the HTTP `status` and parsed `body`, so route files can branch on status codes (e.g. `instanceof ApiError && err.status === 404`) without re-parsing messages.

**Pending return-to:** `lib/pending-return-to.ts` persists a single deep-link destination on disk via `expo-file-system/legacy`. This survives the cold app restart triggered by email magic links. The signup screen writes it before kicking off auth; `app/_layout.tsx` reads + clears it on the post-signin redirect.

### Backend

**Pattern:** Routes → Controllers → Services → Database (MVC)

**Middleware stack** (in order in `app.ts`):
1. Rate limiting: `apiLimiter` (100 req/15min) on `/api/*`, `authLimiter` (10 req/hr) on auth endpoints
2. `requireAuth` — verifies Supabase Bearer token, injects `user` into `req` (including `isAnonymous` flag derived from the JWT `is_anonymous` claim)
3. `requireRegistered` — composable second-layer guard for contribution routes; rejects anonymous sessions with `403 { error: 'Registration required' }`. Applied after `requireAuth` on `POST /api/products` (and, when shipped, on `POST /api/products/extract-label` and the verify endpoints).
4. Controllers handle request/response
5. `errorHandler` — centralized error middleware

**Prisma client** is generated to a custom location: `src/generated/prisma_client`. Always import from there, not from `@prisma/client` directly.

**Image processing:** `services/imageService.ts` uses `sharp` for resizing; files stored in S3 (LocalStack locally).

### Data Model (Prisma schema at `server/prisma/schema.prisma`)

Core models: `User`, `Product` (barcode/brand/image), `Rating` (taste score 0–10 in 0.5 steps + optional comment), `Group`, `GroupMember` (roles: ADMIN/MEMBER), `Item`.

### Auth Flow

1. Guest: `supabase.auth.signInAnonymously()` — immediate access, email is optional
2. Registered: `signInWithPassword()` / `signUp()`
3. Backend: `authMiddleware.ts` validates the Bearer JWT via Supabase and populates `req.user`

### Infrastructure

Local dev uses Docker Compose:
- PostgreSQL 18-Alpine on port 5432 (`admin:password@localhost:5432/breadsheet`)
- LocalStack on port 4566 (emulates S3, Lambda, IAM, STS)

Production runs on EKS (Terraform-provisioned) with ArgoCD for GitOps. Database migrations run as a Kubernetes Job or initContainer before the server pod starts.

## Coding Conventions

### Environment Variables — Fail Fast, No Inline Defaults

Never use inline fallback values for environment variables that configure runtime behaviour (e.g. `process.env.VISION_MODE ?? 'mock'`). If a required variable is absent or invalid the process must throw at startup, not silently assume a local-dev default.

**Why:** Silent defaults mask misconfiguration. A server that boots quietly in `mock` mode when `VISION_MODE` is unset will return stale fixture data in production without any log or error — the bug is invisible until someone notices wrong results. Failing fast surfaces the missing config immediately, at the place where it is owned.

**How to apply:**
- Read and validate all env vars in `server/src/configs/config.ts` at startup.
- Throw a descriptive error if a required var is absent or has an unexpected value.
- Mode-style vars (e.g. `VISION_MODE`) must be in an explicit allowlist; anything outside it is an error, not a fallback.
- Local dev values belong in `.env` files (which are git-ignored), never hardcoded in source.

## Key Environment Variables

**Server (`server/.env`):**
```
PORT=3000
NODE_ENV=development
DATABASE_URL="postgresql://admin:password@localhost:5432/breadsheet"
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_DEFAULT_KEY=...
```

**Frontend (`bread-sheet-app/.env` or `app.config.js`):**
```
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=...
```

## Documentation

Architecture and data documentation lives in `docs/architecture/`:

| File | Scope |
|------|-------|
| `overview.md` | System-wide component map, data flow, external services |
| `frontend.md` | Expo/React Native app — routing, auth layers, state management, key patterns |
| `backend.md` | Express API — middleware stack, endpoints, data model, image pipeline, background jobs |
| `infrastructure.md` | Terraform/AWS resources, Docker Compose local dev, GitOps deployment pipeline |
| `data.md` | Data inventory, third-party flows, user content rights, GDPR obligations |

Ad-hoc API testing: import `docs/postman/breadsheet.postman_collection.json` and the matching `breadsheet.postman_environment.json` into Postman. The collection covers every endpoint and pre-populates the Bearer token via the Supabase sign-in request.

## ADRs

Architecture decisions are tracked in `docs/architecture-decision-records/`. Current ADRs:
- `0001-auth-provider.md` — Why Supabase Auth was chosen over alternatives

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
- Any inline code comments or JSDoc on public interfaces that are now outdated.

The documentation must reflect the code as shipped, not the code as it was before your change.
