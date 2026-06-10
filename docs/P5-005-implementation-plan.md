# P5-005 Implementation Plan — Product Image Plausibility & Abuse Gating

**Date:** 2026-06-08
**Branch:** `feat/p5-002-lambda-image-resizer` (target: `main`)
**Ticket:** [TICKET-P5-005] Product Image Plausibility & Abuse Gating

---

## Background

P5-003 shipped the product-submission backend but **explicitly deferred** the AI
plausibility check (see `FEATURES.md`, P5-003 acceptance criteria):

> - [ ] AI plausibility check runs synchronously before the response; clearly
>   implausible submissions return a `422` with a human-readable reason.
>   *(deferred — AI plausibility for text and image deferred to a follow-up ticket)*

This ticket implements the **image** half of that deferral: a synchronous,
AI-assisted plausibility check on uploaded images. Two goals:

1. **Reject images of completely different things** (a chair, a pet, a selfie)
   with actionable feedback so the user can retake the photo.
2. **Return correct product information** (name / brand / generic name) read off
   the product photo's front-of-pack, so the submission form pre-fills rather
   than presenting confusingly empty fields.
3. **Flag genuinely abusive uploads** (sexual / graphic content) server-side for
   later moderation — distinct from the benign "wrong subject" rejection.

> Nutritional-value plausibility (kcal ranges, macro sums ≤ 100 g, barcode GS1
> structure, gibberish name detection) remains deferred to a separate follow-up.
> This ticket is image-only.

---

## Key Decisions

### Where the check runs — at upload, before S3

The check runs inside `uploadImage` (`POST /api/products/upload-image`), **before**
`uploadImageToS3`. The image bytes are already in memory (`req.file.buffer`); the
S3 write happens afterward. Running the check first means **a rejected image is
never persisted** — no orphan objects in the `raw/` prefix, no reaper job needed.

This is preferred over running at `POST /products` submit time, where the image
is already in S3 (and possibly already resized by the Lambda into `processed/`),
which would require an orphan-cleanup job on every rejection.

### Both image kinds are gated

Both `kind=product` and `kind=label` uploads run the check. Abuse rejection
applies to **both** — abusive content must not be smuggled through the label
slot. The difference is per-kind verdict handling (below): only `product`
uploads return front-of-pack name/brand suggestions.

### Provider — Gemini multimodal, behind a dedicated mode flag

A new service `imagePlausibilityService.ts` uses Gemini multimodal via
`@google/genai` with structured output, mirroring the existing
`labelExtractionLlmService.ts`. A new env var controls it:

```
PLAUSIBILITY_MODE=mock | gemini   # no default — fail fast per CLAUDE.md
```

- `gemini` — real Gemini call; requires `GEMINI_API_KEY`.
- `mock` — deterministic `ok` verdict with stub suggestions, so the test suite
  and local dev (where `VISION_MODE` may be `mock`/`live`) work without an API key.

`PLAUSIBILITY_MODE` is **separate from** `VISION_MODE` because the two are
independent concerns (OCR/label extraction vs. image moderation); overloading
`VISION_MODE` would make "what does `live` mode do for plausibility?" ambiguous.

### Drop `tesseract` VISION_MODE

`tesseract` mode is removed in this ticket (unused locally, OCR is handled
on-device or via `live`/`llm`). Valid `VISION_MODE` values become
`mock | live | llm`.

---

## Verdict Contract

`imagePlausibilityService.checkImage(buffer, mimeType, kind)` returns:

```ts
type Verdict = 'ok' | 'not_a_product' | 'unusable' | 'abuse';

interface PlausibilityResult {
  verdict: Verdict;
  reason: string;                      // model's free-text detail (server-side only)
  name: string | null;                 // front-of-pack (product kind only)
  brand: string | null;
  genericName: string | null;
}
```

Controller (`uploadImage`) handling, applied after magic-byte format detection:

| Verdict          | HTTP | Body                                              | Side effect           |
|------------------|------|---------------------------------------------------|-----------------------|
| `abuse`          | 422  | `{ error: 'image_rejected', reason: <generic> }`  | write `UserAbuseFlag` |
| `not_a_product`  | 422  | `{ error: 'image_rejected', reason }`             | —                     |
| `unusable`       | 422  | `{ error: 'image_rejected', reason }`             | —                     |
| `ok` (product)   | 200  | `{ url, name, brand, genericName }`               | upload to S3          |
| `ok` (label)     | 200  | `{ url }`                                          | upload to S3          |

The `abuse` reason returned to the client is intentionally generic; the model's
free-text reason is recorded server-side only.

> **Decision (revised):** the `UserAbuseFlag` carries only a free-text `reason`,
> no category enum. We only need the per-user abuse *count* and a human-readable
> why; a category buys nothing until automated moderation logic branches on it
> (YAGNI), and would otherwise mean a migration per new category.

---

## Schema Changes

`server/prisma/schema.prisma`:

```prisma
model UserAbuseFlag {
  id        String   @id @default(uuid())
  userId    String
  reason    String?  // model-provided detail (server-side only)
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Add `abuseFlags UserAbuseFlag[]` to `User`. No category enum — count + free-text
reason only (see the decision note above). Record-only for now; a moderation
dashboard / auto-ban threshold is a later ticket. Migration via
`npm run prisma:migrate`.

---

## Implementation Tasks

### Task 1 — Schema + migration
Add `UserAbuseFlag` model + `User.abuseFlags` relation (no category enum).
Run `npm run prisma:migrate` + `npm run prisma:generate`.

### Task 2 — `imagePlausibilityService.ts`
- `PLAUSIBILITY_MODE` read/validated (allowlist `mock | gemini`).
- `gemini` path: multimodal Gemini call with a kind-aware prompt and a structured
  response schema producing the `PlausibilityResult` shape.
- `mock` path: deterministic `ok` + stub name/brand.

### Task 3 — `config.ts`
- Add `plausibilityMode` to `Config`, validated at startup.
- `gemini` requires `GEMINI_API_KEY`.
- Remove `tesseract` from `VALID_VISION_MODES`.

### Task 4 — `visionService.ts`
- Remove `ocrTesseract` and the `tesseract` switch branch.
- Trim `VisionMode` union to `mock | live | llm`.

### Task 5 — `productController.ts` `uploadImage`
- Call `checkImage` for both kinds before S3 upload.
- Apply the verdict table above; write `UserAbuseFlag` on `abuse`.

### Task 6 — Client

**Flow change — upload the product photo at capture, not at submit.**
Today `add-product.tsx` only calls `uploadProductImage` at final submit (the
`handleSubmit` callback). To give early "not a product / retake the blurry photo"
feedback and to get name/brand suggestions *before* the review step, move the
product-photo upload into `handleCapture` (the photos step):

- On capturing the `product` slot, after local processing, upload immediately.
  - `422` → show the rejection `reason` in the product slot (with a retake
    affordance); leave `productPhotoUri`/url unset so the user can re-capture.
  - `200` → store the returned `url` (reuse at submit instead of re-uploading)
    and stash the `{ name, brand, genericName }` suggestions.
- The `label` slot is unaffected at capture (still uploaded only via the
  extraction fallback path).
- `handleSubmit` uses the already-uploaded product `url` rather than uploading
  again.

**Field-merge precedence (name / brand / genericName).** Two sources can fill
these three fields: the product-photo suggestions and the label `ExtractedLabel`.
**The product photo wins**; the label only fills one of the three if the photo
left it blank. Nutrition fields (energy/carbs/fat/protein/salt/serving/ingredients)
continue to come from the label extraction. Rationale: the front-of-pack is read
with multimodal intelligence (skips taglines/marketing text), whereas raw label
OCR is noisier for name/brand. Implement by merging photo suggestions over the
hydrated label form in `hydrateForm`/`applyFillMode`, with photo values taking
precedence and label values used as fallback-if-empty for those three keys.

**`features/products/api.ts`** — `uploadProductImage` parses the `422` body and
throws a typed error carrying `reason`; its return type gains
`name`/`brand`/`genericName` (nullable).

### Task 7 — Tests
- `imagePlausibilityService.test.ts` — mock-mode verdict; gemini-mode parsing
  (mock the genai client).
- Extend `uploadImage.test.ts` — each verdict's status, abuse writes a flag
  (extend the prisma mock with `userAbuseFlag.create`), `ok` returns suggestions
  and uploads, label `ok` returns `{ url }` only.
- Client 422-handling test in `features/products/`.

### Task 8 — Docs
- `CLAUDE.md` — `PLAUSIBILITY_MODE` env var, drop `tesseract`, update the
  image-pipeline / upload description.
- `docs/architecture/backend.md` — plausibility gate in the image pipeline; drop
  `tesseract`.
- `README.md` — drop `tesseract` references.
- `FEATURES.md` — add TICKET-P5-005 with acceptance criteria; tick the image
  plausibility AC under P5-003.
- `docs/bruno/` — update `upload-image` request + document the new `422` /
  suggestion responses; drop `tesseract` note from the extract-label request.

---

## Acceptance Criteria

- [ ] Uploading a clearly non-product image (`kind=product`) returns `422` with an
      actionable reason; nothing is written to S3.
- [ ] A blurry/unusable image returns `422` advising a retake; nothing is written.
- [ ] A valid product photo returns `200` with `name`/`brand`/`genericName`
      suggestions and the `processed/` URL.
- [ ] Abusive content on **either** `kind=product` or `kind=label` returns `422`
      and records a `UserAbuseFlag` row; nothing is written to S3.
- [ ] Non-abusive rejections do **not** create a `UserAbuseFlag`.
- [ ] `PLAUSIBILITY_MODE` is validated at startup; `gemini` without
      `GEMINI_API_KEY` throws; an invalid value throws.
- [ ] The product photo is uploaded at capture time; rejections surface in the
      product slot with a retake affordance and no photo is retained.
- [ ] The client pre-fills the submission form from the upload suggestions, with
      the product photo winning name/brand/genericName over label extraction
      (label fills those only if the photo left them blank).
- [ ] Submit reuses the already-uploaded product image URL (no double upload).
- [ ] `tesseract` is removed from `VISION_MODE`; no remaining references in code
      or docs (historical dated plan docs excepted).
- [ ] All new behaviour covered by tests; `npm test` passes in `server/` and
      `bread-sheet-app/`.
```
