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
- The sign-up screen must immediately persist `returnTo` to `AsyncStorage` under the key `pendingReturnTo` before initiating any auth call. This is necessary because email verification fires a magic link that relaunches the app as a cold deep link, destroying any in-memory navigation state.
- When the magic link returns the user to the app and `supabase.auth.onAuthStateChange` fires with a `SIGNED_IN` event, the auth completion logic in `app/_layout.tsx` reads `pendingReturnTo` from `AsyncStorage`, clears it, and navigates there instead of the default `/(tabs)` redirect — landing the user back on the product-not-found screen, now authenticated, where the "Add this product" button is visible.
- If signup is abandoned or fails, `pendingReturnTo` is cleared from `AsyncStorage` and normal post-auth routing applies.
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
- Product display photo uploads go to S3 via pre-signed URL (reuse `imageService.ts` pattern). The label photo is only uploaded as a fallback if on-device OCR fails — not stored permanently.
- The OCR sufficiency threshold is `MIN_OCR_LENGTH = 50` characters, defined as a shared constant. The same value must be used on both client (to decide whether to send text or image) and referenced in the backend docs.
**Submission payload (`POST /products` request body):**
```json
{
  "barcode": "string (required)",
  "name": "string (required)",
  "brand": "string | null",
  "genericName": "string | null",
  "energyKcal": "number | null",
  "carbohydrates": "number | null",
  "fat": "number | null",
  "protein": "number | null",
  "salt": "number | null",
  "servingSize": "string | null",
  "productImageUrl": "string (S3 URL, required)",
  "ingredients": "string | null"
}
```
**Image processing (client-side, before any upload):**
- Use `expo-image-manipulator` to resize and compress every image before it leaves the device:
  - *Product display photo*: resize to max 1200 px on the longest side, compress to JPEG at 85% quality.
  - *Label photo (OCR fallback)*: resize to max 1600 px on the longest side (higher res aids OCR accuracy), compress to JPEG at 90% quality.
