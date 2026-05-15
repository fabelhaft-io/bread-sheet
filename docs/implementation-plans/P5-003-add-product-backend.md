# P5-003 — Add Product Backend Implementation Plan

> Companion to the P5-002 client skeleton that already shipped on this branch.
> Branch: `feat/p5-002-add-product-client-skeleton` (commits stack on top)
> Date: 2026-05-15

This document is a hand-off plan, not implementation. Read top to bottom once, then work the tickets in order. Every ticket lists the goal, the files to touch, the contract, the tests, and the gotchas — so you can pick any one up cold without re-deriving context.

---

## 0. Decisions locked in for this PR

| Topic | Choice | Rationale |
|-------|--------|-----------|
| Scope | Core endpoints + image-path extraction | Ships a usable Add Product flow end-to-end; defers the heaviest validation work. |
| Image-path OCR provider | **Google Cloud Vision** (`documentTextDetection`) | Generous free tier (1000 units/month), strong on dense label text, supersedes FEATURES.md's earlier Claude-vision suggestion. |
| Verification policy | **2 approvals, net-positive** | Approvals ≥ 2 AND approvals > rejections → flip to `VERIFIED`. Resilient to a single bad reviewer. |
| Branching | Stack onto `feat/p5-002-add-product-client-skeleton` | Client + backend land together. |

## 0a. Out of scope (deferred to follow-up tickets)

These are mentioned in FEATURES.md but explicitly **not** in this PR:

- **AI plausibility checks** (e.g., reject "energy = 9000 kcal/100g"). The 422 contract is still wired up, but only for basic schema validation (missing required fields, non-numeric inputs, range gates).
- **Lambda-driven async image resize** (`raw/` → `processed/` prefix). Synchronous `sharp` resize via the existing `imageService.ts` is fine for the 5 MB client cap.
- **OFF (Open Food Facts) contributor sync** on auto-promotion to `VERIFIED`. Leave a TODO at the threshold-flip point with the function signature stubbed.
- **Admin tooling** for manually flipping verification state.

---

## 1. State recap (from the explore pass)

**What exists:**
- `Product` model has `barcode`, `name`, `brand?`, `image?`, `description?` — no `status`, `submittedByUserId`, no votes.
- `GET /api/products/:barcode` exists (DB cache → OFF fallback). Will need to start returning `unverified` and `submittedByUserId` when relevant.
- `services/imageService.ts` already resizes via `sharp` and uploads to LocalStack S3 (bucket `breadsheet-images-local`).
- `middlewares/authMiddleware.ts` populates `req.user = { id, email? }` from the Supabase token. **`is_anonymous` is NOT currently surfaced** — Ticket T2 fixes this.
- Test framework: **vitest** (`server/vitest.config.ts`). Existing tests use `vi.mock()` for Prisma + service isolation.
- No `.env.example`. ADRs: only `0001-auth-provider.md`.

**Client contracts** the backend must satisfy (from `bread-sheet-app/features/products/api.ts`):

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/products/upload-image` | multipart: `kind` (`product`/`label`) + `image` | `{ url: string }` |
| POST | `/api/products/extract-label` | JSON `{ rawText }` **or** multipart `image` | `ExtractedLabel` |
| POST | `/api/products` | JSON `ProductSubmission` | `{ barcode, status }` (201) |
| POST | `/api/products/:barcode/verify` | empty | `{ verifications: number }` |
| DELETE | `/api/products/:barcode/verify` | empty | `{ verifications: number }` |

`ProductSubmission` and `ExtractedLabel` shapes are in `bread-sheet-app/features/products/types.ts` — treat that file as the wire contract source-of-truth and import-copy shapes into the server validators.

---

## 2. Ticket breakdown

> Each ticket is small enough to be one commit. Suggested final history: 7–9 commits, then one rebase clean-up before the PR.

### T1 — DB migration: status, submitter, verification votes

**Goal:** Schema changes that unblock every other ticket.

**Files:**
- `server/prisma/schema.prisma`
- `server/prisma/migrations/<timestamp>_p5_003_product_status_and_votes/` (generated)

**Schema additions:**

```prisma
enum ProductStatus {
  VERIFIED
  PENDING_REVIEW
  REJECTED
}

