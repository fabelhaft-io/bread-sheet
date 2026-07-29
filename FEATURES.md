# Project Backlog & Tickets
## Phase 1: Data Foundation & Authentication

### [TICKET-P1-001] Define Database Schema (Prisma)
**Goal:** Define the shape of data in `server/prisma/schema.prisma` and initialize the database.
**Key Models:**
- `User`: ID, email (optional), username, avatar.
- `Product`: Barcode (unique), name, brand, image_url, generic_name.
- `Rating`: UserID, ProductID, taste (Float 0–10 in 0.5 steps), comment.
- `Group`: Name, invite_code.
**Acceptance Criteria:**
- [x] Schema defined in `server/prisma/schema.prisma`.
- [x] Migration created and applied via `npx prisma migrate dev`.
- [x] Database tables exist in local PostgreSQL.
Goal: Define the shape of your data in server/prisma/schema.prisma.
Key Models:
- `User`: ID, email (optional), username, avatar.

### [TICKET-P1-002] Implement Authentication Strategy
**Goal:** Secure the app and link ratings to users using Supabase Auth with support for Anonymous Sign-In.
**Implementation:**
- **Backend:** Create middleware to verify tokens on protected API routes.
- **Frontend:** Create Login/Signup screens.
- **Backend:** Add `express-rate-limit` to prevent API abuse.
- **Frontend:** Implement "Continue as Guest" (Anonymous Auth) and "Sign Up" (Link Account).
- **Routing:** Modify `app/_layout.tsx` to conditionally render the main `(tabs)` or an `(auth)` stack based on login status.
- **Local and Cloud Setup of Supabase** Setup Supabase working for local development and for cloud deployment.
**Acceptance Criteria:**
- [x] User can use app immediately as "Guest" (Anonymous).
- [x] User can upgrade Guest account to Email account.
- [x] Backend rejects requests without valid tokens.
- [x] Rate limiting is active on API routes.
- [x] User identity is available in the app state.
- [x] Setup Supabase working for local development and for cloud deployment. -> Use DEV Supabase stage for development


## Phase 2: The "Scan & Discover" Loop

### [TICKET-P2-001] Open Food Facts Integration (Backend)
**Goal:** Retrieve product details via barcode, caching results locally.
**Logic:**
- Create endpoint `GET /products/:barcode`.
- Step 1: Check local DB for product.
- Step 2: If missing, fetch from Open Food Facts API.
- Step 3: Save to local DB (cache) and return to client.
**Acceptance Criteria:**
- [x] API returns product data for valid barcodes.
- [x] Data is cached in the `Product` table after the first fetch.

### [TICKET-P2-002] Barcode Scanner (Frontend)
**Goal:** Allow the user to scan a product using the device camera.
**Tech:** `expo-camera`.
**UI:** A dedicated tab or modal (accessible from FAB) that opens the camera.
**Acceptance Criteria:**
- [x] Camera permission handling.
- [x] Successful scan captures barcode string.
- [x] Navigation to **Product Detail** screen upon scan.

## Phase 3: The Rating Core

### [TICKET-P3-001] Product Detail & Rating UI
**Goal:** Display product info and allow users to submit a taste rating.
**UI:**
- Header with Product Image and Name.
- Custom `TasteSlider` component: draggable track 0–10 with 0.5-step snapping, large animated score badge (colour-coded amber → green), and −/+ stepper buttons.
- Optional comment field.
- "Submit" button.
**Acceptance Criteria:**
- [x] User can view product details.
- [x] User can set taste score 0–10 in 0.5 increments.
- [x] Submit button sends `POST` request to backend with `{ barcode, taste, comment? }`.
User History

## Phase 4: History

### [TICKET-P4-001] User History
**Goal:** Display a list of items the user has previously rated, and recently opened products.
**UI:** Home tab with two sections: "My Ratings" and "Recently Opened".
**Backend:** Endpoint `GET /users/me/ratings`.
**Implementation:**
- Home tab (`app/(tabs)/index.tsx`) fetches rating history via `GET /api/users/me/ratings` for registered users.
- Each rating card shows product thumbnail, name, brand, star score, optional comment, and relative timestamp.
- "Recently Opened" section is tracked in-memory via `RecentProductsProvider` context (`hooks/use-recent-products.tsx`). The product screen records a view whenever a product loads successfully.
- Guest users see a sign-up prompt instead of ratings; recently opened still works for guests.
- Pull-to-refresh reloads the ratings list.
**Acceptance Criteria:**
- [x] List displays product name, image, and user's score.
- [x] Clicking an item navigates to the product/rating screen.
- [x] Recently opened products are shown even before rating.
- [x] Guest users see a contextual prompt to create an account.

## Phase 5: Product Contributions

### [TICKET-P5-001] Missing Product Detection & Add-Product Entry Point
**Goal:** When a scanned barcode yields no result, surface a clear call-to-action so the user can contribute the missing product instead of hitting a dead end.
**Logic:**
- `GET /products/:barcode` already returns `404` for unknown barcodes.
- The product screen must distinguish between "loading", "found", and "not found" states.
- In the "not found" state, render a dedicated empty-state UI that differs by auth state:
  - **Registered user:** a message ("This product isn't in the database yet") and a prominent **"Add this product"** button that navigates to the Add Product screen (`app/(app)/add-product.tsx`), pre-filled with the scanned barcode.
  - **Anonymous/guest user:** the same "This product isn't in the database yet" message, a secondary explanation ("Sign up to help add it"), and a **"Sign up"** button. Do **not** redirect automatically — the user stays on the product-not-found screen and chooses whether to act.
**Post-signup navigation (deep-link return):**
- When a guest taps "Sign up" from this screen, navigate to `/(auth)/signup` and pass the current barcode as a route parameter: `/(auth)/signup?returnTo=/product/[barcode]`.
- The sign-up screen must immediately persist `returnTo` to on-disk storage under the key `pendingReturnTo` before initiating any auth call. This is necessary because email verification fires a magic link that relaunches the app as a cold deep link, destroying any in-memory navigation state.
- When the magic link returns the user to the app and `supabase.auth.onAuthStateChange` fires with a `SIGNED_IN` event, the auth completion logic in `app/_layout.tsx` reads `pendingReturnTo` from disk, clears it, and navigates there instead of the default `/(tabs)` redirect — landing the user back on the product-not-found screen, now authenticated, where the "Add this product" button is visible.
- If signup is abandoned or fails, `pendingReturnTo` is cleared and normal post-auth routing applies.
**Acceptance Criteria:**
- [x] Scanning an unknown barcode shows a "Product not found" state (not an error/crash).
- [x] Registered users see the "Add this product" button; tapping navigates to the Add Product screen with the barcode pre-filled.
- [x] Anonymous users see the product-not-found message and a "Sign up" button — they are not automatically redirected.
- [x] Tapping "Sign up" navigates to the sign-up screen with `returnTo=/product/[barcode]` in the route params.
- [x] After completing signup, the user is returned to the product-not-found screen for that barcode, now seeing the "Add this product" button.
- [x] Abandoning signup mid-flow does not navigate to the product screen; normal post-auth routing applies.
- [x] Known products continue to render normally — no regression.

**Implementation notes:**
- The 404 branch is driven off the typed `ApiError` class in `bread-sheet-app/lib/api.ts`, which carries the HTTP `status` so the product screen can distinguish "not found" from generic errors via `instanceof ApiError && err.status === 404`.
- `pendingReturnTo` is persisted on disk by `bread-sheet-app/lib/pending-return-to.ts`. The implementation uses `expo-file-system/legacy` (writing a small text file under `documentDirectory`) rather than `@react-native-async-storage/async-storage` — the behaviour is identical from the callsite's perspective, but this keeps us free of an additional native dependency.
- The signup screen persists `returnTo` *before* calling `signUp()` and clears it on failure; `app/_layout.tsx` reads and clears it on the post-signin redirect path (guarded by a ref so the async read cannot re-enter).
- The Add Product screen (`app/(app)/add-product.tsx`) currently ships as a stub for this ticket; the full flow is P5-002. It still enforces the registered-user guard described there as defence-in-depth if an anonymous user reaches it via a deep link.

### [TICKET-P5-002] Add Product Screen — Camera-Assisted & Manual Entry
**Goal:** Allow users to submit a new product with display image, nutritional label photo, and structured data, with on-device OCR + AI-assisted extraction reducing manual effort.
**UI Flow:**
1. **Photos step** — two capture slots:
   - *Product photo* — what appears in listings/ratings (front of packaging).
   - *Nutritional label photo* — used for extraction (ingredients/nutrition table).
   - Each slot shows a camera icon; tapping opens `expo-image-picker` or in-app camera.
