# Backend Architecture

Node.js / Express / TypeScript API server. Follows an MVC pattern: Routes → Controllers → Services → Database.

---

## Directory Structure

```
server/
├── src/
│   ├── app.ts                   # Express app setup: middleware stack, route mounting
│   ├── server.ts                # HTTP server entry point
│   ├── configs/                 # Environment variable loading and validation
│   ├── controllers/             # Request/response handlers — thin, delegate to services
│   ├── middlewares/             # Express middleware (auth, rate limiting, error handler)
│   ├── routes/                  # Route definitions — apply middleware, call controllers
│   ├── services/                # Business logic and external integrations
│   │   └── imageService.ts      # sharp-based format conversion; upload to S3 raw/ prefix
│   └── generated/
│       └── prisma_client/       # Generated Prisma client — always import from here
├── prisma/
│   ├── schema.prisma            # Source of truth for the data model
│   └── migrations/              # Applied migration history
└── Dockerfile
```

---

## Middleware Stack

Applied in order in `app.ts`:

| Order | Middleware | Scope | Purpose |
|-------|-----------|-------|---------|
| 1 | `apiLimiter` | `POST /api/*` | 100 req / 15 min — broad API rate limit |
| 2 | `authLimiter` | auth endpoints | 10 req / hr — tighter limit on auth routes |
| 3 | `requireAuth` | protected routes | Validates Supabase Bearer JWT; injects `req.user` |
| 4 | `requireRegistered` | contribution routes | Checks `is_anonymous !== true`; rejects guests with `403` |
| 5 | `requireSelf(param)` | user-scoped routes | Compares `req.user.id` to route param; `403` on mismatch |
| 6 | `requireGroupMember` | group routes | Verifies `GroupMember` record exists; `403` if not |
| 7 | `requireGroupAdmin` | group admin routes | Same as above + asserts `role === 'ADMIN'` |
| 8 | Controllers | — | Handle request, call service, send response |
| 9 | `errorHandler` | global | Centralised error formatting; maps known errors to HTTP status codes |

Authorization guards (5–7) are composable and applied at the **router layer**, not inside controllers.

---

## Data Model

Full schema: `server/prisma/schema.prisma`. Summary of core models:

| Model | Key fields | Notes |
|-------|-----------|-------|
| `User` | `id`, `email?`, `username`, `avatarUrl` | `id` mirrors the Supabase user UUID |
| `Product` | `barcode` (PK), `name`, `brand`, `imageUrl`, `status`, `submittedByUserId?` | `status`: `VERIFIED \| PENDING_REVIEW \| REJECTED` |
| `Rating` | `userId`, `productId`, `taste` (Float 0–10, 0.5 steps), `comment?` | One rating per user per product |
| `Group` | `id`, `name`, `inviteCode` | Invite code is unique |
| `GroupMember` | `userId`, `groupId`, `role` | `role`: `ADMIN \| MEMBER` |
| `ProductVerification` | `productId`, `userId`, `vote`, `createdAt` | `@@unique([productId, userId])`; 2 net-approvals flip to `VERIFIED`; 2 net-rejections flip to `REJECTED` |
| `ProductEdit` | `id`, `barcode`, `authorUserId`, `originalValues` (JSON), `proposedChanges` (JSON), `status` | `status`: `PENDING \| APPLIED \| REJECTED \| EXPIRED` |
| `ProductEditVote` | `editId`, `userId`, `vote` | `vote`: `APPROVE \| REJECT`; composite unique `(editId, userId)` |
| `ProductEditDismissal` | `editId`, `userId` | Persists reviewer dismissals server-side |

**Prisma import:** Always import the client from `src/generated/prisma_client`, never from `@prisma/client` directly.

---

## API Endpoints

