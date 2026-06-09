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
│   │   ├── imageService.ts      # sharp-based format conversion; upload to S3 raw/ prefix
│   │   └── imagePlausibilityService.ts # AI plausibility / abuse gate on uploads (Gemini)
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
| 1 | `requestLogger` | global | Structured per-request log (`request:start` + `request:finish`) including method, path, status, duration, userId, isAnonymous, IP, and `x-request-id` |
| 2 | `apiLimiter` | `POST /api/*` | 100 req / 15 min — broad API rate limit |
| 3 | `authLimiter` | auth endpoints | 10 req / hr — tighter limit on auth routes |
| 4 | `requireAuth` | protected routes | Validates Supabase Bearer JWT; injects `req.user` |
| 5 | `requireRegistered` | contribution routes | Checks `is_anonymous !== true`; rejects guests with `403` |
| 6 | `requireSelf(param)` | user-scoped routes | Compares `req.user.id` to route param; `403` on mismatch |
| 7 | `requireGroupMember` | group routes | Verifies `GroupMember` record exists; `403` if not |
| 8 | `requireGroupAdmin` | group admin routes | Same as above + asserts `role === 'ADMIN'` |
| 9 | Controllers | — | Handle request, call service, send response |
| 10 | `errorHandler` | global | Two-channel sanitiser — full detail to logs, generic copy to client |

Authorization guards (6–8) are composable and applied at the **router layer**, not inside controllers.

---

## Logging

A single winston logger (`src/logger.ts`) drives all server output. Levels are chosen automatically by `NODE_ENV` and can be overridden with the `LOG_LEVEL` env var:

| `NODE_ENV` | Default level | Console output? |
|------------|---------------|-----------------|
| `production` | `info` | — file transports only (`combined.log`, `error.log`) |
| `test` | `warn` | — keeps the vitest output clean |
| anything else | `debug` | yes — colorised, timestamped, printf-style |

**Request logging.** `middlewares/requestLogger.ts` emits two structured lines per request:

- `request:start` (debug) when the request first hits the middleware — useful for spotting hangs that never reach `finish`.
- `request:finish` (info / warn / error depending on status) on the response `finish` event. The payload is:
  ```ts
  { method, path, status, durationMs, userId?, isAnonymous?, ip, requestId? }
  ```
  `userId` / `isAnonymous` are populated when `requireAuth` has already run for that request, which lets you grep the log for everything one user did. `requestId` is taken from the `x-request-id` header if the caller sets one.

Operationally this means a single rating attempt by an anonymous user produces lines like:

```
12:31:47.103 debug request:start {"method":"POST","path":"/api/ratings","ip":"::ffff:192.168.1.4"}
12:31:47.198 error unhandled error in request {"method":"POST","path":"/api/ratings","status":500,"userId":"anon-1","isAnonymous":true,"errorName":"PrismaClientKnownRequestError","prismaCode":"P2003","stack":"…"}
12:31:47.199 error request:finish {"method":"POST","path":"/api/ratings","status":500,"durationMs":96,"userId":"anon-1","isAnonymous":true,"ip":"::ffff:192.168.1.4"}
```

…while the client only ever sees `{ message: "A referenced item does not exist yet. Please refresh and try again.", code: "foreign_key_violation" }`.

---

## Error Handling

The global `errorHandler` has a strict two-channel design that keeps internal detail server-side:

1. **Server log channel** — winston `error` for 5xx, `warn` for handled 4xx. Payload includes the path, method, userId, error name, original message, Prisma `code` and `meta` (if any), and the full stack.
2. **Client response channel** — JSON body of shape `{ message: string, code?: string }`. The `message` is **never** the original `err.message` for 5xx responses; it is a fixed, generic string. For 4xx, the original message is forwarded unless the caller explicitly sets `expose: false` on the error.

**Prisma error mapping.** Any Prisma error (`PrismaClientKnownRequestError`, `PrismaClientValidationError`, `PrismaClientUnknownRequestError`, `PrismaClientInitializationError`, `PrismaClientRustPanicError`) is detected by `err.name` and translated:

| Prisma code | Status | Client `code` | Client `message` |
|-------------|--------|---------------|------------------|
| `P2002` | 409 | `unique_violation` | `That item already exists.` |
| `P2003` | 409 | `foreign_key_violation` | `A referenced item does not exist yet. Please refresh and try again.` |
| `P2025` | 404 | `not_found` | `Not found.` |
| _anything else_ | 500 | — | `Something went wrong on our end. Please try again.` |