2. **Extraction step** — after the label photo is captured:
   - Run `@react-native-ml-kit/text-recognition` on-device (no network call, works offline). This uses Google ML Kit on Android and Apple's Vision framework on iOS — both on-device, no image leaves the phone at this stage.
   - If the extracted raw text is sufficiently long (e.g. > 50 chars), POST only the text to `POST /products/extract-label` for AI structuring — no image upload needed.
   - If on-device OCR yields too little text (blurry photo, poor lighting), fall back to uploading the label image itself so the backend can run vision inference.
   - Show a loading indicator during the backend structuring call. If both paths fail, or the user skips, proceed with empty fields.
3. **Review & fill step** — structured form fields (name, brand, generic name, energy kcal, carbs, fat, protein, salt, serving size). Three modes selectable by the user:
   - **"Fill manually"** — all fields start blank; extraction result is discarded.
   - **"Pre-fill & edit"** (default when extraction succeeded) — fields are pre-populated from extracted result; user can correct any value.
   - **"Accept all"** — fields are locked and shown read-only; user can still switch back to pre-fill mode.
4. **Submit step** — "Submit product" button posts to backend.
5. **Post-submission:** On a `201` response, navigate to the product screen for the submitted barcode (which now renders the `PENDING_REVIEW` state with a "Needs review" badge) and show a toast: "Thanks! Your product is under review." On a `422` (AI plausibility rejection), stay on the form and display the rejection reason as an inline error beneath the relevant field(s) so the user can correct and resubmit.
**Reviewer flow (for registered users who encounter a `PENDING_REVIEW` product):**
- When a registered user scans or searches a product that returns `unverified: true`, the product screen shows a banner: "This product was added by a user — does it look correct?"
- Tapping the banner opens a **reviewer screen** (`app/(app)/review-product/[barcode].tsx`) that renders all submitted fields in the same visual layout as the regular product detail screen — product photo, name, brand, nutritional table — so the reviewer sees exactly what other users will see if the product is approved. Every submitted field is explicitly shown, including ones that are `null` (shown as "Not provided"), so the reviewer can judge completeness.
- Below the product card, two action buttons: **"Looks correct"** and **"Something looks wrong"**.
- Tapping either calls `POST /products/:barcode/verify` or `DELETE /products/:barcode/verify` respectively (see P5-003), then navigates back to the product screen.
- The banner is dismissed after the user acts and does not reappear for that product.
- Users who submitted the product do not see the reviewer banner.
**Access control:**
- The Add Product screen is only reachable by registered (non-anonymous) users. This is normally enforced upstream in P5-001, but as a safety net: if an anonymous user navigates directly to the route (e.g. via a deep link), show a full-screen prompt ("You need an account to add products") with a "Sign up" button. Pass the current route (including the barcode param) as `returnTo` so the same post-signup return flow from P5-001 applies.
- Check registration status via the session hook (`hooks/use-session.tsx`); Supabase anonymous sessions carry `is_anonymous: true` in their JWT claims.
**Technical notes:**
- `@react-native-ml-kit/text-recognition` is an on-device library; add to `bread-sheet-app/` dependencies. Requires no API key.
- Form validation: name and barcode are required; numeric nutrient fields must be non-negative.
- The product display photo is uploaded through `POST /products/upload-image` (the API streams it to S3 — see `imageService.ts`); the endpoint returns an object **key**, which the form echoes back as `productImageKey` on submit. The client never receives or persists an absolute URL — keys are resolved to URLs at read time. The label photo is only uploaded as a fallback if on-device OCR fails — not stored permanently.
- The OCR sufficiency threshold is `MIN_OCR_LENGTH = 50` characters, defined as a shared constant. The same value must be used on both client (to decide whether to send text or image) and referenced in the backend docs.
**Submission payload (`POST /products` request body):**
```json
{
  "barcode": "string (required, 8–14 digits)",
  "name": "string (required)",
  "brand": "string | null",
  "genericName": "string | null",
  "energyKcal": "number | null",
  "carbohydrates": "number | null",
  "sugars": "number | null",
  "fat": "number | null",
  "saturatedFat": "number | null",
  "protein": "number | null",
  "salt": "number | null",
  "servingSize": "string | null",
  "productImageKey": "string (required — the S3 object KEY issued by POST /products/upload-image, shape `processed/{uuid}.jpg`)",
  "ingredients": "string | null"
}
```
**Image processing (client-side, before any upload):**
- Use `expo-image-manipulator` to resize and compress every image before it leaves the device:
  - *Product display photo*: resize to max 1200 px on the longest side, compress to JPEG at 85% quality.
  - *Label photo (OCR fallback)*: resize to max 1600 px on the longest side (higher res aids OCR accuracy), compress to JPEG at 90% quality.