### Products

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/products/:barcode` | Any | Fetch product (OFF fallback on miss). Adds `unverified`, `submittedByUserId`, and `submission` block for user-submitted products. `PENDING_REVIEW` products return `404` for anonymous callers. |
| `POST` | `/products/upload-image` | Auth | Multipart image → sharp resize → S3 upload; returns `{ url }` |
| `POST` | `/products/extract-label` | Registered | Structure nutritional data from OCR text (T5) or label image (T6, 501) |
| `POST` | `/products` | Registered | Submit new product (`PENDING_REVIEW`) |
| `PATCH` | `/products/:barcode` | Registered | Correct a `PENDING_REVIEW` product (resets verifications) |
| `POST` | `/products/:barcode/verify` | Registered, non-submitter | Cast `APPROVE` vote; 2 net-approvals → `VERIFIED` |
| `DELETE` | `/products/:barcode/verify` | Registered, non-submitter | Cast `REJECT` vote; 2 net-rejections → `REJECTED` |
| `POST` | `/products/:barcode/edits` | Registered | Propose edit to `VERIFIED` product |
| `GET` | `/products/:barcode/edits/pending` | Registered | Fetch pending edit + diff for reviewer |
| `POST` | `/products/edits/:editId/votes` | Registered, non-author | Vote `APPROVE` or `REJECT` on an edit |
| `DELETE` | `/products/edits/:editId/votes` | Registered | Retract own edit vote |

### Users

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/users/me` | Self | Fetch own profile |
| `PATCH` | `/users/me` | Self | Update own profile |
| `GET` | `/users/me/ratings` | Self | Fetch own rating history |

### Groups

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/groups` | Registered | Create group |
| `GET` | `/groups/:id` | Member | Fetch group details |
| `PATCH` | `/groups/:id` | Admin | Update group name |
| `DELETE` | `/groups/:id` | Admin | Delete group |
| `POST` | `/groups/join` | Registered | Join group by invite code |
| `DELETE` | `/groups/:id/members/:userId` | Admin | Remove member |

### Auth / Ratings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/ratings` | Any | Submit or update a rating |
| `DELETE` | `/ratings/:id` | Owner | Delete own rating |

---

## Product Submission (`POST /api/products`)

Submission flow for the Add Product screen (P5-002/P5-003):

| Layer | File | Responsibility |
|-------|------|----------------|
| Route | `routes/productRoutes.ts` | `apiLimiter` → `requireAuth` → `requireRegistered` → `submitProduct` |
| Validator | `validators/productSubmissionValidator.ts` | Schema validation only — required fields, digit-only barcode (8–14 chars), non-negative numerics < 10000, `productImageUrl` must contain `/submissions/`. Throws `SubmissionValidationError(field, message)`. AI plausibility is deferred to a follow-up ticket. |
| Controller | `controllers/productController.ts` | Maps validator errors → `422 { error, reason, field }`; maps service errors → `409 { error: <code> }`; otherwise delegates and returns `201` (created) or `200` (updated own submission). |
| Service | `services/productService.ts#createSubmittedProduct` | Single Prisma transaction encapsulating the resubmission branches below. |

**Resubmission semantics** (`createSubmittedProduct`, keyed on `barcode`):

| Existing row | Caller | Outcome |
|--------------|--------|---------|
| _none_ | — | `CREATE` → `PENDING_REVIEW`, `submittedByUserId = caller` (201) |
| `VERIFIED` | any | `ProductAlreadyVerifiedError` → 409 `product_already_verified` |
| `REJECTED` | original submitter | `ProductPreviouslyRejectedError` → 409 `product_previously_rejected` |
| `REJECTED` | different user | `UPDATE` in place (preserves `Product.id` + ratings), `submittedByUserId = caller`, status → `PENDING_REVIEW`, prior `ProductVerification` rows deleted (200) |
| `PENDING_REVIEW` | different user | `ProductPendingByAnotherUserError` → 409 `submission_pending` |
| `PENDING_REVIEW` | same submitter | `UPDATE` fields, prior `ProductVerification` rows deleted, submitter unchanged (200) |

A Prisma `P2002` (unique-violation race on `barcode`) is caught at the service boundary and translated to `ProductPendingByAnotherUserError` so the controller's 409 mapping handles it uniformly.

The 422 body shape (`{ error, reason, field }`) is a wire contract with the client — the Add Product form keys field-level inline errors off `field`.

---

## Peer Verification (`POST` / `DELETE /api/products/:barcode/verify`)

Both endpoints call `castVote(barcode, userId, vote)` in `services/productVerificationService.ts`, which runs inside a single Prisma transaction:

1. **Fetch** the `Product` by barcode — `404` if not found.
2. **Guard** — `409` if status is not `PENDING_REVIEW`; `403` if the caller is the original submitter.
3. **Upsert** a `ProductVerification` row (`productId_userId` compound key) — a caller who already voted simply changes their vote.
4. **Recount** all votes for the product.
5. **Threshold flip** — if approvals ≥ 2 and approvals > rejections → `VERIFIED`; if rejections ≥ 2 and rejections > approvals → `REJECTED`. Otherwise status unchanged.
6. Return `{ verifications: <approval count> }`.

