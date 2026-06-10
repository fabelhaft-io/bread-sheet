# P5-003 Implementation Plan — Backend: Label Extraction, Submission & Peer Verification

**Date:** 2026-05-20  
**Branch:** `feat/p5-002-add-product-client-skeleton` (target: `main`)  
**Ticket:** [TICKET-P5-003] Backend: Label Extraction, Submission, & Peer Verification

---

## Current State

The following sub-tasks are already shipped and checked off in `FEATURES.md`:

| Sub-task | Status | Notes |
|----------|--------|-------|
| T1 — Schema: `ProductStatus`, `submittedByUserId`, `ProductVerification` | ✅ Done | Migration applied; `plausibilityFlag` still missing from schema (deferred) |
| T3 — `POST /api/products` (create PENDING_REVIEW) | ✅ Done | `productController.ts` + `productService.ts` + `productSubmissionValidator.ts` |
| T4 — `POST /api/products/upload-image` | ✅ Done | 8 MB multer limit + `fileTypeFromBuffer` detection + in-process resize + S3 upload |
| T5 — `POST /api/products/extract-label` text path | ✅ Done | Hand-rolled regex parser for EN/DE; returns `ExtractedLabel` with confidence |
| T6 — `POST /api/products/extract-label` image path | ✅ Done | Multipart path wired: `llm` mode → Gemini; other modes → Google Cloud Vision / Tesseract / mock |
| T7 — `POST/DELETE /api/products/:barcode/verify` | ✅ Done | `castVote` with threshold: 2 approvals → VERIFIED; 2 rejections → REJECTED |
| T8 — `GET /api/products/:barcode` augmentation | ✅ Done | Returns `unverified`, `submittedByUserId`, `submission` block; 404 for anon on PENDING_REVIEW |

---

## Remaining Work

### Explicitly Deferred (out of scope for this ticket)

- **AI plausibility checks** (`422` on clearly-invalid submissions, `plausibilityFlag` schema field) — deferred to a follow-up ticket.
- **OFF sync enqueue** after threshold flip — deferred to P5-004.

### Still Pending (in scope)

Three acceptance criteria remain unchecked and must be closed by this plan:

1. **Image pipeline: Lambda-based async resize with predicted `processed/` URL**  
   Current code does in-process resize and uploads to `submissions/{uuid}.jpg`. The spec requires uploading raw bytes to `raw/{kind}/{uuid}.jpg` immediately and returning the predicted `processed/{uuid}.jpg` URL without waiting for Lambda.

2. **Format gate verification** (8 MB → 413; unsupported format → 415; magic-byte detection)  
   The mechanisms are in place (multer limit + `file-type` detection) but the acceptance criteria are still unchecked, meaning they have not been tested end-to-end against the spec.

3. **Test coverage gaps** for T4–T8 per the mandatory post-implementation rule in CLAUDE.md.

---

## Implementation Tasks

### Task 1 — Migrate image upload to raw/processed S3 split

**Goal:** Upload raw image to `raw/product/{uuid}.jpg` or `raw/label/{uuid}.jpg`, return the predicted `processed/{uuid}.jpg` URL synchronously, and let Lambda handle the definitive resize.

**Files to change:**

- `server/src/services/imageService.ts`
  - Remove the in-process `sharp` resize.
  - Convert to JPEG in-process (no resize — Lambda owns the resize).
  - Upload to `raw/{kind}/{uuid}.jpg`.
  - Return the predicted URL `{endpoint}/{bucket}/processed/{uuid}.jpg`.

- `server/src/validators/productSubmissionValidator.ts`
  - The URL sanity check `productImageUrl.includes('/submissions/')` must be updated to accept `processed/` prefix.

- `server/src/controllers/productController.ts`
  - No controller changes needed; the service interface is unchanged (in: buffer + kind, out: URL string).

**Predicted URL contract:**  
The Lambda will write to `processed/{uuid}.jpg` using the same UUID. The API constructs the URL as:

```
{AWS_ENDPOINT_URL}/{S3_BUCKET_NAME}/processed/{uuid}.jpg
```