enum VerificationVote {
  APPROVE
  REJECT
}

model Product {
  // ... existing fields ...
  status              ProductStatus @default(VERIFIED) // existing rows = trusted (came from OFF)
  submittedByUserId   String?
  submittedBy         User?         @relation("ProductSubmitter", fields: [submittedByUserId], references: [id])

  // New nutritional fields (mirroring ProductSubmission payload)
  genericName         String?
  energyKcal          Float?
  carbohydrates       Float?
  fat                 Float?
  protein             Float?
  salt                Float?
  servingSize         String?
  ingredients         String?

  verifications       ProductVerification[]
}

model ProductVerification {
  id         String           @id @default(uuid())
  productId  String
  userId     String
  vote       VerificationVote
  createdAt  DateTime         @default(now())

  product    Product          @relation(fields: [productId], references: [id], onDelete: Cascade)
  user       User             @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([productId, userId]) // one vote per user per product; second vote overwrites via upsert
}

model User {
  // ... existing ...
  submittedProducts   Product[]              @relation("ProductSubmitter")
  productVerifications ProductVerification[]
}
```

**Acceptance criteria:**
- `npm run prisma:migrate` succeeds locally against the docker-compose Postgres.
- Existing rows get `status = VERIFIED` (the default) without manual intervention.
- `npx prisma studio` shows the new columns and the empty `ProductVerification` table.

**Gotchas:**
- The Prisma client output path is custom: `src/generated/prisma_client`. After `prisma migrate dev`, run `npm run prisma:generate` if your editor's types don't pick up the new models.
- Don't forget the back-relations on `User` — Prisma will refuse to validate the schema without them.

---

### T2 — `requireRegistered` middleware

**Goal:** A second-layer guard that runs after `requireAuth` and rejects anonymous Supabase sessions.

**Files:**
- `server/src/middlewares/authMiddleware.ts` (add `requireRegistered`, export it)
- `server/src/middlewares/authMiddleware.test.ts` (add a case)

**Contract:**
- Reads `req.user` (must already be populated). The auth middleware needs to expose `is_anonymous` — extend the user-shaping step around line 45–48 to include `isAnonymous: data.user.is_anonymous === true`.
- If `isAnonymous` → respond `403 { error: 'registration_required' }`.
- Otherwise → `next()`.

**Why a separate middleware** (vs. inline check): three endpoints need this gate (`/products` POST, both `/extract-label` paths, both `/verify` methods). DRY beats inline.

**Acceptance criteria:**
- New unit test covers (a) anonymous → 403, (b) registered → next(), (c) missing user → 401 (delegated upstream).

---

### T3 — `POST /api/products` (submit)

**Goal:** Persist a user-submitted product as `PENDING_REVIEW`.

**Files:**
- `server/src/routes/productRoutes.ts` — register the route
- `server/src/controllers/productController.ts` — `submitProduct` handler
- `server/src/services/productService.ts` — `createSubmittedProduct(payload, userId)`
- `server/src/validators/productSubmissionValidator.ts` *(new file)* — schema validation, returns `{ field, reason }` 422s
- `server/src/__tests__/controllers/submitProduct.test.ts` *(new)*

**Contract:**
- Mounted middleware chain: `apiLimiter` → `requireAuth` → `requireRegistered` → `submitProduct`.
- Body: `ProductSubmission` (see client `types.ts`).
- Validation rules for this PR (basic, not the full plausibility battery):
  - `barcode`: non-empty, matches `/^\d{8,14}$/`.
  - `name`: non-empty, length 1–200.
  - `productImageUrl`: must start with the S3 bucket prefix.
  - All numeric fields: when present, must be `>= 0` and `< 10000`.
  - On first failure, return `422 { error: '<message>', reason: '<human-readable>', field: '<key>' }` — the client's `field-<key>-error` test id pattern keys off `field`.
- If `barcode` already exists:
  - If existing product is `VERIFIED` → `409 { error: 'product_already_verified' }`.
  - If existing is `PENDING_REVIEW` and submitter differs → `409 { error: 'submission_pending' }`.
  - If existing is the caller's own pending submission → update it (treat as re-edit) and return 200 instead of 201.
- Success: persist as `PENDING_REVIEW`, `submittedByUserId = req.user.id`, return `201 { barcode, status: 'PENDING_REVIEW' }`.

**Tests to add (vitest, mocked prisma):**
- 201 on happy path.
- 422 with `field: 'energyKcal'` when energyKcal is negative.
- 403 when anonymous (covered by middleware test, but assert the chain wires up here too).
- 409 when product is already VERIFIED.
- 200 when same user re-submits their own PENDING product.

**Gotchas:**
- The client treats 422 specifically as an inline field error — don't change the body shape (`{reason, field}`) without updating the client.
- Use a Prisma transaction if you find yourself doing a "find then create" — there's a race window otherwise.

---

### T4 — `POST /api/products/upload-image`

**Goal:** Accept a multipart image, run it through `sharp`, upload to S3, return the URL.

**Files:**
- `server/src/routes/productRoutes.ts` — register; add `multer` middleware
- `server/src/controllers/productController.ts` — `uploadImage` handler
- `server/src/services/imageService.ts` — extend with a `kind`-aware resize (different max dims per `product`/`label`)
- `server/src/__tests__/controllers/uploadImage.test.ts` *(new)*
- `scripts/localstack-init.sh` *(new)* — auto-create the S3 bucket on `docker compose up` (see T4a below)
- `docker-compose.yml` — mount the init script (see T4a below)

**Contract:**
- Form fields: `kind` (string, `'product' | 'label'`), `image` (file).
- Hard size limit: 8 MB (client caps at 5 MB; the extra slack accommodates re-encodes). Exceeded → `413 { error: 'image_too_large' }`.
- Format detection by magic bytes (use `file-type` package — already small, zero-deps). Reject unsupported → `415 { error: 'unsupported_format' }`.
- Resize parameters:
  - `kind='product'`: longest edge 1200, JPEG q85 (matches `MAX_PRODUCT_IMAGE_LONGEST_EDGE`).
  - `kind='label'`: longest edge 1600, JPEG q90 (matches `MAX_LABEL_IMAGE_LONGEST_EDGE`).
- Upload to S3 (LocalStack locally) under `submissions/<uuid>.jpg` — namespacing under `submissions/` distinguishes user-uploaded blobs from any other future image source. Return `{ url }` pointing at the public S3 URL.
- Auth: `requireAuth` only (no `requireRegistered` — uploading an image is harmless; the gate is on the actual submission).

**Tests:**
- 200 + URL on happy path (mock S3 client).
- 413 when file exceeds limit.
- 415 when MIME doesn't match magic bytes (e.g., a `.txt` renamed `.jpg`).
- Assert: the returned URL contains `/submissions/` (sanity check that the namespacing is wired up).

**Gotchas:**
- `multer` config: `limits: { fileSize: 8 * 1024 * 1024 }` and `storage: multer.memoryStorage()` so the buffer is in-memory for sharp.
- Don't trust the client's reported MIME — always verify magic bytes server-side.
- The existing `terraform/s3.tf` already declares the bucket — keep that file (it's the production-parity path), but **do not** rely on the user running `terraform apply` for local dev. T4a below makes the bucket appear automatically on `docker compose up`.

---

### T4a — Auto-create the LocalStack S3 bucket on `docker compose up`

**Goal:** Remove the manual `terraform apply` step from the local-dev inner loop. After this ticket, `docker compose up -d` is enough — the bucket is there.

**Why a separate sub-ticket:** It's a different file set (compose + shell, no TypeScript), and you might want to land it as its own commit so the diff is easy to review.

**Files:**
- `scripts/localstack-init.sh` *(new)*
- `docker-compose.yml` — one volume mount on the `localstack` service

**Approach — LocalStack init hooks:** LocalStack runs every executable file in `/etc/localstack/init/ready.d/` once, after its services report ready. Drop a shell script there via a volume mount; bucket creation happens with zero human action and is idempotent.

**`scripts/localstack-init.sh`:**
```sh
#!/bin/sh
# Auto-runs once on LocalStack startup. Idempotent — re-runs are no-ops.
set -e

