# Data Architecture

Covers what personal data is stored, why, how long it is kept, what leaves the system, user rights over their data and content, and GDPR obligations.

> **Status:** Living document. Sections marked `[TODO: Legal review]` require review by a qualified legal/DPO contact before going live in any market subject to GDPR or equivalent regulation.

---

## 1. Data Inventory

### 1.1 User Account Data

| Field | Model | PII? | Source | Retention |
|-------|-------|------|--------|-----------|
| Supabase user UUID | `User.id` | No (pseudonym) | Supabase Auth | Until account deletion |
| Email address | Managed by Supabase | Yes | User sign-up / upgrade | Until account deletion |
| Username | `User.username` | Yes (chosen by user) | User profile | Until account deletion |
| Avatar URL | `User.avatarUrl` | Yes (links to image) | User profile | Until account deletion |
| `is_anonymous` flag | Supabase JWT claim | No | Supabase Auth | Duration of session / until upgrade |
| Password hash | Managed by Supabase | Yes | User sign-up | Until account deletion; never stored in app DB |

Anonymous (guest) users have a Supabase UUID and session but no email or username. Their ratings and recently-opened history are linked to the UUID.

### 1.2 User-Generated Content

| Data | Model | PII? | Notes |
|------|-------|------|-------|
| Taste rating (0–10) | `Rating.taste` | Indirectly (linked to user) | |
| Rating comment | `Rating.comment` | Potentially | Free text; may contain personal info |
| Product photo | S3 `processed/product/` | No (product image, not selfie) | May be synced to Open Food Facts |
| Nutritional label photo | S3 `raw/label/` (temporary) | No | Used only for OCR; not permanently stored |
| Product submission fields | `Product.*` | No | Name, brand, nutritional data — not PII |
| `submittedByUserId` | `Product.submittedByUserId` | Pseudonymous | Links product to user UUID |
| Edit proposals | `ProductEdit.*` | No (content); pseudonymous (authorUserId) | |
| Edit votes | `ProductEditVote.*` | Pseudonymous | `userId` only; vote itself is not PII |
| Peer verification vote | `ProductVerification.vote` | Pseudonymous | `userId` links vote to user UUID; `vote` value (`APPROVE`/`REJECT`) is not PII |

### 1.3 Behavioural / Derived Data

| Data | Where | PII? | Notes |
|------|-------|------|-------|
| Recently viewed products | `RecentProductsProvider` context | No | In-memory only; not persisted to DB or server |
| Plausibility flag | `Product.plausibilityFlag` | No | Internal moderation signal |
| Verification count | Derived from `ProductVerification` | No | |

### 1.4 Infrastructure / Session Data

| Data | Where | Notes |
|------|-------|-------|
| Supabase JWT + refresh token | Supabase (managed) | Stored per Supabase's security practices |
| Server logs | Server process / EKS | May contain IP addresses and user UUIDs; `[TODO: Define retention period and log scrubbing policy]` |
| `pendingReturnTo` | `AsyncStorage` (device) | Temporary; cleared after use |

---

## 2. Third-Party Data Flows

### 2.1 Supabase Auth

**Data sent:** Email address, password (hashed client-side before transmission), Supabase user UUID, anonymous session tokens.

**Purpose:** User authentication, session management, JWT issuance.

**Supabase's role:** Data processor. Supabase stores auth data in a PostgreSQL instance. For the DEV project, this is Supabase's managed cloud (EU or US region depending on project configuration). For production, consider configuring the Supabase project in an EU region if serving EU users.

**`[TODO: Legal review]`** Confirm Supabase's DPA (Data Processing Agreement) is signed and the project region aligns with your data residency requirements.

### 2.2 Google Cloud Vision API

**Data sent:**
- `POST /products/extract-label` (image path only, fallback): a compressed JPEG of a nutritional label. No PII if the user photographed the label correctly, but the user could inadvertently include background content.

**Not sent to any external API:**
- `POST /products/extract-label` (text path, primary): raw OCR text is structured entirely by a local regex parser (`labelExtractionService.ts`) — no data leaves the server.

**Purpose:** Extracting raw text from a nutritional label image when on-device OCR yields insufficient text (image fallback path only).

**Authentication:** Application Default Credentials (ADC) via Workload Identity Federation in production — no service account JSON key is stored.

**Retention:** Google's Cloud Vision API does not retain request data for model training by default. **`[TODO: Legal review]`** Verify Google's current DPA status and confirm the Cloud Vision data-processing terms align with your data residency requirements.

**Mitigation:** The image path is only called as a fallback when on-device OCR yields insufficient text (`rawText` length < `MIN_OCR_LENGTH = 50`). This minimises the volume of image data sent externally.

### 2.3 Open Food Facts (OFF)

**Data sent (read operations):** Barcode only (in the URL of a GET request). No user data.

**Data sent (write operations — product contribution sync):**
- Product fields: name, brand, generic name, nutritional values, ingredients.
- Product display image (JPEG).
- Contributor identifier: submissions are made under the **BreadSheet bot account**, not the individual user's identity. The user's UUID or email is **not** sent to OFF.

**License implication:** Open Food Facts is released under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). Product data and images contributed to OFF become part of that open dataset. Users who submit products should be informed that their submission may be published to OFF and made publicly available under ODbL.

**`[TODO: Legal review]`** Confirm that the "submitted under bot account" approach is sufficient to satisfy attribution requirements, or whether contributor identity must be disclosed to OFF.