- Run manipulation after capture/selection, before showing the preview — the preview should already display the processed version.
- If the processed file still exceeds **2 MB** (`MAX_IMAGE_BYTES` in `features/products/constants.ts`), show an inline error ("Photo is too large — please try again in better lighting or closer to the subject") and block the upload.
**Acceptance Criteria:**
- [x] User can photograph the product and the nutritional label from within the screen. *(client skeleton — uses `expo-image-picker` with camera + library fallback)*
- [x] On-device OCR runs locally after the label photo is captured (no network request at this stage). *(client skeleton — `features/products/ocr.ts` gracefully degrades when the native module isn't installed)*
- [x] If OCR text is sufficient, only the raw text (not the image) is sent to the backend.
- [x] If OCR text is insufficient, the label image is sent as a fallback for backend vision inference.
- [x] All images are resized and compressed client-side before upload using `expo-image-manipulator`.
- [x] Images exceeding 2 MB after compression show an inline error and are not uploaded.
- [x] All three fill modes work correctly (manual, pre-fill+edit, accept-all).
- [x] Required-field validation prevents submission of incomplete data.
- [x] Product display photo uploads to S3; the returned object key is included in the submission payload as `productImageKey`.
- [x] On successful submission, the user is navigated to the product screen.
- [x] A `422` response displays the AI rejection reason inline on the form; the user can correct the data and resubmit. *(server-side image plausibility shipped in P5-004; nutritional-value plausibility still deferred)*
- [x] Registered users who scan a `PENDING_REVIEW` product see a reviewer banner and can cast an approval or rejection. *(banner + `app/(app)/review-product/[barcode].tsx`; `unverified` + `submittedByUserId` in the GET response)*
- [x] The submitter of a product does not see the reviewer banner for their own submission.

**Implementation status (client skeleton 2026-04-17; backend complete as of 2026-07-29):**
- Client-side multi-step flow and reviewer screen are shipped in `bread-sheet-app/app/(app)/add-product.tsx` and `app/(app)/review-product/[barcode].tsx`.
- Business logic lives in `features/products/` (`api.ts`, `extract.ts`, `ocr.ts`, `image-picker.ts`, `image-processing.ts`, `constants.ts`, `types.ts`) — screens stay UI-only per the `features/` convention.
- `MIN_OCR_LENGTH = 50` is exported from `features/products/constants.ts`; the backend (P5-003) must reference the same value.
- Native modules (`@react-native-ml-kit/text-recognition`, `expo-image-picker`, `expo-image-manipulator`) are consumed via guarded `require()` so jest-expo tests pass without them. The user must install them and rebuild the native client before the full flow works end-to-end.
- All backing endpoints are shipped: `POST /api/products` (T3), `POST /api/products/upload-image` (T4), `POST /api/products/extract-label` — both the text path (T5) and the image path (T6, Google Cloud Vision / Gemini), `POST/DELETE /api/products/:barcode/verify` (T7), and the `GET /api/products/:barcode` `unverified`/`submittedByUserId`/`submission` augmentation (T8).

### [TICKET-P5-003] Backend: Label Extraction, Submission, & Peer Verification
**Goal:** Provide three backend capabilities: (1) structure nutritional data from on-device OCR text (primary) or a label image (fallback); (2) validate and normalise incoming images server-side; (3) accept product submissions from registered users and gate promotion to `VERIFIED` behind peer review by a second registered user.
**Endpoints:**
- `POST /products/extract-label` — accepts either `{ rawText: string }` (primary path, from on-device OCR) or a multipart label image (fallback path, when OCR was insufficient). The text path runs a hand-rolled regex parser (`labelExtractionService.ts`, English + German) — no LLM call. The image path is selected by `VISION_MODE`: `live` runs Google Cloud Vision OCR and feeds the result through the same regex parser; `llm` sends the image to Gemini for one-shot structuring (`labelExtractionLlmService.ts`); `mock` returns fixtures. Returns best-effort partial results on low-confidence extractions; never blocks the user flow. Response shape:
  ```json
  {
    "name": "string | null",
    "brand": "string | null",
    "genericName": "string | null",
    "energyKcal": "number | null",
    "carbohydrates": "number | null",
    "sugars": "number | null",
    "fat": "number | null",
    "saturatedFat": "number | null",
    "protein": "number | null",
    "salt": "number | null",
    "servingSize": "string | null",
    "ingredients": "string | null",
    "confidence": "low | medium | high"
  }
  ```
  The `confidence` field lets the client decide whether to default to "pre-fill & edit" (`medium`/`high`) or "fill manually" (`low`).
- `POST /products` — accepts the payload defined in P5-002. Runs AI plausibility checks, persists the product as `status: PENDING_REVIEW`, returns `201` with the created product. Only registered users may call this endpoint (see registration gate below).
- `POST /products/:barcode/verify` — no request body. A registered user who is **not** the original submitter confirms the product data looks correct. Records a `ProductVerification` row (`userId`, `barcode`, `createdAt`). Once **2 distinct verifications** exist for a product, the backend automatically promotes it to `status: VERIFIED` and enqueues the Open Food Facts sync job. Submitters attempting to verify their own submission receive `403 Forbidden`.
- `DELETE /products/:barcode/verify` — no request body. Casts a **REJECT** vote (it is not a retraction — the DELETE verb carries the negative vote). Registered non-submitters only. 2 net-rejections flip the product to `status: REJECTED`.
**Visibility rules for `PENDING_REVIEW` products:**
- Visible immediately to the submitter in their own history.
- Visible to all other registered users in scan/search results, but flagged with an `unverified: true` field in the response so the client can render a "Needs review" badge and a "Looks correct" action.
- Hidden from anonymous users — `GET /products/:barcode` returns `404` when the only match is `PENDING_REVIEW`. **Superseded by P5-008** (2026-07-29): anonymous users now see the product and the "Needs review" banner, but cannot vote.
**Image validation & normalisation (API-side, applies to all image uploads):**
- **Registration gate:** `POST /products` and `POST /products/extract-label` must be protected by a `requireRegistered` middleware that checks the Supabase JWT claim `is_anonymous !== true`. Anonymous tokens are rejected with `403 Forbidden` and a message directing the user to create an account. This is a defence-in-depth measure alongside the client-side gate.
- **Size gate (pre-processing):** Reject any multipart image field exceeding **4 MB** raw with `413 Payload Too Large` before touching the bytes. Configured via `multer` `limits.fileSize` in `routes/productRoutes.ts`. This acts as a hard server-side ceiling even if the client-side 2 MB check is bypassed.
- **Format normalisation:** Inspect the actual file signature (magic bytes via `file-type` or `sharp` metadata), not just the `Content-Type` header. If the image is not already JPEG or WebP, convert it to JPEG in-process using `sharp` before uploading. Unsupported formats (SVG, PDF, etc.) are rejected with `415 Unsupported Media Type`. This conversion is intentionally kept in the API (not Lambda) so that format rejection happens synchronously and the client gets an immediate error.
- **Resize via Lambda (S3-triggered):** After validation and format normalisation, the API uploads the image to the `raw/` prefix in S3 (`raw/{kind}/{uuid}.jpg`) and immediately returns the predicted processed object **key** (`processed/{uuid}.jpg`) to the client — it does not wait for resizing to complete. A key, not a URL: the client echoes it back on submit, and it is resolved to a URL at read time via `ASSET_BASE_URL`. A Lambda function (defined in `terraform/`, triggered by S3 `ObjectCreated` events on the `raw/` prefix) handles the definitive resize:
  - Product display photos: capped at 1200 px on the longest side.
  - Label images (OCR fallback): capped at 1600 px on the longest side.
  - Output always written as JPEG to `processed/{uuid}.jpg`.
  - The path prefix (`raw/product/` vs `raw/label/`) tells the Lambda which size cap to apply.
  - If the Lambda fails, the raw image remains in S3; a dead-letter queue alerts ops. The `processed/` URL will 404 until the Lambda completes, which is acceptable given this is async background processing.
**Plausibility checks (AI-assisted):**
- Nutritional values within realistic ranges (e.g. calories per 100 g typically 0–900 kcal, protein + fat + carbs ≤ 100 g).
- Barcode format matches expected GS1 structure.
- Name/brand fields are not empty or clearly nonsensical (gibberish detection via LLM).
- Flag (but don't hard-reject) values that are unusual but plausible (e.g. very high fat content for butter/oil).
**Schema changes:**
- Add `status` enum to `Product`: `VERIFIED` (from Open Food Facts cache or peer-approved), `PENDING_REVIEW` (user-submitted, awaiting verification), `REJECTED`.
- Add `submittedByUserId: String?` to `Product` — references the registered user who created the submission.
- Add `plausibilityFlag: Boolean` to `Product` (default `false`) — set when AI considers data unusual but acceptable.
- Add new model `ProductVerification`: `productId`, `userId`, `vote` (`APPROVE | REJECT`), `createdAt` — composite unique key on `(productId, userId)` to prevent duplicate votes. (Keyed on `productId`, not `barcode`, so verifications cascade with the product row.)
**Acceptance Criteria:**
- [x] Anonymous users calling `POST /products` or `POST /products/extract-label` receive `403` (both the text and the image path).
- [x] Images larger than 4 MB are rejected with `413` before any processing occurs.
- [x] Images in unexpected formats are converted to JPEG via `sharp`; unsupported formats return `415`.
- [x] Format detection uses magic bytes, not `Content-Type`. *(`file-type`'s `fileTypeFromBuffer`)*
- [x] After upload, a Lambda automatically resizes images to the appropriate cap and writes to the `processed/` S3 prefix. *(`server/lambda/imageResizer`; wired up in `terraform/lambda.tf` and, locally, by `scripts/localstack-init.sh`)*
- [x] The API returns the predicted `processed/` object key immediately without waiting for the Lambda.
- [x] `POST /products/extract-label` accepts raw OCR text and returns structured nutritional fields. *(T5: hand-rolled regex parser, English + German; the original Claude-based approach was superseded — see implementation plan)*
- [x] `POST /products/extract-label` also accepts a label image as a fallback and runs Google Cloud Vision inference. *(T6; `VISION_MODE=llm` routes to Gemini instead)*
- [x] The text path is used whenever `rawText` is provided; the image path is only invoked when no text is present.
- [x] `POST /products` persists a user-submitted product with `status: PENDING_REVIEW`. *(P5-003/T3)*
- [x] `POST /products/:barcode/verify` casts an `APPROVE` vote from a registered non-submitter; returns `403` if the caller is the submitter. *(P5-003/T7)*
- [x] `DELETE /products/:barcode/verify` casts a `REJECT` vote (non-submitter only); 2 net-rejections flip status to `REJECTED`. *(P5-003/T7 — overloaded REJECT channel, not a retraction)*
- [x] `PENDING_REVIEW` products return `unverified: true` (with `submittedByUserId` and a `submission` block) in the response and are hidden from anonymous users (`404`). *(P5-003/T8 — the anonymous-`404` half is superseded by **P5-008**; the `unverified`/`submission` payload stays as-is.)*

> **Moved out of this ticket (2026-07-29).** A former AC here read *"`PENDING_REVIEW` products show for all users, with banner indicating unverified. Users that are logged in have button to review information."* It directly contradicted the AC above, and honouring it is a behaviour change to already-shipped code rather than an unfinished slice of P5-003. It is now specified in **[TICKET-P5-008]**.
- [x] A migration adds the `status` field with a default of `VERIFIED` for existing Open Food Facts-sourced products. *(P5-003/T1)*

### [TICKET-P5-004] Product Image Plausibility & Abuse Gating
**Goal:** Run an AI plausibility check on uploaded images so the app (1) rejects images that are not the expected subject (a chair, a pet, a selfie) with actionable feedback, (2) reads correct product identity (name/brand/generic name) off the product photo so the submission form pre-fills instead of showing confusingly empty fields, and (3) flags genuinely abusive uploads (sexual / graphic) server-side for moderation. Implementation plan: `docs/P5-005-implementation-plan.md`.
**Where it runs:** Inside `POST /api/products/upload-image`, on the in-memory buffer **before** the S3 write — so a rejected image is never persisted (no orphan objects). Both `kind=product` and `kind=label` uploads are gated.
**Provider / config:** New `imagePlausibilityService.ts` using Gemini multimodal, behind a dedicated `PLAUSIBILITY_MODE` env var (`mock | gemini`, no default — fail-fast). `mock` accepts all (local/test). Independent of `VISION_MODE`. (`tesseract` VISION_MODE was removed in this ticket.)
**Verdict contract:**
- `ok` → upload proceeds. For `product` photos the same call returns front-of-pack `name`/`brand`/`genericName` suggestions; these win those three fields over label OCR on the form (label fills them only if the photo left them blank). Nutrition fields still come from label extraction.
- `not_a_product` / `unusable` → `422 { error: 'image_rejected', reason }` with actionable copy; nothing stored, no record.
- `abuse` → `422` with **generic** copy; a `UserAbuseFlag` row (`userId`, `reason`, `createdAt`) is recorded server-side — count + free-text reason only, no category. The model's specific reason is never returned to the client.
**Client:** Product photo is uploaded at capture time (not at submit) so rejection feedback and identity suggestions arrive before the review step; the submit step reuses the already-uploaded URL.
**Schema:** New `UserAbuseFlag` model (`userId`, `reason?`, `createdAt`); `User.abuseFlags` relation. Deliberately no category enum — we only track the per-user count and a free-text reason. Record-only — a moderation dashboard / auto-ban threshold is a later ticket.
**Acceptance Criteria:**
- [x] A clearly non-product product photo is rejected (`422`) with actionable copy; nothing is written to S3.
- [x] A blurry/unusable photo is rejected (`422`) advising a retake; nothing is written.
- [x] A valid product photo returns `200` with `name`/`brand`/`genericName` suggestions and the `processed/` URL.
- [x] Abusive content on **either** `kind=product` or `kind=label` returns `422` and records a `UserAbuseFlag`; nothing is written to S3.
- [x] Non-abusive rejections do not create a `UserAbuseFlag`.
- [x] `PLAUSIBILITY_MODE` is validated at startup; `gemini` without `GEMINI_API_KEY` throws; an invalid value throws.
- [x] The client pre-fills the form from the upload suggestions (photo wins name/brand/genericName) and surfaces rejection reasons inline with a retake affordance; submit reuses the uploaded URL.
- [x] `tesseract` removed from `VISION_MODE`; no remaining references in code or docs (historical dated plan docs excepted).
- [x] Nutritional-value plausibility (kcal ranges, macro sums) on `POST /products` — still deferred to a follow-up.

### [TICKET-P5-005] Product Editing & Peer-Review of Changes
**Goal:** Allow registered users to propose corrections to existing product data. Changes are not applied immediately — two other registered users must review and confirm the diff before it takes effect. Verified edits are synced back to Open Food Facts.
**Key design decisions (resolved 2026-05-16):**
- **Everyone goes through the proposal flow for VERIFIED products, including the original submitter.** There is no special-case bypass for the user who originally created the product — once peer-verified, every change requires fresh peer review. The PENDING_REVIEW correction path (`PATCH /products/:barcode`) is the *only* shortcut, and it only applies while the product hasn't been verified yet.
- **Ratings persist across edits.** When an edit is APPLIED, the `Product.id` is preserved, so all existing `Rating` rows continue to reference the same product. This is intentional — the same physical product is being described, just with corrected metadata; tasters' opinions remain valid.
- **Track both original author and last modifier.** Keep `Product.submittedByUserId` pointing at whoever originally created the row (it never changes after creation). Add a new `Product.lastModifiedByUserId` that is updated whenever an edit is APPLIED. This gives audit clarity without losing original-author attribution.
- **The "one pending edit per barcode" rule is enforced at the database layer**, not only by an API-level 409. See the partial unique index in the schema section.
- **Ship the full proposal model in one go** — no smaller MVP cut. The `PATCH` reset-and-revote on PENDING_REVIEW is the only lite path; every change to a VERIFIED product goes through the explicit `ProductEdit` proposal.
**Frontend — Edit entry point:**
- On the Product Detail screen, show an **"Edit product"** icon/button for registered users. Hidden entirely for anonymous users (no tooltip, no disabled state — just absent).
- If the product has `status: PENDING_REVIEW`, the button label changes to **"Correct this submission"** to signal the different intent. Tapping it still opens the same edit form pre-filled with current data, but the submit path is different (see backend section below).
- If the product has `status: VERIFIED` but already has a `PENDING` edit, hide the edit button and show a small notice: "An edit is already under review."
- Tapping navigates to `app/(app)/edit-product/[barcode].tsx`, pre-filled with the current product values.
- The edit form is identical in layout to the Add Product screen (P5-002) but all fields start pre-populated. The barcode field is read-only.
- On submit, POST the changed fields to the backend. If the user has not changed anything, the submit button is disabled.
**Frontend — Reviewer diff screen:**
- When a registered user opens a product that has a `PENDING_EDIT`, show a non-intrusive banner: "Someone suggested a change to this product — want to review it?"
- Tapping opens a **diff screen** (`app/(app)/review-edit/[editId].tsx`). For every changed field, render a two-column row: the `originalValues` snapshot on the left (struck through, muted colour) and the `proposedChanges` value on the right (bold, accent colour). Unchanged fields are shown beneath in a collapsed "Unchanged fields" section so the reviewer can verify what was not touched. The `originalValues` come from the `ProductEdit` record — not the live product — so the baseline is always the state at the time the edit was proposed, even if the product has since been corrected via a PENDING_REVIEW reset.
- Three actions:
  - **"Looks correct"** — casts an approval vote.
  - **"Something's wrong"** — casts a rejection vote.
  - **"Dismiss"** — records a server-side `ProductEditDismissal` row (`userId`, `editId`) so the banner stays hidden across devices and reinstalls. Does not count as a vote. The edit remains pending for other users.
- The diff screen is only shown once per edit per user (until dismissed or voted). Users who authored the edit do not see the review banner for their own submission.
- Show the current vote tally (e.g. "1 of 2 approvals needed") to give context, but do not reveal who voted.
**Backend — Endpoints:**
- `PATCH /products/:barcode` (PENDING_REVIEW correction) — accepts a full product payload. Only valid when the product has `status: PENDING_REVIEW`; returns `409` if called on a `VERIFIED` product (use the edit flow instead). On success: updates the `Product` record in-place with the new data, deletes all existing `ProductVerification` rows for this barcode, sets `submittedByUserId` to the calling user, keeps `status: PENDING_REVIEW` so the review cycle restarts from zero. If the correcting user differs from the original submitter, sends an in-app notification to the original submitter: "Your product submission was corrected by another user." Returns the updated product.
- `POST /products/:barcode/edits` — accepts a partial product payload (only changed fields). Only valid when the product has `status: VERIFIED`; returns `409` if a `PENDING` edit already exists for this product. Creates a `ProductEdit` record with `status: PENDING`. Only registered users; returns `403` for anonymous tokens.
- `GET /products/:barcode/edits/pending` — returns the current pending edit for a product (fields: `editId`, `originalValues`, `proposedChanges` as a diff object, vote counts). Used by the client to decide whether to show the review banner and to populate the diff screen.
- `POST /products/edits/:editId/votes` — body `{ vote: "APPROVE" | "REJECT" }`. Records a `ProductEditVote`. Returns `403` if the caller is the edit author. Composite unique key on `(userId, editId)` prevents double-voting.
- `DELETE /products/edits/:editId/votes` — retracts the caller's vote if the edit is still `PENDING`.
**Edit resolution logic (triggered after each new vote):**
- **2 approvals** → apply the proposed changes to the `Product` record, mark edit `status: APPLIED`, enqueue OFF sync for the updated fields (including any new images). Notify the author (in-app).
- **2 rejections** → mark edit `status: REJECTED`, discard proposed changes. Notify the author.
- Tie-breaking: if votes are mixed (e.g. 1 approve + 1 reject), wait for a third voter to reach 2 on either side.
- Edits that receive no votes within **2 years** are automatically expired (`status: EXPIRED`) by a scheduled cleanup job. *(Was 30 days; widened 2026-07-03 for the current user-base size.)*
**OFF sync for edits:**
- Reuses the P6-005 sync infrastructure. On `APPLIED`, enqueue an OFF update for the changed fields only (partial update via the OFF product write API). Image fields are re-uploaded to OFF if they changed.
- Sync is idempotent — uses the barcode as the OFF product key, so repeated syncs update rather than duplicate.
**Schema additions:**
- Add to `Product`: `lastModifiedByUserId: String?` — references the user whose edit was most recently APPLIED. Set by the edit-resolution job at the moment a `ProductEdit` flips to APPLIED. Stays `null` until the first applied edit. `submittedByUserId` is intentionally left untouched on edit so the original-author attribution is preserved permanently.
- New model `ProductEdit`: `id`, `barcode` (FK → Product), `authorUserId`, `originalValues` (JSON — snapshot of the product fields at submission time), `proposedChanges` (JSON — field name → new value), `status` (`PENDING | APPLIED | REJECTED | EXPIRED`), `createdAt`, `expiresAt`. Capturing `originalValues` at submission time ensures the diff screen always shows the correct baseline even if the product record changes later.
- New model `ProductEditVote`: `id`, `editId` (FK → ProductEdit), `userId`, `vote` (`APPROVE | REJECT`), `createdAt`. Composite unique key on `(editId, userId)`.
- New model `ProductEditDismissal`: `id`, `editId` (FK → ProductEdit), `userId`, `createdAt`. Composite unique key on `(editId, userId)`. Used to persist dismissals server-side across devices.
- **DB-level "one pending edit per barcode" constraint.** Add a partial unique index in the migration: `CREATE UNIQUE INDEX one_pending_edit_per_product ON "ProductEdit" ("barcode") WHERE "status" = 'PENDING';`. This is the source of truth — the API's 409 response is a friendly mirror, but the database refuses the second insert even if two requests race. Prisma can declare this via `@@unique` does not support partial conditions directly, so use a raw migration step (`prisma migrate dev` will accept hand-written SQL inside the migration file).
**Scope adjustments (2026-07-03):**
- Expiry window is **2 years** (was 30 days) — chosen for the current user-base size.
- **In-app notifications are deferred** (no notification infrastructure exists yet); `TODO(P5-006-followup)` markers sit at the notification points in `productEditService.ts`.
- **OFF sync enqueueing is deferred to P6-005** entirely (no schema fields yet); a `TODO(P6-005)` marker sits at the apply-resolution point.
**Acceptance Criteria:**
- [x] Registered users see an "Edit product" button on the Product Detail screen; anonymous users do not.
- [x] For `PENDING_REVIEW` products, the button label is "Correct this submission" and submitting calls `PATCH /products/:barcode` (reset path).
- [x] For `VERIFIED` products with a `PENDING` edit, the button is hidden and a notice is shown.
- [x] The edit form is pre-populated with current product values; the barcode field is read-only.
- [x] Submitting unchanged data is blocked client-side (submit button disabled).
- [x] `PATCH /products/:barcode` on a `PENDING_REVIEW` product updates the data in-place, clears existing verifications, reassigns `submittedByUserId`. *(Notifying the original submitter: deferred — no notification infra yet.)*
- [x] `POST /products/:barcode/edits` returns `403` for anonymous users and `409` if a pending edit already exists or the product is `PENDING_REVIEW`.
- [x] A registered non-author user sees the review banner on a product with a pending edit.
- [x] The diff screen clearly shows old vs. new values for every changed field.
- [x] "Looks correct" and "Something's wrong" record votes; "Dismiss" records a server-side dismissal and hides the banner across all devices for that user.
- [x] A user cannot vote on their own edit (`403`).
- [x] A user cannot vote twice on the same edit (duplicate vote returns `409`).
- [x] 2 approvals apply the edit. *(Author notification + OFF sync enqueue: deferred, see scope adjustments.)*
- [x] 2 rejections discard the edit. *(Author notification: deferred.)*
- [x] Mixed votes (1–1) wait for a third voter rather than resolving early.
- [x] Pending edits with no votes after **2 years** are expired by a daily in-process cleanup job.
- [x] The original submitter of a VERIFIED product must use the same proposal flow as any other user — no bypass path exists.
- [x] When an edit is APPLIED, the existing `Rating` rows on the product remain attached and unchanged.
- [x] When an edit is APPLIED, `Product.lastModifiedByUserId` is set to the edit's `authorUserId`; `Product.submittedByUserId` is unchanged.
- [x] Attempting to create a second `PENDING` `ProductEdit` for the same barcode fails at the database level (partial unique index violation), not only at the API layer.

### [TICKET-P5-006] FE Fixes — Eliminate Marginal Scroll
**Goal:** When a screen overflows the viewport by only a small amount (~20 px), tighten vertical spacing so the content fits instead of leaving the user with a page that scrolls almost imperceptibly. A screen that "nearly fits" reads as broken: the scroll indicator flashes, the content rubber-bands, and there is nothing meaningful below the fold.

**Affected screens** (every current `ScrollView` host): `app/(app)/product/[barcode].tsx`, `app/(app)/add-product.tsx`, `app/(app)/edit-product/[barcode].tsx`, `app/(app)/review-product/[barcode].tsx`, `app/(app)/review-edit/[editId].tsx`, `app/(tabs)/index.tsx`, `app/(tabs)/profile.tsx`. Each currently hard-codes its vertical padding (e.g. `scrollContent: { paddingBottom: 40 }` at `product/[barcode].tsx:730`), so nothing adapts to viewport height.

**Approach — measure, then compact:**
- New hook `hooks/use-fit-to-screen.ts`. It takes the `ScrollView`'s `onLayout` height (viewport) and `onContentSizeChange` height (content) and returns `{ compact: boolean }`.
- `compact` is `true` only when `0 < overflow <= COMPACT_MAX_OVERFLOW` (default **32 px**, exported as a named constant). Above that, the screen genuinely has more content than fits and must scroll normally — leave it alone.
- Screens consume `compact` to swap a small set of **vertical spacing tokens** (section gaps, card padding, `paddingBottom`) for tightened values. Define these as a `SPACING` / `SPACING_COMPACT` pair rather than scattering conditionals through each stylesheet.

**The trap this must not fall into — oscillation.** Compacting removes the overflow, which makes the hook report "fits", which un-compacts, which re-introduces the overflow. The hook must **latch**: once `compact` is `true` it stays true, and only reverts when the *uncompacted* content would fit with at least 8 px of slack. Track the last measured uncompacted content height and compare against that, never against the compacted measurement. Any implementation that simply re-evaluates the current measurement each render will flicker.

**Accessibility guardrails (non-negotiable):**
- Never scale font sizes — only margins, padding, and gaps.
- Never shrink an interactive element below a 44×44 px touch target.
- Skip compaction entirely when `PixelRatio.getFontScale() > 1.3`. A user who has asked for large text is better served by scrolling than by cramped or clipped content.

**Complementary cheap fix (do this regardless):** set `alwaysBounceVertical={false}` and, on Android, `overScrollMode="never"` on these `ScrollView`s so a barely-overflowing screen does not rubber-band. This alone removes much of the "feels broken" sensation and is worth landing even if the measurement work is deferred.

**Out of scope:** any change to horizontal layout, font scaling, or the parallax header in `components/parallax-scroll-view.tsx` (its scroll is intentional).

**Acceptance Criteria:**
- [x] A screen overflowing by ≤ 32 px renders without scrolling, with vertical spacing tightened.
- [x] A screen overflowing by more than 32 px scrolls normally, with no spacing change.
- [x] A screen that already fits is visually unchanged. *(Base stylesheets are untouched; compaction lives in a separate `compactStyles` sheet applied only when `compact` is true.)*
- [x] Compaction does not oscillate: once applied it holds, and re-measurement on rotation or content change does not produce visible flicker.
- [x] No font size changes as a result of compaction.
- [x] No interactive element falls below a 44×44 px touch target when compacted. *(Structural: compact overrides never touch the padding inside a pressable — only container padding/gaps and the margins around controls.)*
- [x] With the OS font scale above 1.3, compaction is skipped and the screen scrolls normally.
- [x] `alwaysBounceVertical={false}` (and `overScrollMode="never"` on Android) is applied to the listed screens.

### [TICKET-P5-007] Anonymous Visibility of Pending Products
**Goal:** Let anonymous users see `PENDING_REVIEW` products instead of hitting a "Product not found" dead end. They get the same "Needs review" banner registered users get, so they understand *why* the data may be rough — but they cannot vote. In place of the review action they see a note telling them to log in.
**Supersedes:** the visibility rule in P5-003 that returns `404` to anonymous callers for `PENDING_REVIEW` products.
**Rationale:** the `404` was chosen so unverified, user-supplied content was only ever shown to accountable (registered) users. In practice it produces a worse failure than the problem it avoids: an anonymous user who scans a barcode a neighbour just submitted is told the product does not exist, and the app offers them nothing. Showing the product behind an explicit "unverified" banner is honest about the data quality while keeping every write path registered-only, which is where the abuse risk actually lives.

**Backend — `GET /products/:barcode`:**
- Drop the anonymous `PENDING_REVIEW` → `404` branch in `productController.getProductByBarcode`. Anonymous callers receive the product with `unverified: true` and the same `submission` block registered users get.
- **Do not** include `submittedByUserId` in responses to anonymous callers. Registered clients need it for the "don't show me a banner for my own submission" check; anonymous users cannot submit, so the field has no purpose for them and omitting it avoids handing a user UUID to an unauthenticated session (see `docs/architecture/data.md` §5.4 on that linkage).
- No change to any write path. `POST`/`DELETE /products/:barcode/verify` keep `requireRegistered`, so an anonymous token still gets `403`. The client-side gate below is UX, not the security boundary.
- `REJECTED` products remain invisible to everyone — this ticket only changes `PENDING_REVIEW`.

**Frontend — Product Detail screen (`app/(app)/product/[barcode].tsx`):**
- The "Needs review" banner currently renders only when `product.unverified && !isAnonymous && product.submittedByUserId !== userId`. Drop the `!isAnonymous` condition so anonymous users see it too.
- For anonymous users the banner is **informational, not interactive**: it must not be a `TouchableOpacity`, must not navigate to `app/(app)/review-product/[barcode].tsx`, and must carry a third line of copy — "Log in to review this product." — in place of the tap affordance.
- Keep the banner copy otherwise identical ("Needs review" / "This product was added by a user — does it look correct?") so both audiences read the same explanation of the product's state.
- Registered-user behaviour is unchanged, including the rule that submitters do not see the banner for their own submission.
- Out of scope: making the anonymous note tappable. The P5-001 `returnTo` deep-link pattern is available if we later want it to route into signup and return here, but this ticket ships a plain note.

**Frontend — Reviewer screen (`app/(app)/review-product/[barcode].tsx`):**
- Unchanged. It already refuses to render for `!session || isAnonymous`; that guard stays as defence-in-depth for deep links.

**Acceptance Criteria:**
- [ ] `GET /products/:barcode` returns a `PENDING_REVIEW` product to an anonymous caller with `unverified: true` and the `submission` block, instead of `404`.
- [ ] That response omits `submittedByUserId`; the registered-user response still includes it.
- [ ] `REJECTED` products still return `404` for every caller.
- [ ] An anonymous user viewing a `PENDING_REVIEW` product sees the "Needs review" banner with the same title and explanation a registered user sees.
- [ ] The anonymous banner additionally shows "Log in to review this product." and is not tappable — no navigation to the reviewer screen occurs on press.
- [ ] A registered non-submitter still sees the tappable banner and can still open the reviewer screen and vote.
- [ ] A registered submitter still sees no banner for their own submission.
- [ ] `POST`/`DELETE /products/:barcode/verify` still return `403` for anonymous tokens.

**Side effect to confirm before building:** `POST /ratings` is guarded by `requireAuth` only, so anonymous users can already rate anything they can see. Making pending products visible therefore also makes them *ratable* by anonymous users — ratings attached to data that has not passed peer review yet. This ticket assumes that is acceptable (the rating survives whatever the product's metadata settles on, and the `Product.id` is preserved through both the P5-005 edit path and the `PATCH` reset path). If it is not, the fix is a `requireRegistered` — or a status check — on the rating path, and it should be its own ticket.

## Phase 6: Social

### [TICKET-P6-001]  Add Allergen Information
Add allergenic information to products.

### [TICKET-P6-002] Group Management
**Goal:** Enable private sharing contexts. E.g., a household shares ratings for basic foods while enabling different opinios.
**Logic:**
- Users create a group -> generate shareable code.
- Other users join via code.
- Feed filtering: "My Groups" vs "Global".
- Group votes: Show highest vote with member and average (if the same, don't show highest vote)
- If you are part in a group and vote for a product - set default if always for group or private
- If you join a group, select if you want to share no votes, all votes, some votes, select categories
- If you are a member, in detail tab of group, share votes afterwards
**Acceptance Criteria:**
- [ ] User can create a group.
- [ ] User can join a group with a code.
- [ ] Ratings can be filtered by group context.

### [TICKET-P6-003]  Add Product Categories
Allow easy selection to see own votes in categories (e.g. what wine I liked, what cigars, what cocktails)

### [TICKET-P6-004] User Scenario - Supermarket Lookup
- If rating (personal or group) is already given, show not a rating screen but a rating overview (personal, groups (same logic, highest with user, and median))

### [TICKET-P6-005] Open Food Facts Contribution Sync
**Goal:** Automatically contribute user-verified product data back to the Open Food Facts (OFF) project using their write API, closing the loop between local submissions and the upstream open dataset.
**Logic:**
- Sync is triggered when a product or edit reaches `VERIFIED` status via peer review (not at submission time — plausibility checks gate quality, but peer approval gates OFF contribution).
- Sync runs as a **node-cron scheduled job inside the existing `server/` process**, polling every 5 minutes for queued items. This keeps the infra simple for now; the job can be extracted to a Lambda later without changing the queue contract.
- **New product sync:**
    1. Fetch all `VERIFIED` products with `offSyncStatus: QUEUED`.
    2. Submit to the OFF Product Add API (`POST https://world.openfoodfacts.org/cgi/product_jqm2.pl`) using the registered OFF bot account.
    3. Upload product image to OFF's image endpoint.
    4. On success: set `offSyncStatus: SYNCED`, store `offProductUrl`.
    5. On failure: increment `offSyncAttempts`, set `offRetryAt` (exponential back-off). After 5 failures: set `offSyncStatus: FAILED` and notify the submitter **in-app** (not email — keeps the notification infrastructure simple and consistent with the rest of the app).
- **Edit sync (triggered when a `ProductEdit` reaches `status: APPLIED`):**
    1. Fetch the `ProductEdit` record and its `proposedChanges` JSON.
    2. Submit only the changed fields to OFF using the same product write API (partial update — OFF uses the barcode to identify the existing entry and merges the provided fields).
    3. Re-upload image to OFF only if `productImageKey` is in `proposedChanges`.
    4. Same retry and failure logic as new product sync; failure notification goes to the edit author.
- Image assets (product photo) are pushed to OFF's image upload endpoint; the label photo is never stored or sent.
- All sync activity is idempotent — re-running on the same barcode updates the existing OFF entry rather than creating a duplicate.
  **Schema additions to `Product`:**
- `offSyncStatus`: `QUEUED | SYNCING | SYNCED | FAILED`
- `offSyncAttempts: Int`
- `offRetryAt: DateTime?`
- `offProductUrl: String?`
  **Notes:**
- OFF requires an account with edit rights; credentials stored in server env vars (`OFF_USERNAME`, `OFF_PASSWORD`).
- Respect OFF's rate limits (no more than ~100 writes/hour for bot accounts).
- All sync activity should be idempotent — re-running on the same product must not create duplicates (use barcode as the OFF product key).
  **Acceptance Criteria:**
- [ ] Products promoted to `VERIFIED` via peer review are automatically submitted to Open Food Facts.
- [ ] Peer-verified product edits (from P5-005) are synced to OFF as updates to the existing product entry, not as new submissions.
- [ ] Product images are uploaded to OFF alongside structured data.
- [ ] Sync failures retry with exponential back-off and cap at 5 attempts.
- [ ] After 5 failed attempts, the product is marked `REJECTED` and the submitter is notified.
- [ ] Sync is idempotent — re-submitting the same barcode to OFF does not create a duplicate entry.
- [ ] `OFF_USERNAME` and `OFF_PASSWORD` are stored in env vars, never hard-coded.

## Phase 7: Auth Enhancements

### [TICKET-P7-001] Social Login Providers (Google, Apple)
**Goal:** Allow users to sign in and upgrade guest accounts using OAuth providers, reducing friction compared to email/password.
**Implementation:**
- **Supabase:** Enable Google and Apple providers in the Supabase dashboard. Configure OAuth credentials from Google Cloud Console and Apple Developer Console.
- **Frontend (web):** Use `supabase.auth.signInWithOAuth()` for redirect-based flow — add to `features/auth/`.
- **Frontend (native):** Web redirect flow does not work on native. Use `expo-auth-session` (Google) and `expo-apple-authentication` (Apple) to obtain tokens natively, then exchange via `supabase.auth.signInWithIdToken()`.
- **Anonymous upgrade:** Extend the upgrade screen with provider buttons using `supabase.auth.linkIdentity()` as an alternative to the email/password path.
- **Platform branching:** `features/auth/` will need platform-aware logic (`Platform.OS`) for web vs native OAuth paths.
**Notes:**
- Apple Sign In is mandatory on iOS if any other third-party social login is offered (App Store guideline 4.8).
- Google and Apple must both ship together on iOS for compliance.
**Acceptance Criteria:**
- [ ] User can sign in with Google on web and native.
- [ ] User can sign in with Apple on iOS.
- [ ] Anonymous user can link a Google or Apple account from the upgrade screen.
- [ ] Linking a provider to an existing anonymous account preserves all user data.

### [TICKET-P7-002] API Authorization — Roles & Resource Ownership
**Goal:** Enforce that users can only access or modify resources they own or are permitted to reach via group membership/role, preventing horizontal privilege escalation.
**Scope:**
- **User resources:** `GET /users/:id`, `PATCH /users/:id`, and any user-scoped sub-resources (ratings, history) must only be accessible by the user themselves. No other user may read or mutate another user's private data.
- **Group resources:** All group endpoints (`GET/PATCH/DELETE /groups/:id`, member lists, invite codes) must verify the requesting user is a member of that group. Write/admin operations (rename, delete group, kick members, regenerate invite code) must additionally require the `ADMIN` role within that group.
- **Rating resources:** `PATCH` and `DELETE` on a rating must verify the rating belongs to the authenticated user.
- **Middleware pattern:** Implement reusable Express middleware / guard helpers (e.g. `requireSelf`, `requireGroupMember`, `requireGroupAdmin`) that can be composed on any route, rather than inlining ownership checks in every controller.
**Implementation:**
- Add `requireSelf(paramName)` middleware: compares `req.user.id` against the route param; throws `403 Forbidden` on mismatch.
- Add `requireGroupMember` middleware: looks up `GroupMember` record for `(req.user.id, groupId)`; throws `403` if not found.
- Add `requireGroupAdmin` middleware: same lookup but also asserts `role === 'ADMIN'`.
- Apply guards in the router layer so controllers receive only already-authorized requests.
- Return `403 Forbidden` (not `404`) when the resource exists but the user is not permitted — leaking resource existence to unauthorized users is a separate concern and can be addressed per-endpoint.
- Add integration tests covering: own resource access succeeds, cross-user access returns `403`, non-member group access returns `403`, member-only group admin action returns `403`.
**Acceptance Criteria:**
- [ ] A user cannot read or modify another user's profile, ratings, or history.
- [ ] A non-member cannot read any data from a group they do not belong to.
- [ ] A group `MEMBER` cannot perform admin-only actions (delete group, manage members, regenerate code).
- [ ] A group `ADMIN` can perform all admin-only actions within their group.
- [ ] A Moderator or ADMIN can allow products directly
- [ ] Ownership guards are implemented as composable middleware, not adD-hoc per-controller checks.
- [ ] All new authorization rules are covered by integration tests.

## Phase 8: Offline & Performance

**Context (analysis 2026-07-29):** the app has no cache layer at all. Every screen calls `api.get` directly inside `useFocusEffect`, so re-focusing refetches and offline means spinner → error text. `RecentProductsProvider` (`hooks/use-recent-products.tsx`) holds its list in plain `useState`, so "Recently Opened" is empty on every cold start — that is most of the "not snappy" feeling. The product screen makes up to three round trips per open (product, my rating, pending edit). There are no storage or state dependencies in `bread-sheet-app/`: no react-query, AsyncStorage, MMKV, SQLite, or NetInfo. The only persistence primitive in the project is `expo-file-system`, used by `lib/pending-return-to.ts`.

**Substrate decision:** JSON files via `expo-file-system`, **not** SQLite. This follows the precedent P5-001 set (avoid another native module; jest-expo keeps passing without it) and the data is small — ~200 products and at most one rating per product. SQLite only earns its place if we add offline product *search by name*.

### [TICKET-P8-001] Persist the Supabase Session on Device
**Goal:** Keep users signed in across app restarts.
**Problem:** `lib/supabase.ts` calls `createClient` without a `storage` adapter. `persistSession` defaults to `true`, but auth-js resolves storage in the order explicit `storage` → `globalThis.localStorage` → in-memory fallback (`GoTrueClient.js:222-241`). React Native has no `localStorage`, so the session lives in memory and dies with the process. On web (`react-native-web`) `localStorage` exists, so this affects native only.
**Why this blocks the rest of Phase 8:** without a session, `authHeaders()` returns `{}` and every request 401s. An offline cold start cannot even establish *which user's* cache to read. This is a prerequisite, not a slice of the offline feature.
**Side effect worth noting:** anonymous users currently get a brand-new anon user id on every restart, silently orphaning their earlier ratings server-side. Fixing persistence resolves most of what **P5-006** is reaching for without any local rating store — see that ticket's findings.
**Implementation:**
- Pass a `storage` adapter to `createClient`. Recommended: `@react-native-async-storage/async-storage` — the path Supabase documents and tests. (`expo-file-system` would preserve the project's zero-new-native-deps streak, but auth is the wrong place to be clever.)
- Set `autoRefreshToken: true` and drive it off `AppState` so refresh pauses while backgrounded.
**Verification note:** the above was read from auth-js internals, not observed on a device. Confirm the symptom on a real cold start before building.
**Acceptance Criteria:**
- [ ] A registered user who force-quits and relaunches lands authenticated, without a login screen.
- [ ] An anonymous user keeps the same user id across a restart; ratings made before the restart are still theirs.
- [ ] An expired token is refreshed on foreground without bouncing the user to login.
- [ ] With no network at launch, a previously signed-in user is not logged out; requests fail but the session survives.
- [ ] Signing out clears the persisted session and all user-namespaced caches.

### [TICKET-P8-002] Offline Read Cache & Snappy Startup
**Goal:** Products, the user's own ratings, and the recents list render instantly from disk on launch and stay readable with no connectivity — the supermarket case, where the user scans something they have already looked at.
**Depends on:** P8-001.
**Architecture:**
- `lib/offline/store.ts` — typed, versioned, **user-namespaced** JSON store (`v1/{userId}/…`) over `expo-file-system`. Namespacing is not optional: the anon→registered upgrade and account switching must never leak one user's votes into another's view. A schema-version mismatch wipes rather than migrates.
- `hooks/use-cached-resource.ts` — stale-while-revalidate. Paint from cache in the first frame (no spinner on a cache hit), revalidate in the background, swap on success, keep showing cache plus an "offline" indicator on failure. This is what actually delivers "snappy".
- Three caches: product-by-barcode (LRU-capped ~200), the `/api/users/me/ratings` payload, and the recents list (persist the existing provider's state).
- **Index the cached ratings list by barcode and have the product screen read "my rating" from it** instead of calling `/api/ratings/me/:barcode`. This removes a round trip per product open, online as well as off.
**Correctness trap to fix here:** `lib/api.ts` throws a raw `TypeError` from `fetch` on network failure, not an `ApiError`. P5-001's not-found branch checks `err.status === 404`, so it is safe today — but it is one refactor away from showing "This product isn't in the database yet — add it?" to someone who is merely offline. Introduce a typed `NetworkError` so "offline" and "the server said no" are structurally distinguishable.
**Acceptance Criteria:**
- [ ] Recently Opened survives a cold start.
- [ ] Opening a previously viewed product with no network renders name, brand, image, nutrition, and the user's own rating from cache — no spinner, no error screen.
- [ ] The product image renders offline (`expo-image` with `cachePolicy="memory-disk"`).
- [ ] Cached content paints before any network request resolves; fresh data swaps in when it arrives without a visible flash.
- [ ] An "offline" indicator appears when revalidation fails and clears on success.
- [ ] Scanning an *uncached* barcode offline shows an offline message — **not** the "Product not found / Add this product" state.
- [ ] The Home tab renders the cached ratings list offline; pull-to-refresh surfaces the offline state rather than emptying the list.
- [ ] The product screen sources "my rating" from the cached ratings list instead of a second request.
- [ ] Caches are namespaced per user id; signing out or switching accounts never shows another user's data.
- [ ] The product cache is LRU-capped (~200); a schema-version bump wipes rather than migrates.
- [ ] `lib/api.ts` distinguishes network failure (`NetworkError`) from HTTP errors (`ApiError`).

### [TICKET-P8-003] Anonymous Ratings — Durable and Visible
**Goal:** Anonymous users can rate products and see those ratings, and the ratings survive both an app restart and the upgrade to a registered account.

**Findings (analysis 2026-07-29) — the original framing ("stored locally, then moved to the profile on register") is not the work this needs:**
- **Anonymous ratings are already stored server-side.** `POST /api/ratings` is guarded by `requireAuth` only (`routes/ratingRoutes.ts:12`), and Supabase anonymous sessions satisfy it. `syncUser` already creates the backing `User` row for an anonymous session, normalising the empty-string email to `null` so the `@unique` constraint isn't violated (`controllers/userController.ts:8-30`).
- **The upgrade path already preserves identity.** `upgradeAccount` calls `supabase.auth.updateUser({ email, password })` on the *existing* session (`features/auth/index.ts:27-29`) — Supabase's documented anonymous-upgrade path, which keeps the same user id. The ratings are therefore already attached to the right user the moment the upgrade completes. **No migration code is needed, and none should be written.**
- **What is actually broken is durability.** The session is not persisted on native (see **P8-001**), so every cold start mints a *new* anonymous user id and silently orphans the previous session's ratings. This is the entire "my votes disappeared" problem.
- **What is deliberately hidden is visibility.** Three UI gates keep anonymous users from seeing ratings they already own: the Home tab skips the fetch (`app/(tabs)/index.tsx:248`) and renders a sign-up empty state instead (`:318`), and the product screen skips the `/api/ratings/me/:barcode` lookup for anonymous sessions (`app/(app)/product/[barcode].tsx:390-393`), so a returning anonymous user never sees their own score pre-filled.

**Why not local storage:** a local store would need a merge strategy on upgrade (local vs. server, duplicate detection, clock skew between the two). The id-preserving upgrade above makes all of that unnecessary. Persisting the *session* solves the same user-visible problem with a fraction of the surface area.

**Depends on:** **P8-001** (persist the Supabase session). Without it, nothing else in this ticket is durable — do not start here.

**Implementation:**
- Land P8-001 first.
- Remove the anonymous gate in `fetchRatings` (`app/(tabs)/index.tsx:248`) and render the real ratings list for anonymous users. Keep a *softer* sign-up prompt above the list ("Create an account so these don't stay tied to this device") rather than replacing the list with it.
- Remove the `isAnonymous` short-circuit on the existing-rating lookup in the product screen so an anonymous user re-opening a product sees their previous score pre-filled and the button reads "Update rating".
- Leave every contribution gate exactly as it is. This ticket is about ratings only — `requireRegistered` still guards submissions, edits, verification votes, and label extraction.
- Update `docs/architecture/frontend.md` (the P4-001 note stating guest users see a prompt *instead of* ratings) once this ships.

**Edge case to handle:** if an anonymous user tries to upgrade to an email that already has an account, `updateUser` fails and their anonymous ratings stay on the anonymous id. Surface a clear error ("That email is already registered — sign in instead"). Merging two existing accounts is explicitly out of scope.

**Acceptance Criteria:**
- [ ] An anonymous user can submit a rating and, after force-quitting and relaunching, still sees it (requires P8-001).
- [ ] An anonymous user's Home tab lists their own ratings instead of the sign-in empty state.
- [ ] A sign-up prompt still appears for anonymous users, alongside the list rather than in place of it.
- [ ] Re-opening a previously rated product as an anonymous user pre-fills the existing score and the submit button reads as an update.
- [ ] Upgrading an anonymous account to email/password keeps every previously submitted rating attached, with no migration step and no duplicates.
- [ ] Upgrading to an email that already exists shows an actionable error and does not lose the anonymous ratings.
- [ ] Anonymous users still cannot submit products, propose edits, or cast verification votes — all contribution gates unchanged.

### [TICKET-P8-004] Offline Rating Submission (Outbox)
**Goal:** Let a user rate a product with no connectivity and have it sync later.
**Depends on:** P8-002.
**Why ratings are safe to queue — and nothing else is:** a rating is solely owned by one user and `POST /api/ratings` upserts on `(userId, productId)` (`ratingController.ts:57`), so replay is idempotent and last-write-wins is *correct* — the local value is the user's latest intent. There is no genuine conflict to resolve. This does **not** hold for product submissions, edits, or peer votes: those depend on server state invisible offline (image plausibility checks, the one-pending-edit `409`, the self-vote `403`). Scope the outbox to ratings only; contribution flows stay online-only.
**Implementation:** `lib/offline/outbox.ts` — a persisted queue of `{ barcode, taste, comment, queuedAt }`, flushed on foreground or reconnect.
**Acceptance Criteria:**
- [ ] Submitting a rating offline shows immediate success and the value persists locally.
- [ ] Queued ratings flush automatically on reconnect or next foreground.
- [ ] The queue survives an app restart.
- [ ] Replay is safe: re-sending a rating for an already-rated product updates rather than duplicates.
- [ ] Multiple offline edits to the same product collapse to a single queued write (latest wins).
- [ ] A queued rating is visibly marked "not yet synced"; the marker clears on success.
- [ ] A permanent failure (4xx that is not auth) drops the item with a user-visible message; transient failures retry with back-off.
- [ ] Product submissions, edits, and peer votes are **not** queued — they show an offline message and remain online-only.

**Open choices (decide before starting P8-002):**
- **Connectivity detection.** `@react-native-community/netinfo` gives a reliable offline banner and prompt flush, at the cost of a native dependency. P8-002 can ship without it using `AppState` plus failure-driven retry. *Recommendation: start without it; add it only if the UX feels sloppy.*
- **Session storage adapter (P8-001).** AsyncStorage (documented + tested by Supabase) vs `expo-file-system` (no new native dependency). *Recommendation: AsyncStorage.*

# Future Plans and Ideas

## Suspicious-but-plausible submissions for nutrition info
Flagged (`plausibilityFlag: true`) but accepted. *(nutritional-value flagging not yet implemented)*

## If user added a product, go to home screen after rating and not back to scan screen
See title

## Tracing id and Idempotency
Help tracing the path of requests to different systems with tracing and span ids, detect duplicated requests with idempotency keys

## Data Classification
Well Architected Framework - Security / Data Protection: What data categories are used, what data is stored for how long, how must it be managed, how is it protected (at rest and in transit)

## Threat Modeling
Well Architected Framework - Security/ Application Security
in Pipeline and Security of the Pipeline (Static Code analysis SAST, Dynamic DAST, secrets scanning, and general security tests, dependency management)

## Release
- Create Terms and Conditions
- Create Data Protection Documentation
- GDPR info and endpoints (user info request, user deletion request)
- PlayStore Process
- iOS Appstore Process

## User Engagement
- Create User Role "Moderator" which (together with ADMIN) can review multiple products in a row and their vote (or that of an admin) finalizes review (so a single vote is enough to accept/decline)

## Non-ISBN Products
- Enable user to rate more general products without a explicit code (e.g. not food)

## Search by name
- Enable users to search for products by name instead of isbn code

## Pro Users can set own pictures
- Low Prio, enable users to replace picture with a better one (at least for themselfs)

## Introduction of cloud front
CloudFront OAC — make bucket fully private, serve processed/* via CloudFront

## Infrastructure cost optimization
- Prod runs on ECS Fargate + RDS (see `docs/architecture/cheap-prod-fargate.md`). RDS `db.t4g.micro`
  is free for the first 12 months on the AWS free tier, then ~$13/mo.
- **After the free-tier year**, revisit the database to handle cost: migrate from managed RDS to a
  containerized Postgres (Postgres container + EBS volume, or a Postgres sidecar task) to push the DB
  cost toward ~$0. Trade-off: you take over backups (nightly `pg_dump` to S3) and lose managed
  failover — acceptable for a small private app.
- Other levers if needed: drop to a smaller Fargate task, or evaluate Aurora Serverless v2
  auto-pause. Keep the EKS sandbox branch destroyed when not actively learning.