BUCKET=breadsheet-images-local

# awslocal is preinstalled in the LocalStack image and points at the local gateway.
if ! awslocal s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  awslocal s3 mb "s3://$BUCKET"
  echo "[init] Created S3 bucket: $BUCKET"
else
  echo "[init] S3 bucket $BUCKET already exists; skipping."
fi
```

Make it executable: `chmod +x scripts/localstack-init.sh` (commit the executable bit).

**`docker-compose.yml` — add one line under the `localstack` service's `volumes:`:**
```yaml
  localstack:
    # ... existing config ...
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock"
      - localstack_data:/var/lib/localstack
      - ./scripts/localstack-init.sh:/etc/localstack/init/ready.d/init-buckets.sh:ro
```

**Acceptance criteria:**
- `docker compose down -v && docker compose up -d` (the `-v` wipes the volume so this is a true cold start).
- After ~5 seconds, `docker compose logs localstack | grep "init"` shows `[init] Created S3 bucket: breadsheet-images-local`.
- `awslocal s3 ls` (run from your host with `aws --endpoint-url=http://localhost:4566 s3 ls`) lists the bucket.

**Gotchas:**
- Line endings: on Windows, make sure the script is saved with LF (not CRLF), otherwise `/bin/sh` in the container chokes with `\r: not found`. Add `* text=lf` for `*.sh` in `.gitattributes` if you don't already have it.
- The script runs as root inside the LocalStack container — that's fine, `awslocal` doesn't care.
- Keep `terraform/s3.tf` as-is. Both paths declare the same bucket; LocalStack's `mb` is idempotent, so even if a user runs `terraform apply` after `docker compose up`, nothing breaks.