- Run manipulation after capture/selection, before showing the preview — the preview should already display the processed version.
- If the processed file still exceeds **5 MB**, show an inline error ("Photo is too large — please try again in better lighting or closer to the subject") and block the upload.
**Acceptance Criteria:**
- [x] User can photograph the product and the nutritional label from within the screen. *(client skeleton — uses `expo-image-picker` with camera + library fallback)*
- [x] On-device OCR runs locally after the label photo is captured (no network request at this stage). *(client skeleton — `features/products/ocr.ts` gracefully degrades when the native module isn't installed)*
- [x] If OCR text is sufficient, only the raw text (not the image) is sent to the backend.
- [x] If OCR text is insufficient, the label image is sent as a fallback for backend vision inference.
- [x] All images are resized and compressed client-side before upload using `expo-image-manipulator`.
- [x] Images exceeding 5 MB after compression show an inline error and are not uploaded.
- [x] All three fill modes work correctly (manual, pre-fill+edit, accept-all).
- [x] Required-field validation prevents submission of incomplete data.
- [ ] Product display photo uploads to S3; URL is included in the submission payload. *(client sends to `POST /api/products/upload-image`; backend endpoint pending P5-003)*
- [ ] On successful submission, the user is navigated to the product screen showing the PENDING_REVIEW state and a confirmation toast. *(client navigates; backend `POST /api/products` shipped via P5-003/T3 — full end-to-end still depends on P5-003/T4 image upload)*
- [x] A `422` response displays the AI rejection reason inline on the form; the user can correct the data and resubmit. *(client handles 422 — server-side plausibility checks pending P5-003)*
- [x] Registered users who scan a `PENDING_REVIEW` product see a reviewer banner and can cast an approval or rejection. *(banner + `app/(app)/review-product/[barcode].tsx` shipped; `unverified` + `submittedByUserId` in GET response shipped in P5-003/T8)*
- [x] The submitter of a product does not see the reviewer banner for their own submission.

**Implementation status (client skeleton, 2026-04-17):**
- Client-side multi-step flow and reviewer screen are shipped in `bread-sheet-app/app/(app)/add-product.tsx` and `app/(app)/review-product/[barcode].tsx`.
- Business logic lives in `features/products/` (`api.ts`, `extract.ts`, `ocr.ts`, `image-picker.ts`, `image-processing.ts`, `constants.ts`, `types.ts`) — screens stay UI-only per the `features/` convention.
- `MIN_OCR_LENGTH = 50` is exported from `features/products/constants.ts`; the backend (P5-003) must reference the same value.
- Native modules (`@react-native-ml-kit/text-recognition`, `expo-image-picker`, `expo-image-manipulator`) are consumed via guarded `require()` so jest-expo tests pass without them. The user must install them and rebuild the native client before the full flow works end-to-end.
- `POST /api/products` — shipped (P5-003/T3). `POST /api/products/upload-image` — shipped (P5-003/T4). `POST /api/products/extract-label` text path — shipped (P5-003/T5). Image path returns `501` (pending T6). `POST/DELETE /api/products/:barcode/verify` — shipped (P5-003/T7). `GET /api/products/:barcode` `unverified`/`submittedByUserId`/`submission` augmentation — shipped (P5-003/T8).

### [TICKET-P5-003] Backend: Label Extraction, Submission, & Peer Verification
**Goal:** Provide three backend capabilities: (1) structure nutritional data from on-device OCR text (primary) or a label image (fallback); (2) validate and normalise incoming images server-side; (3) accept product submissions from registered users and gate promotion to `VERIFIED` behind peer review by a second registered user.
**Endpoints:**
- `POST /products/extract-label` — accepts either `{ rawText: string }` (primary path, from on-device OCR) or a multipart label image (fallback path, when OCR was insufficient). Uses Claude text API for the text path; falls back to Claude vision API when an image is provided. Returns best-effort partial results on low-confidence extractions; never blocks the user flow. Response shape:
  ```json
  {
    "name": "string | null",
    "brand": "string | null",
    "genericName": "string | null",
    "energyKcal": "number | null",
    "carbohydrates": "number | null",
    "fat": "number | null",
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
- `DELETE /products/:barcode/verify` — no request body. Allows a verifier to retract their own verification before the threshold is reached (e.g. they spotted an error after the fact).
**Visibility rules for `PENDING_REVIEW` products:**
- Visible immediately to the submitter in their own history.
- Visible to all other registered users in scan/search results, but flagged with an `unverified: true` field in the response so the client can render a "Needs review" badge and a "Looks correct" action.
- Hidden from anonymous users — `GET /products/:barcode` returns `404` when the only match is `PENDING_REVIEW`.
**Image validation & normalisation (API-side, applies to all image uploads):**
- **Registration gate:** `POST /products` and `POST /products/extract-label` must be protected by a `requireRegistered` middleware that checks the Supabase JWT claim `is_anonymous !== true`. Anonymous tokens are rejected with `403 Forbidden` and a message directing the user to create an account. This is a defence-in-depth measure alongside the client-side gate.
- **Size gate (pre-processing):** Reject any multipart image field exceeding **8 MB** raw with `413 Payload Too Large` before touching the bytes. Configure via `multer` (or equivalent) `limits.fileSize`. This acts as a hard server-side ceiling even if the client-side 5 MB check is bypassed.
- **Format normalisation:** Inspect the actual file signature (magic bytes via `file-type` or `sharp` metadata), not just the `Content-Type` header. If the image is not already JPEG or WebP, convert it to JPEG in-process using `sharp` before uploading. Unsupported formats (SVG, PDF, etc.) are rejected with `415 Unsupported Media Type`. This conversion is intentionally kept in the API (not Lambda) so that format rejection happens synchronously and the client gets an immediate error.
- **Resize via Lambda (S3-triggered):** After validation and format normalisation, the API uploads the image to the `raw/` prefix in S3 (`raw/{uuid}.jpg`) and immediately returns the predicted processed URL (`processed/{uuid}.jpg`) to the client — it does not wait for resizing to complete. A Lambda function (defined in `terraform/`, triggered by S3 `ObjectCreated` events on the `raw/` prefix) handles the definitive resize:
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
- Add new model `ProductVerification`: `userId`, `barcode`, `createdAt` — composite unique key on `(userId, barcode)` to prevent duplicate votes.
**Acceptance Criteria:**
- [x] Anonymous users calling `POST /products` or `POST /products/extract-label` receive `403`. *(text path via T5; image path pending T6)*
- [ ] Images larger than 8 MB are rejected with `413` before any processing occurs.
- [ ] Images in unexpected formats are converted to JPEG via `sharp`; unsupported formats return `415`.
- [ ] Format detection uses magic bytes, not `Content-Type`.
- [ ] After upload, a Lambda automatically resizes images to the appropriate cap and writes to the `processed/` S3 prefix.
- [ ] The API returns the predicted `processed/` URL immediately without waiting for the Lambda.
- [x] `POST /products/extract-label` accepts raw OCR text and returns structured nutritional fields. *(T5: hand-rolled regex parser, English + German; Claude/Vision approach superseded — see implementation plan)*
- [ ] `POST /products/extract-label` also accepts a label image as a fallback and runs Google Cloud Vision inference. *(pending T6)*
- [x] The text path is used whenever `rawText` is provided; the image path is only invoked when no text is present. *(text path T5; image path returns 501 until T6)*
- [x] `POST /products` persists a user-submitted product with `status: PENDING_REVIEW`. *(P5-003/T3)*
- [ ] AI plausibility check runs synchronously before the response; clearly implausible submissions return a `422` with a human-readable reason. *(deferred — T3 ships schema validation only; AI plausibility for text and image (no dick-pics allowed) deferred to a follow-up ticket)*
- [ ] Suspicious-but-plausible submissions are flagged (`plausibilityFlag: true`) but accepted. *(deferred — see above)*
- [x] `POST /products/:barcode/verify` casts an `APPROVE` vote from a registered non-submitter; returns `403` if the caller is the submitter. *(P5-003/T7)*
- [ ] After 2 net-approvals the product is automatically promoted to `VERIFIED`; OFF sync is enqueued. *(threshold flip shipped in T7; OFF sync enqueue deferred to P5-004)*
- [x] `DELETE /products/:barcode/verify` casts a `REJECT` vote (non-submitter only); 2 net-rejections flip status to `REJECTED`. *(P5-003/T7 — overloaded REJECT channel, not a retraction)*
- [x] `PENDING_REVIEW` products return `unverified: true` (with `submittedByUserId` and a `submission` block) in the response and are hidden from anonymous users (`404`). *(P5-003/T8)*
- [x] A migration adds the `status` field with a default of `VERIFIED` for existing Open Food Facts-sourced products. *(P5-003/T1)*

### [TICKET-P5-004] Anonymous users
**Goal:** Anonymous users can rate products, too. These ratings are stored locally. If they register, these ratings are moved to his user profile. Minor Frontend fix: Rating screen should be one full screen with no scroll column (currently on iOS it is slightly too high)

### [TICKET-P5-006] Product Editing & Peer-Review of Changes
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
- Edits that receive no votes within **30 days** are automatically expired (`status: EXPIRED`) by a scheduled cleanup job.
**OFF sync for edits:**
- Reuses the P5-004 sync infrastructure. On `APPLIED`, enqueue an OFF update for the changed fields only (partial update via the OFF product write API). Image fields are re-uploaded to OFF if they changed.
- Sync is idempotent — uses the barcode as the OFF product key, so repeated syncs update rather than duplicate.
**Schema additions:**
- Add to `Product`: `lastModifiedByUserId: String?` — references the user whose edit was most recently APPLIED. Set by the edit-resolution job at the moment a `ProductEdit` flips to APPLIED. Stays `null` until the first applied edit. `submittedByUserId` is intentionally left untouched on edit so the original-author attribution is preserved permanently.
- New model `ProductEdit`: `id`, `barcode` (FK → Product), `authorUserId`, `originalValues` (JSON — snapshot of the product fields at submission time), `proposedChanges` (JSON — field name → new value), `status` (`PENDING | APPLIED | REJECTED | EXPIRED`), `createdAt`, `expiresAt`. Capturing `originalValues` at submission time ensures the diff screen always shows the correct baseline even if the product record changes later.
- New model `ProductEditVote`: `id`, `editId` (FK → ProductEdit), `userId`, `vote` (`APPROVE | REJECT`), `createdAt`. Composite unique key on `(editId, userId)`.
- New model `ProductEditDismissal`: `id`, `editId` (FK → ProductEdit), `userId`, `createdAt`. Composite unique key on `(editId, userId)`. Used to persist dismissals server-side across devices.
- **DB-level "one pending edit per barcode" constraint.** Add a partial unique index in the migration: `CREATE UNIQUE INDEX one_pending_edit_per_product ON "ProductEdit" ("barcode") WHERE "status" = 'PENDING';`. This is the source of truth — the API's 409 response is a friendly mirror, but the database refuses the second insert even if two requests race. Prisma can declare this via `@@unique` does not support partial conditions directly, so use a raw migration step (`prisma migrate dev` will accept hand-written SQL inside the migration file).
**Acceptance Criteria:**
- [ ] Registered users see an "Edit product" button on the Product Detail screen; anonymous users do not.
- [ ] For `PENDING_REVIEW` products, the button label is "Correct this submission" and submitting calls `PATCH /products/:barcode` (reset path).
- [ ] For `VERIFIED` products with a `PENDING` edit, the button is hidden and a notice is shown.
- [ ] The edit form is pre-populated with current product values; the barcode field is read-only.
- [ ] Submitting unchanged data is blocked client-side (submit button disabled).
- [ ] `PATCH /products/:barcode` on a `PENDING_REVIEW` product updates the data in-place, clears existing verifications, reassigns `submittedByUserId`, and notifies the original submitter if they differ from the editor.
- [ ] `POST /products/:barcode/edits` returns `403` for anonymous users and `409` if a pending edit already exists or the product is `PENDING_REVIEW`.
- [ ] A registered non-author user sees the review banner on a product with a pending edit.
- [ ] The diff screen clearly shows old vs. new values for every changed field.
- [ ] "Looks correct" and "Something's wrong" record votes; "Dismiss" records a server-side dismissal and hides the banner across all devices for that user.
- [ ] A user cannot vote on their own edit (`403`).
- [ ] A user cannot vote twice on the same edit (duplicate vote returns `409`).
- [ ] 2 approvals apply the edit, notify the author, and enqueue an OFF sync.
- [ ] 2 rejections discard the edit and notify the author.
- [ ] Mixed votes (1–1) wait for a third voter rather than resolving early.
- [ ] Pending edits with no votes after 30 days are expired by a cleanup job.
- [ ] Verified edits are synced to OFF as updates to the existing product entry.
- [ ] The original submitter of a VERIFIED product must use the same proposal flow as any other user — no bypass path exists.
- [ ] When an edit is APPLIED, the existing `Rating` rows on the product remain attached and unchanged.
- [ ] When an edit is APPLIED, `Product.lastModifiedByUserId` is set to the edit's `authorUserId`; `Product.submittedByUserId` is unchanged.
- [ ] Attempting to create a second `PENDING` `ProductEdit` for the same barcode fails at the database level (partial unique index violation), not only at the API layer.

## Phase 6: Social

### [TICKET-P6-001]  Add Product Categories
Allow easy selection to see own votes in categories (e.g. what wine I liked, what cigars, what cocktails)

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

### [TICKET-P6-003] Open Food Facts Contribution Sync
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
    3. Re-upload image to OFF only if `productImageUrl` is in `proposedChanges`.
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
- [ ] Ownership guards are implemented as composable middleware, not adD-hoc per-controller checks.
- [ ] All new authorization rules are covered by integration tests.

# Future Plans and Ideas

## Ensure offline usability
Snappy startup - cached user votes and products on device (in supermarkets the mobile connection is often poor)

## Release
- Create Terms and Conditions
- Create Data Protection Documentation
- GDPR info and endpoints (user info request, user deletion request)
- PlayStore Process
- iOS Appstore Process

## User Engagement
- Create User Role "Moderator" which can review multiple products in a row

## Non-ISBN Products
- Enable user to rate more general products without a explicit code (e.g. not food)

## Search by name
- Enable users to search for products by name instead of isbn code

## Pro Users can set own pictures
- Low Prio, enable users to replace picture with a better one (at least for themselfs)