### 2.4 Amazon S3

**Data sent:** Compressed JPEG images uploaded by users (product display photos). Image keys are UUIDs — no PII in the key or metadata.

**Purpose:** Persistent storage of product images for display in the app and for contribution to OFF.

**Retention:** Images persist until the associated product is deleted. **`[TODO: Define]`** Whether product images are deleted when a user account is deleted (if the product has been verified and synced to OFF, deletion may not be possible).

### 2.5 AWS Lambda

**Data sent:** Raw image bytes from the S3 `raw/` prefix (triggered by S3 event). No PII.

**Purpose:** Asynchronous image resizing.

---

## 3. User Rights over Submitted Content (Images)

When a registered user uploads a product photo:

1. **Storage:** The image is stored in BreadSheet's S3 bucket.
2. **Display:** The image is displayed to all app users (including anonymous ones) as part of the product record.
3. **OFF contribution:** If the product is peer-verified, the image is uploaded to Open Food Facts under the BreadSheet bot account and becomes part of the ODbL-licensed open dataset.

**Key consequence:** Once an image is contributed to OFF and indexed by third parties, it cannot be fully retracted — OFF may propagate it to mirror databases. Users should be clearly informed of this **before** they submit a product photo (ideally via a one-time consent prompt on first submission).

**`[TODO: Legal review]`** Determine whether the app's Terms of Service grant sufficient licence to:
- Store and display user-uploaded images.
- Contribute those images to OFF under ODbL on the user's behalf.

---

## 4. Database Layout (Entity Relationships)

```
User ──────────────────────────────────────────────┐
 │                                                  │
 ├─── Rating (userId, productId, taste, comment)    │
 │                                                  │
 ├─── GroupMember (userId, groupId, role)           │
 │         │                                        │
 │       Group (id, name, inviteCode)               │
 │                                                  │
 ├─── ProductVerification (productId, userId, vote)  │
 │                                                  │
 ├─── ProductEdit (id, barcode, authorUserId,       │
 │        originalValues, proposedChanges, status)  │
 │         │                                        │
 │         ├─── ProductEditVote (editId, userId)    │
 │         └─── ProductEditDismissal (editId, userId)
 │                                                  │
 └─── Product (barcode PK, name, brand,  ◄──────────┘
          imageUrl, status,               (submittedByUserId)
          submittedByUserId?,
          offSyncStatus, offSyncAttempts,
          offRetryAt?, offProductUrl?)
```

Full schema with types and constraints: `server/prisma/schema.prisma`.

---

## 5. GDPR Obligations

**`[TODO: Legal review]`** — This section outlines the expected obligations; legal confirmation is required before launch in EU/EEA markets.

### 5.1 Legal Basis for Processing (Article 6)

| Data category | Legal basis | Notes |
|--------------|-------------|-------|
| Account data (email, username) | Contract (Art. 6(1)(b)) | Necessary to provide the service |
| Ratings and comments | Contract | Core app functionality |
| Anonymous session data | Legitimate interest (Art. 6(1)(f)) | Allows immediate app use without registration |
| Product submissions | Legitimate interest | Contributing to an open food database |
| OFF contribution | Legitimate interest | Improving public food data; user informed at submission |
| Label image sent to Google Cloud Vision | Legitimate interest | Fallback path only when on-device OCR yields insufficient text; no PII |

### 5.2 User Rights

| Right | Status | How to exercise |
|-------|--------|----------------|
| Right of access (Art. 15) | `[TODO]` | `GET /users/me` provides partial data; full export endpoint needed |
| Right to rectification (Art. 16) | Partial | Users can edit profile and ratings |
| Right to erasure (Art. 17) | `[TODO]` | Account deletion endpoint not yet implemented (in Future Plans) |
| Right to data portability (Art. 20) | `[TODO]` | Export endpoint needed |
| Right to object (Art. 21) | `[TODO]` | Applicable for legitimate-interest processing |

### 5.3 Data Retention

**`[TODO: Define]`** Specific retention periods for each data category. Suggested starting points:

| Data | Suggested retention |
|------|-------------------|
| Active user account | Until deletion request |
| Ratings | Until deletion request or account erasure |
| Product submissions | Indefinite (public contribution; see image note in §3) |
| Server logs | 30–90 days with automatic purge |
| `raw/` S3 images (label photos) | 24 hours after Lambda processing; delete automatically |

### 5.4 Data Minimisation

- Label photos sent to the Claude vision API should be the minimum crop needed (just the nutritional panel).
- The on-device OCR path (P5-002) means label images often never leave the device at all — this is the preferred path and should be documented as a privacy feature.
- `submittedByUserId` links a user UUID to a public product record. Consider whether this linkage needs to be disclosed in the privacy policy.

---

## 6. Outstanding Action Items

- [ ] Sign Supabase DPA; confirm EU data residency for production project.
- [ ] Confirm Google Cloud Vision API data-use policy; obtain DPA if required.
- [ ] Add one-time consent prompt before first product photo submission, informing users of OFF contribution and ODbL licensing.
- [ ] Implement `GET /users/me/export` (data portability).
- [ ] Implement `DELETE /users/me` (right to erasure).
- [ ] Define and implement log retention and scrubbing policy.
- [ ] Define S3 lifecycle rule: auto-delete `raw/label/` objects after 24 hours.
- [ ] Legal review of Terms of Service image licence clause.
- [ ] Legal review of legitimate-interest balancing tests for OFF contribution and Claude API calls.