This URL is returned to the client immediately. If the Lambda has not yet run, the URL will 404 until processing completes — this is acceptable per the spec.

---

### Task 2 — Implement the image-resize Lambda

**Goal:** A Lambda function triggered by S3 `ObjectCreated` events on the `raw/` prefix. Reads the path prefix to determine which resize cap to apply, writes JPEG output to `processed/{uuid}.jpg`.

**New file:** `server/lambda/imageResizer/index.ts` (or `index.mjs`)

Logic:
1. Parse the object key from the S3 event: `raw/{kind}/{uuid}.jpg`.
2. Read the raw object from S3.
3. Apply resize via `sharp`:
   - `kind === 'product'` → max 1200 px on longest side, JPEG 85%
   - `kind === 'label'` → max 1600 px on longest side, JPEG 90%
4. Write to `processed/{uuid}.jpg`.
5. Log success or throw (triggers DLQ).

**Note:** Keep resize constants in sync with `RESIZE_CONFIG` in `imageService.ts`. Consider exporting them from a shared `constants.ts` if drift becomes a risk.

---

### Task 3 — Wire Lambda in Terraform

**File:** `terraform/lambda.tf`

Resources to add:
- `aws_iam_role` for the Lambda execution role (S3 GetObject + PutObject on `breadsheet-images-*`).
- `aws_lambda_function` pointing to a ZIP of `imageResizer/`.
- `aws_s3_bucket_notification` on the images bucket: trigger on `s3:ObjectCreated:*` with prefix filter `raw/`.
- `aws_sqs_queue` + `aws_lambda_event_source_mapping` for the dead-letter queue (ops alerting on Lambda failures).

**LocalStack note:** S3 notifications and Lambda invocations work in LocalStack Community with caveats. Document the local test command in `docs/architecture/infrastructure.md`.

---

### Task 4 — Verify and harden the image gate

**Current implementation in `productController.ts` (`uploadImage`):**
- Multer limit: 8 MB → multer emits `LIMIT_FILE_SIZE` → `handleUploadError` → `413 { error: 'image_too_large' }` ✅
- Magic-byte detection: `fileTypeFromBuffer` ✅
- Supported set: `image/jpeg`, `image/webp`, `image/png`, `image/gif`, `image/tiff`, `image/avif` → rejected set returns `415 { error: 'unsupported_format' }` ✅

**Gap:** PNG/GIF/TIFF/AVIF are accepted and then converted to JPEG by `sharp`. The spec says "if the image is not already JPEG or WebP, convert it". This is consistent with the current implementation: conversion to JPEG happens in `sharp` regardless of format. No code change needed — but this should be explicitly tested.

**Action:** Add integration tests (see Task 5) that exercise:
- Upload of a PNG → response contains a JPEG URL (200)
- Upload of an SVG → `415`
- Upload of a 9 MB file → `413`
- Upload without a Content-Type header but with valid JPEG magic bytes → 200

---

### Task 5 — Integration test coverage

Per CLAUDE.md's mandatory post-implementation rule, every endpoint must have integration tests in `server/src/__tests__/`. The following test files are needed (add to existing files or create new ones):

**`uploadImage.test.ts`** (create/extend):
- `POST /api/products/upload-image` with valid JPEG → 200, URL starts with expected S3 prefix
- `POST /api/products/upload-image` with PNG bytes → 200, accepted (converted to JPEG by pipeline)
- `POST /api/products/upload-image` with SVG bytes → 415
- `POST /api/products/upload-image` exceeding 8 MB → 413
- `POST /api/products/upload-image` without `kind` field → 400
- Anonymous user → 200 (upload-image does not require `requireRegistered`)

**`labelExtractionController.test.ts`** (extend):
- `POST /api/products/extract-label` with `{ rawText: "..." }` (>50 chars) → 200, `ExtractedLabel` shape
- `POST /api/products/extract-label` with too-short rawText → 400
- `POST /api/products/extract-label` with multipart image (mock mode) → 200
- Anonymous user → 403