The `P2003` mapping catches the common "anonymous user rates a product before `POST /api/users/sync` has run" case — the client now sees a recoverable message instead of a raw Prisma constraint dump.

**`AppError` interface** for controllers that want to throw structured errors:

```ts
interface AppError extends Error {
  status?: number;   // HTTP status; defaults to 500
  expose?: boolean;  // forward err.message to client? defaults to true for 4xx, false for 5xx
  code?: string;     // optional machine-readable code (e.g. "product_already_verified")
}
```

---

## Data Model

Full schema: `server/prisma/schema.prisma`. Summary of core models:

| Model | Key fields | Notes |
|-------|-----------|-------|
| `User` | `id`, `email?`, `username`, `avatarUrl` | `id` mirrors the Supabase user UUID |
| `Product` | `barcode` (PK), `name`, `brand`, `imageUrl`, `status`, `submittedByUserId?` | `status`: `VERIFIED \| PENDING_REVIEW \| REJECTED` |
| `Rating` | `userId`, `productId`, `taste` (Float 0–10, 0.5 steps), `comment?`, `createdAt`, `updatedAt` | `@@unique([userId, productId])` — one rating per user per product; resubmission upserts the existing row (`createdAt` preserved, `updatedAt` advances) |
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
| `POST` | `/products/upload-image` | Auth | Multipart image → plausibility/abuse gate → S3 upload. `422 { error: 'image_rejected', reason }` if rejected (nothing stored). For `kind=product` returns `{ url, name, brand, genericName }`; for `kind=label` returns `{ url }` |
| `POST` | `/products/extract-label` | Registered | Structure nutritional data from OCR text or label image; `VISION_MODE` selects the image pipeline (mock/live/llm) |
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

### Ratings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/ratings` | Auth | Upsert the caller's rating for a product. `201` on first submission, `200` on update of an existing `(userId, productId)` row. |
| `GET` | `/ratings/me/:barcode` | Auth | Return the caller's rating for a product, or `404` if they haven't rated it yet. Used by the product screen to pre-populate the form on a return visit. |
| `GET` | `/ratings/product/:barcode` | Auth | All ratings for a product (most recent first) with author id / username / avatar. |
| `DELETE` | `/ratings/:id` | Owner | Delete own rating |

---

## Product Submission (`POST /api/products`)

Submission flow for the Add Product screen (P5-002/P5-003):

| Layer | File | Responsibility |
|-------|------|----------------|
| Route | `routes/productRoutes.ts` | `apiLimiter` → `requireAuth` → `requireRegistered` → `submitProduct` |
| Validator | `validators/productSubmissionValidator.ts` | Schema validation only — required fields, digit-only barcode (8–14 chars), non-negative numerics < 10000, `productImageUrl` must contain `/processed/` (i.e. must be a server-issued URL from `POST /products/upload-image`). Throws `SubmissionValidationError(field, message)`. The product image is plausibility-checked at upload time (P5-005, see Image Processing); nutritional-value plausibility (kcal ranges, macro sums) is still deferred to a follow-up ticket. |
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

1. **API (synchronous):** Validates raw upload (size gate: 8 MB max via `multer`; format detection via magic bytes). Rejects unsupported formats (`415`).
2. **Plausibility / abuse gate (synchronous, P5-005):** `imagePlausibilityService.checkImage(buffer, mime, kind)` runs on the in-memory buffer **before** any S3 write. Gated by `PLAUSIBILITY_MODE` (`mock` accepts all; `gemini` runs a Gemini multimodal classification). Applies to **both** `product` and `label` uploads. Verdicts:
   - `ok` → proceed. For `product` photos the same call also returns front-of-pack `name`/`brand`/`genericName` suggestions (returned to the client to pre-fill the Add Product form).
   - `not_a_product` / `unusable` → `422 { error: 'image_rejected', reason }` with actionable copy; nothing stored, no record.
   - `abuse` → `422` with **generic** copy; a `UserAbuseFlag` row (`userId`, `reason`, `createdAt`) is recorded server-side — count + free-text reason only, no category. The model's specific reason is never returned to the client.
3. **Upload:** Converts the validated bytes to JPEG using `sharp` in `imageService.ts` and uploads to S3 at `raw/product/{uuid}.jpg` or `raw/label/{uuid}.jpg`.
4. **Lambda (async):** S3 `ObjectCreated` event triggers the resize Lambda. Writes to `processed/{uuid}.jpg` with the appropriate dimension cap (1200 px product / 1600 px label).
5. **Response:** API returns the predicted `processed/` URL immediately — does not wait for Lambda.

Because the gate runs before the S3 write, a rejected image is never persisted (no orphan objects to reap).