`DELETE /products/:barcode/verify` casts a `REJECT` vote (it does **not** retract a prior approval — it is an overloaded REJECT channel).

---

## Image Processing

1. **API (synchronous):** Validates raw upload (size gate: 8 MB max via `multer`; format detection via magic bytes). Converts non-JPEG/WebP to JPEG using `sharp` in `imageService.ts`. Rejects unsupported formats (`415`).
2. **Upload:** Uploads the validated JPEG to S3 at `raw/product/{uuid}.jpg` or `raw/label/{uuid}.jpg`.
3. **Lambda (async):** S3 `ObjectCreated` event triggers the resize Lambda. Writes to `processed/{uuid}.jpg` with the appropriate dimension cap (1200 px product / 1600 px label).
4. **Response:** API returns the predicted `processed/` URL immediately — does not wait for Lambda.

---

## Label Extraction

`POST /products/extract-label` has two paths:

| Input | Path | Status |
|-------|------|--------|
| `{ rawText: string }` (≥ `MIN_OCR_LENGTH = 50` chars) | Text path — hand-rolled regex parser (`labelExtractionService.ts`); English + German patterns | **Shipped (T5)** |
| Multipart image | Vision path — Google Cloud Vision `documentTextDetection`, then reuses the same parser | **Pending (T6)** — returns `501` until implemented |

**Authentication (`live` mode):** Uses Application Default Credentials (ADC) — no service account JSON key. In production the pod's `GOOGLE_APPLICATION_CREDENTIALS` env var points to a Workload Identity Federation credential config file (`type: external_account`) mounted from a ConfigMap. The Google auth library exchanges the pod's IRSA/OIDC token for a short-lived GCP access token automatically. For local `live` testing run `gcloud auth application-default login`.

**Parser design (`labelExtractionService.ts`):**
- All patterns use the `m` flag so `^` anchors to the start of each line, preventing sub-entry rows ("of which saturates", "davon Zucker") from matching the parent-nutrient patterns.
- Decimal separators: both `.` (English) and `,` (German/European) are normalised to `.` before parsing.
- Fields parsed: `energyKcal`, `carbohydrates`, `fat`, `protein`, `salt`, `servingSize`, `ingredients`.
- `name`, `brand`, `genericName` are always `null` (not extractable from nutrition tables).
- `confidence`: `high` if ≥ 5 fields parsed, `medium` if 3–4, `low` if 0–2. Never throws on no-match — returns all-null with `confidence: 'low'`.

Response always includes a `confidence: 'low' | 'medium' | 'high'` field. The client uses this to choose the default fill mode (low → "Fill manually"; medium/high → "Pre-fill & edit").

---

## Manual API Testing

A Postman collection covering every endpoint lives at `docs/postman/breadsheet.postman_collection.json` (with `breadsheet.postman_environment.json` for variables). Import both, fill in `supabaseUrl` / `supabaseAnonKey` / credentials, run the **Auth › Sign in with password** request once, and all subsequent requests will use the stored JWT automatically.

---

## Environment Variable Policy

**No inline defaults for runtime-behaviour variables.** All environment variables that control runtime behaviour must be read and validated in `server/src/configs/config.ts` at startup. If a required variable is absent or has an unexpected value the process must throw a descriptive error — never fall back silently to a local-dev default in application code.

**Mode-style variables** (e.g. `VISION_MODE`) must be validated against an explicit allowlist (`'mock' | 'live' | 'tesseract'`). Any value outside the allowlist — including an absent value — is a startup error.

**Local-dev values** belong in `.env` (git-ignored), not hardcoded in source.

This rule exists because silent defaults produce invisible misconfiguration: a server that assumes `mock` mode when `VISION_MODE` is unset will return fixture data in production without any log or alert.

---

## Background Jobs

Runs as node-cron jobs inside the server process:

| Job | Schedule | Purpose |
|-----|----------|---------|
| OFF sync | Every 5 min | Submits `VERIFIED` products/edits to Open Food Facts |
| Edit expiry | Daily | Marks `ProductEdit` records with no votes after 30 days as `EXPIRED` |