---

### T5 — `POST /api/products/extract-label` (text path)

**Goal:** Parse OCR'd label text into an `ExtractedLabel` structured payload.

**Files:**
- `server/src/routes/productRoutes.ts` — register the route (one path, branches on content-type)
- `server/src/controllers/labelExtractionController.ts` *(new)*
- `server/src/services/labelExtractionService.ts` *(new)* — the parser
- `server/src/__tests__/services/labelExtractionService.test.ts` *(new)*

**Contract:**
- Detect content-type: if `application/json`, this is the text path; if `multipart/form-data`, defer to T6.
- Text path body: `{ rawText: string }` (min length matches client's `MIN_OCR_LENGTH = 50`).
- Auth: `requireAuth` + `requireRegistered`.

**Parser design:**
- Hand-rolled regex + lookup tables. Targets English and German labels first (BreadSheet's existing user base assumption).
- For each field, run a list of patterns; first match wins. Use a `confidence` tracker:
  - `high` if ≥ 5 fields parsed.
  - `medium` if 3–4.
  - `low` if 1–2.
  - If 0 → still return a successful 200 with an all-`null` `ExtractedLabel` (`confidence: 'low'`, every field `null`). **Never throw on no-match** — the client relies on a graceful fallback and shows the manual-entry form when nothing comes back. The same all-null path covers genuinely unparseable input and "no text was sent at all".

**Sample patterns** (just to seed your thinking):
```ts
const ENERGY_KCAL = /(?:energy|energie|brennwert)[^0-9]{0,30}(\d+(?:[.,]\d+)?)\s*kcal/i;
const CARBS = /(?:carbohydrates|kohlenhydrate|glucides)[^0-9]{0,30}(\d+(?:[.,]\d+)?)\s*g/i;
const PROTEIN = /(?:protein(?:e)?|eiweiß|protéines)[^0-9]{0,30}(\d+(?:[.,]\d+)?)\s*g/i;
const FAT = /(?:fat|fett|matières grasses)[^0-9]{0,30}(\d+(?:[.,]\d+)?)\s*g/i;
const SALT = /(?:salt|salz|sel)[^0-9]{0,30}(\d+(?:[.,]\d+)?)\s*g/i;
```

**Tests:**
- Parses a realistic English label with all 5 macros + ingredients line.
- Parses a German Brennwert/Eiweiß label.
- Returns `confidence: 'low'` when only one field matches.
- Returns `null` fields when no patterns match (still 200, no exception).

**Gotchas:**
- Decimal separators: support both `.` and `,` (European format) — convert to `.` before parsing.
- Whitespace and line breaks: OCR output is noisy. Allow `[^0-9]{0,30}` between label and value.
- Ingredients: heuristic — line starting with "Ingredients:" or "Zutaten:" up to the next blank line or "Allergens:".

---

### T6 — `POST /api/products/extract-label` (image path / Google Vision)

**Goal:** Same endpoint, multipart branch. Run Google Vision OCR, then reuse T5's parser.

**Files:**
- `server/src/services/visionService.ts` *(new)* — thin wrapper around `@google-cloud/vision` with mock/live/tesseract mode switch
- `server/src/controllers/labelExtractionController.ts` — add the multipart branch
- `server/src/__tests__/services/visionService.test.ts` *(new, mocked)*
- `server/src/__fixtures__/vision/` *(new)* — committed `(image.jpg, expected-ocr.txt)` pairs for local mock mode and parser tests
- `server/.env.example` *(new)* — document the new env vars
- `server/package.json` — add `@google-cloud/vision`

**Setup steps (one-time, for your local env):**
1. Create a GCP project + enable Cloud Vision API.
2. Create a service account with `roles/serviceusage.serviceUsageConsumer` + permission to call Vision.
3. Download the JSON key. Two equally good options for how the server consumes it:
   - **Option A (file path):** Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` — the official client lib picks it up automatically. Best for local dev.
   - **Option B (inline JSON):** Set `GOOGLE_VISION_CREDENTIALS_JSON='{"type":"service_account",...}'` and pass it to the client constructor manually. Best for Kubernetes secrets (no file-mount needed).
   - **Recommend Option B** for production parity, A for local convenience. Support both: prefer B if set, fall back to A.
4. Add a `VISION_MODE` env var that the service reads to switch between OCR backends (see "Local testing strategy" below). Default to `mock` in dev, `live` in production.

**Contract:**
- Multipart: `image` (the label photo only).
- Same auth chain as T5.
- Same response shape (`ExtractedLabel`) — the client should be content-agnostic.

**Service shape:**
```ts
// visionService.ts
export async function ocrLabelImage(buffer: Buffer): Promise<string> {
  const client = getVisionClient(); // memoized
  const [result] = await client.documentTextDetection({ image: { content: buffer } });
  return result.fullTextAnnotation?.text ?? '';
}
```

**Tests:**
- Mock `@google-cloud/vision` at the module boundary (same pattern as `productService.test.ts` mocks `fetch`).
- Assert: image bytes → vision call → raw text → reused parser → ExtractedLabel.
- Assert: empty Vision result → 200 with all-null fields (graceful fallback, matching T5 behavior).

**Local testing strategy — avoiding token burn:**

The Google Vision SDK has no LocalStack-equivalent emulator, so a `VISION_MODE` env switch inside `visionService.ts` decides how OCR actually runs. The wrapper exposes one function (`ocrLabelImage(buffer): Promise<string>`); only the implementation behind it changes.

| `VISION_MODE` | Behavior | Use when |
|---------------|----------|----------|
| `mock` *(default in dev)* | Hash the image bytes (sha256, first 12 chars), look up `__fixtures__/vision/<hash>.txt`, return its contents. Throw a loud "fixture missing" error if no match — that's your cue to add one. | Inner loop: iterating on parsers, running `npm test` locally, working offline. |
| `live` | Real `@google-cloud/vision` call. | Occasional validation — confirming a new parser rule against fresh Vision output. Free tier covers this comfortably (1000 units/month). |
| `tesseract` *(optional)* | Shell out to local Tesseract via `child_process`. Same return shape. | Offline plumbing checks (e.g., on a plane). Don't use to validate parser accuracy — quality is meaningfully lower than Vision. |

**CI:** Tests never set `VISION_MODE`. Instead, they use `vi.mock('@google-cloud/vision', ...)` at the module boundary — same pattern as `productService.test.ts` mocks `fetch`. Fast, deterministic, no env coupling.

**Fixtures folder:** `server/src/__fixtures__/vision/` should ship with 5–10 representative cases committed to git:
- `<hash>.jpg` — the source image (small, e.g. 600px longest edge, JPEG q70 — stay under 100 KB each)
- `<hash>.txt` — the expected raw OCR text from Vision

Recommended seed set: one clean English label, one clean German label, one multilingual label, one blurry/noisy label, one with no text. These double as inputs for T5's parser tests, so the same fixtures pull double duty.

**Optional follow-up — VCR-style cassettes:** If the fixture folder starts feeling rigid (e.g., you're testing many image variants and don't want to manually create each `.txt`), promote to a cassette pattern: `live` mode writes responses to `cassettes/<hash>.json` on first call; subsequent calls in non-live modes read from the cassette. ~30 lines of code. Defer until there's a real reason — pure-fixture mode is enough for this PR.

**Gotchas:**
- Vision charges per "feature applied" — `documentTextDetection` is 1 unit per image. Free tier 1000/month. **Add per-user rate limiting** later — out of scope for this ticket but worth a TODO.
- The vision client is heavy to construct; memoize at module scope (and only construct it lazily — `mock` mode should never instantiate the real client, otherwise CI fails with a credentials error).
- In CI: do NOT call real Vision. The `vi.mock()` pattern is enough; `VISION_MODE` is for the dev loop, not the test suite.
- Hash the *original* (pre-resize) image bytes for fixture lookup, not the sharp-resized buffer — re-encoding shifts bytes and busts the cache.

---

### T7 — `POST` / `DELETE /api/products/:barcode/verify`

**Goal:** Cast an APPROVE / REJECT vote. Upsert per (product, user). Flip status when threshold met.

**Files:**
- `server/src/routes/productRoutes.ts` — register both methods
- `server/src/controllers/productController.ts` — `approveProduct`, `rejectProduct` handlers
- `server/src/services/productVerificationService.ts` *(new)* — `castVote(productId, userId, vote)`, returns `{ verifications, status }`
- `server/src/__tests__/controllers/verifyProduct.test.ts` *(new)*

**Contract:**
- Auth chain: `requireAuth` → `requireRegistered`.
- 403 if `req.user.id === product.submittedByUserId` (FEATURES.md rule: submitter can't self-verify).
- 404 if barcode unknown.
- 409 if product is already `VERIFIED` or `REJECTED` — no further voting needed.
- Upsert the vote: `prisma.productVerification.upsert({ where: { productId_userId: ... }, update: { vote }, create: { ... } })`.
- After upsert, recompute:
  ```ts
  const votes = await prisma.productVerification.findMany({ where: { productId } });
  const approvals = votes.filter(v => v.vote === 'APPROVE').length;
  const rejections = votes.filter(v => v.vote === 'REJECT').length;
  if (approvals >= 2 && approvals > rejections) {
    await prisma.product.update({ where: { id: productId }, data: { status: 'VERIFIED' } });
    // TODO(P5-003-followup): enqueue OFF sync here
  } else if (rejections >= 2 && rejections > approvals) {
    await prisma.product.update({ where: { id: productId }, data: { status: 'REJECTED' } });
  }
  ```
- Response: `{ verifications: approvals }` (the client's `verify` action expects this shape per its api.ts).

**Tests:**
- POST → 200, approvals count returned.
- DELETE → 200, vote stored as REJECT (NOT delete — overload the channel).
- POST by submitter → 403.
- POST when product already VERIFIED → 409.
- Threshold flip: two distinct users POST → product becomes VERIFIED.
- Net-positive guard: APPROVE + APPROVE + REJECT = still verified (2 vs 1); APPROVE + REJECT + APPROVE = still verified; APPROVE + REJECT + REJECT = stays pending.

**Gotchas:**
- Don't do the recount/flip in a separate request — race condition. Wrap the upsert + recount + flip in a single `prisma.$transaction`.

---

### T7a — Rename client `retractVerification` → `rejectProduct`

**Goal:** Fix the misleading client-side function name. The function semantically casts a REJECT vote — it doesn't retract an earlier approval — so the current name lies about what it does. Land this as part of the same branch so we don't ship the misleading name in the public API of the products feature module.

**Why a sub-ticket:** It's pure cleanup on the client and trivially small, but it touches 3–4 files and is best as its own commit.

**Files:**
- `bread-sheet-app/features/products/api.ts` — rename the exported function `retractVerification` → `rejectProduct`. HTTP call stays identical (`DELETE /api/products/:barcode/verify`).
- `bread-sheet-app/app/(app)/review-product/[barcode].tsx` — update the call site (probably wired to the "Something looks wrong" button handler).
- `bread-sheet-app/app/(app)/review-product/review-product.test.tsx` — update the mock import name and any `expect` calls keyed off the function name.
- `bread-sheet-app/app/(app)/add-product.test.tsx` — search for `retractVerification` in the `@/features/products/api` mock object and rename if present.
- `docs/architecture/frontend.md` — the "Product Submission (TICKET-P5-002)" reviewer-flow section currently names the function in the table — update it.

**Procedure** (saves you from missing a call site):
```sh
cd bread-sheet-app
# Find every reference
grep -rn "retractVerification" --include="*.ts" --include="*.tsx"
# Rename in source — your editor's "rename symbol" works, or sed -i:
# (review changes before committing)
grep -rl "retractVerification" --include="*.ts" --include="*.tsx" | xargs sed -i 's/retractVerification/rejectProduct/g'
# Verify clean
grep -rn "retractVerification" --include="*.ts" --include="*.tsx" || echo "All gone."
npm test  # confirm green
npm run lint
```

**Acceptance criteria:**
- `grep -rn retractVerification bread-sheet-app/` returns nothing.
- Client test suite passes unchanged (the function rename should not require any behavioral test changes — only mock + import name updates).
- The DELETE-as-reject overload should still get a brief mention in `docs/architecture/backend.md` (it remains true at the HTTP level — `DELETE` is the channel for a REJECT vote, which is unusual REST semantics).

---

### T8 — Extend `GET /api/products/:barcode` to include verification metadata

**Goal:** The reviewer banner on the client depends on `unverified` and `submittedByUserId`. Currently the endpoint returns neither.

**Files:**
- `server/src/controllers/productController.ts` — modify `getProductByBarcode`
- `server/src/__tests__/controllers/getProduct.test.ts` (existing, may need new cases)

**Contract change:**
- Add to the response when the product is locally tracked:
  - `unverified: boolean` — `true` if `status !== 'VERIFIED'`.
  - `submittedByUserId: string | null`.
  - `submission?: { genericName?, energyKcal?, ... }` — the user-submitted nutritional fields, so the review screen can render them.
- Visibility rule (FEATURES.md): if status is `PENDING_REVIEW` and caller is anonymous, return 404 (anonymous users don't see un-vetted products at all). Registered callers always see it with the `unverified` flag.

**Tests:**
- Returns `unverified: true` for PENDING products to registered users.
- Returns 404 for PENDING products to anonymous users.
- Returns `unverified: false`, no `submission` block for VERIFIED products.

---

### T9 — Tests in aggregate

You'll have added tests in each ticket. Before opening the PR:

- `cd server && npm test` → green.
- `cd bread-sheet-app && npm test` → green (regression check that the existing 53 client tests still pass against the new contracts).
- Manual end-to-end test against LocalStack:
  1. `docker compose --profile app-dev up -d --build`
  2. Sign up as user A (registered).
  3. Submit a new product with a fake barcode → expect `PENDING_REVIEW`.
  4. Sign up as user B → see the "Needs review" banner on the product → approve.
  5. Sign up as user C → approve. → Product flips to `VERIFIED`.
  6. As user A again, submit a label image → confirm Google Vision parses real label text.

---

### T10 — Documentation + ADRs

Update in a single doc commit at the end (matches the project's "batch edits" rule):

**`CLAUDE.md`:**
- Data model section: list the new fields on `Product` + the `ProductVerification` model.
- Env vars: add `GOOGLE_APPLICATION_CREDENTIALS` (or `GOOGLE_VISION_CREDENTIALS_JSON`) and `VISION_MODE` (`mock | live | tesseract`, defaults to `mock` in dev).
- Mandatory post-implementation note: clarify that backend tests run via vitest (not jest) — `npm test` in `server/` works either way but the framework affects test authoring.

**`README.md`:**
- Add a "Google Vision setup" subsection under Environment Setup with the two-key-options described in T6.
- Add a "Local OCR testing" note explaining `VISION_MODE` and pointing at `server/src/__fixtures__/vision/` — emphasize that `mock` is the default for the inner loop so contributors don't burn GCP quota.
- Add the install hint for new server deps: `npm install @google-cloud/vision multer file-type`.
- Mention the new `.env.example`.

**`docs/architecture/backend.md`:**
- New endpoints section with the table from §1 above.
- Verification flow diagram (text version): "vote → upsert → recount → maybe-flip".
- Document the DELETE-as-reject overload.

**`docs/architecture/data.md`:**
- Add `ProductVerification` to the data inventory.
- Note the Google Vision data flow: label image → GCP → discarded after response (no GCP-side retention configured by us; check GCP's default retention policy and document).

**`FEATURES.md`:**
- Check off the remaining P5-002 acceptance criteria that the backend now satisfies.
- Move P5-003 criteria from "open" to "shipped" with the same `*(client integration)*` annotation style used for P5-002.
- Update the P5-003 description to reflect Google Vision (not Claude).

**`docs/architecture-decision-records/0002-image-ocr-provider.md` (NEW):**
- Context: need server-side OCR for the image-fallback path of label extraction.
- Decision: Google Cloud Vision `documentTextDetection`.
- Alternatives considered: Claude vision (originally in FEATURES.md), OpenAI GPT-4o-mini vision, self-hosted Tesseract.
- Consequences: GCP dependency, 1000-unit/month free tier, structured-output happens server-side via our own regex parser (not the model).

**`docs/architecture-decision-records/0003-peer-verification-policy.md` (NEW):**
- Context: a user-submitted product needs a trust signal before it appears as verified.
- Decision: 2 approvals required, net-positive.
- Alternatives considered: single approval, admin-only.
- Consequences: minimum 3 active reviewers needed to clear backlog at any given time; rejection path also requires 2 net-negative votes.

---

## 3. Suggested commit ordering

Each `→` is "depends on, do in this order":

```
T1 (schema) ─┬─► T3 (submit)  ─┐
             ├─► T7 (verify)  ─┤
             └─► T8 (GET ext) ─┤
T2 (gate)   ─┘                 │
                               ├─► T9 (full test suite green)
T4a (localstack init) ──┐      │
                        ├─►    │
T4 (upload) ────────────┘      │
T5 (text)  ──► T6 (vision)  ─► │
T7a (client rename) ─────────► │
                               └─► T10 (docs+ADRs, single commit)
```

Reasonable PR commit count target: **10** (one per ticket + the doc commit).

T4a is a tiny commit; land it before T4 so manual `terraform apply` is never needed during local development of the upload handler.

T7a is a pure-rename commit; land it any time after T7 — the rename has no behavioral coupling, it just touches the client.

---

## 4. Verification checklist before opening the PR

- [ ] `cd server && npm test` — all green
- [ ] `cd server && npm run lint` — clean
- [ ] `cd bread-sheet-app && npm test` — all green (regression)
- [ ] `cd bread-sheet-app && npm run lint` — clean
- [ ] `grep -rn retractVerification bread-sheet-app/` returns nothing (T7a complete)
- [ ] Cold-start LocalStack works: `docker compose down -v && docker compose up -d`, then check `docker compose logs localstack` for the `[init] Created S3 bucket` line
- [ ] Manual end-to-end happy path against LocalStack (T9 steps 1–6 above)
- [ ] CLAUDE.md, README.md, FEATURES.md, docs/architecture/{backend,data}.md, docs/architecture/frontend.md updated
- [ ] ADRs 0002 and 0003 added
- [ ] `.env.example` created and committed
- [ ] `git log --oneline feat/p5-002-add-product-client-skeleton ^main` shows a clean ~10-commit history
- [ ] PR description references P5-002 (client) and P5-003 (this), and the two new ADRs

---

## 5. Resolved open questions

The four questions originally posed have been answered and folded into the relevant tickets. Captured here for the PR description's "context" section:

| Question | Resolution | Where it lives |
|----------|-----------|----------------|
| Does LocalStack pre-create the `breadsheet-images-local` bucket on `docker compose up`? | No — terraform declares it, but the local dev loop shouldn't require `terraform apply`. Solution: LocalStack init-hook shell script. | T4a |
| Namespace uploads under `submissions/`? | Yes — `submissions/<uuid>.jpg` going forward. | T4 |
| Parser behavior on zero matches? | Return all-null `ExtractedLabel` (200), never throw. Matches the client's graceful-fallback expectation. | T5 |
| Rename client `retractVerification` → `rejectProduct`? | Yes, on this branch. Pure cosmetic + import churn; HTTP contract unchanged. | T7a |

When in doubt, choose the option that matches the client's current behavior — the client is locked in and tested.