---

## Label Extraction

`POST /products/extract-label` has two paths:

| Input | Path | Status |
|-------|------|--------|
| `{ rawText: string }` (≥ `MIN_OCR_LENGTH = 50` chars) | Text path — hand-rolled regex parser (`labelExtractionService.ts`); English + German patterns | **Shipped (T5)** |
| Multipart image | Image path — implementation chosen by `VISION_MODE` (see below) | **Shipped** |

**Image-path modes (`VISION_MODE`):**

| Mode | Pipeline | Notes |
|------|----------|-------|
| `mock` | Returns a fixed `MOCK_OCR_TEXT` string → regex parser | Dev/test default |
| `live` | Google Cloud Vision `documentTextDetection` (ADC) → regex parser | Cheap, deterministic, fragile to multi-column layouts |
| `llm` | Gemini 2.5 Flash multimodal call → JSON conforming to `ExtractedLabel` schema | Handles column layouts and multi-language by understanding the image directly; requires `GEMINI_API_KEY` |

The controller (`labelExtractionController.ts`) branches on `getVisionMode()`: `llm` calls `extractLabelWithLlm(buffer, mimeType)` and returns its result directly; every other mode flows through `ocrLabelImage` → `extractFromText`.

**Extraction logging.** Each successful extraction emits one `info` line (`label-extract: <text|image> path`) carrying `path`, `mode` (`VISION_MODE`), `confidence`, `userId`, and — for OCR/image paths — `ocrTextLength` and `imageBytes`. This makes it visible in the server logs whether OCR actually ran, on which path, and how much text it produced (the per-request `requestLogger` line only shows that the endpoint was hit). The raw OCR text itself is only logged at `debug` level inside `visionService` (`live` mode) / `labelExtractionLlmService` (`llm` mode).

**Authentication (`live` mode):** Uses Application Default Credentials (ADC) — no service account JSON key. In production the pod's `GOOGLE_APPLICATION_CREDENTIALS` env var points to a Workload Identity Federation credential config file (`type: external_account`) mounted from a ConfigMap. The Google auth library exchanges the pod's IRSA/OIDC token for a short-lived GCP access token automatically. For local `live` testing run `gcloud auth application-default login` and then `gcloud auth application-default set-quota-project <project>` (Vision requires an ADC quota project).

**Gemini authentication (`llm` mode + image plausibility gate):** Both Gemini callers — `labelExtractionLlmService.ts` and `imagePlausibilityService.ts` — share a single client factory, `services/geminiClient.ts` (`getGeminiClient()`). The auth method is chosen entirely by environment, so the calling code is identical in local dev and production:

- **Gemini Developer API** (local default): `GEMINI_API_KEY` from Google AI Studio, used directly by `@google/genai`; no GCP project / ADC plumbing.
- **Vertex AI** (production, keyless): set `GOOGLE_GENAI_USE_VERTEXAI=true` plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. The SDK authenticates via ADC, which in production resolves through the same Workload Identity Federation credential file used by `live` Vision (`GOOGLE_APPLICATION_CREDENTIALS`) — no `GEMINI_API_KEY` needed. The service account requires `roles/aiplatform.user`.

`config.ts` validates the required combination at startup (Vertex needs project+location; otherwise a key is required). Schema validation is enforced by Gemini's `responseSchema` + `responseMimeType: 'application/json'`, so callers `JSON.parse` the response and cast directly. The full Gemini response is logged at `debug` level (`vision:llm raw response` / `plausibility:gemini raw response`).

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

**Mode-style variables** (e.g. `VISION_MODE` = `'mock' | 'live' | 'llm'`, `PLAUSIBILITY_MODE` = `'mock' | 'gemini'`) must be validated against an explicit allowlist. Any value outside the allowlist — including an absent value — is a startup error. Conditional secrets that a mode requires (e.g. `GEMINI_API_KEY` when `VISION_MODE=llm` or `PLAUSIBILITY_MODE=gemini`) are also validated at startup in `config.ts`.

**Local-dev values** belong in `.env` (git-ignored), not hardcoded in source.

This rule exists because silent defaults produce invisible misconfiguration: a server that assumes `mock` mode when `VISION_MODE` is unset will return fixture data in production without any log or alert.

---

## Background Jobs

Runs as node-cron jobs inside the server process:

| Job | Schedule | Purpose |
|-----|----------|---------|
| OFF sync | Every 5 min | Submits `VERIFIED` products/edits to Open Food Facts |
| Edit expiry | Daily | Marks `ProductEdit` records with no votes after 30 days as `EXPIRED` |