**`productController.test.ts`** (extend):
- `POST /api/products` with full valid payload → 201, `status: PENDING_REVIEW`
- `POST /api/products` with invalid barcode → 422
- `POST /api/products` with missing required field → 422
- Same user re-submitting own pending product → 200 (update)
- Different user submitting same pending barcode → 409
- `POST /api/products/:barcode/verify` by non-submitter → 200
- `POST /api/products/:barcode/verify` by submitter → 403
- Two approvals → product flips to VERIFIED
- Two rejections → product flips to REJECTED
- `DELETE /api/products/:barcode/verify` (REJECT vote) by non-submitter → 200
- `GET /api/products/:barcode` for PENDING_REVIEW by anonymous → 404
- `GET /api/products/:barcode` for PENDING_REVIEW by registered → 200 with `unverified: true`

---

### Task 6 — Schema: add `plausibilityFlag` (deferred marker)

Even though AI plausibility checks are deferred, add the schema field now so the migration is clean and the column is present when the follow-up ticket lands.

**`server/prisma/schema.prisma`** — add to `Product`:
```prisma
plausibilityFlag Boolean @default(false)
```

Run `npm run prisma:migrate` to create the migration. No controller or service change needed yet.

---

### Task 7 — Documentation and Postman updates

**`CLAUDE.md`:**
- Update the `imageService.ts` description to reflect the `raw/` prefix upload and predicted `processed/` URL pattern.
- Add `S3_BUCKET_NAME` and any new Lambda env vars to the Key Environment Variables section.

**`docs/architecture/backend.md`:**
- Add a section describing the async image pipeline: API → `raw/` → Lambda → `processed/`.
- Document the Lambda dead-letter queue and failure behaviour.

**`docs/architecture/infrastructure.md`:**
- Add the Lambda + S3 notification Terraform resources.
- Add local dev note for testing Lambda via LocalStack.

**`docs/postman/breadsheet.postman_collection.json`:**
- Update `POST /api/products/upload-image` test script to assert the response URL contains `processed/` (after Task 1 lands).
- Verify all product submission and verification requests are up to date.

---

## Acceptance Criteria Tracking

| Criterion | Task | Status |
|-----------|------|--------|
| Images >8 MB → `413` | Task 4 + 5 | Mechanism in place; needs test |
| Unexpected format → JPEG conversion; unsupported → `415` | Task 4 + 5 | Mechanism in place; needs test |
| Format detection via magic bytes | Task 4 + 5 | Already uses `file-type`; needs test |
| Lambda resizes to `processed/` prefix | Tasks 2, 3 | Not yet implemented |
| API returns predicted `processed/` URL | Task 1 | Not yet implemented |
| `extract-label` image path (Vision/LLM) | — | Implemented in current code; checkbox in FEATURES.md needs update |
| `POST /products` → PENDING_REVIEW | — | Done (T3) |
| `POST/DELETE /products/:barcode/verify` vote + threshold | — | Done (T7) |
| PENDING_REVIEW hidden from anon | — | Done (T8) |
| `plausibilityFlag` schema field | Task 6 | Not yet in schema |

---

## Suggested Execution Order

1. **Task 6** (schema `plausibilityFlag`) — one-liner, unblocks clean migrations
2. **Task 1** (imageService S3 raw/ prefix change) — pure server code, no infra dependency
3. **Task 3** (Terraform Lambda wiring) — infra scaffolding
4. **Task 2** (Lambda function code) — depends on Task 3 having the S3 config
5. **Task 4** (verify image gate behaviour) — reading existing code + potentially minor fixes
6. **Task 5** (integration tests) — covers all the above
7. **Task 7** (docs + Postman) — final, after all code is settled

---

## Open Questions

- **LocalStack Lambda support:** S3-triggered Lambda requires LocalStack Pro in some versions. Confirm the local dev story before Task 3; if blocked, document a manual trigger workaround.
- **Postman `processed/` URL validation:** After Task 1, the URL sanity check in `productSubmissionValidator.ts` changes from `/submissions/` to `/processed/`. Confirm the Postman environment uses the new prefix in its URL assertions.
- **Lambda deployment in CI/CD:** The existing GitOps pipeline (ArgoCD on EKS) does not cover Lambda. A separate `terraform apply` step in CI is needed for Lambda changes. This may warrant an ADR.