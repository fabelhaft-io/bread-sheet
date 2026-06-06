# P5-003 Manual Testing Playbook

Companion to [`P5-003-implementation-plan.md`](./P5-003-implementation-plan.md). Walk through these steps in order to verify the label-extraction, submission, and peer-verification work end-to-end.

---

## 1. Build the Lambda (one-time, before Terraform apply)

The image-resizer Lambda is a TypeScript package. Terraform reads the compiled bundle from `dist/bundle/`, so it must be built first.

```sh
cd server/lambda/imageResizer
npm install
npm run build
cd ../../..
```

The build script installs the Linux x64 variant of `sharp` regardless of host OS, producing a Lambda-compatible artifact.

---

## 2. Bring up local infrastructure

```sh
docker compose up -d        # Postgres on :5432, LocalStack on :4566
```

Sanity-check that LocalStack created the bucket:

```sh
aws --endpoint-url=http://localhost:4566 s3 ls s3://breadsheet-images-local
```

---

## 3. Provision Lambda + S3 notification into LocalStack

### Background — what Terraform is doing here

Terraform is our **single source of truth for AWS resources**. Every Lambda, S3 bucket, IAM role, and SQS queue this project uses is declared in `terraform/*.tf` — not clicked together in the AWS console. In production those files describe real AWS; in local dev, we point the same files at **LocalStack** (which speaks the AWS API on `localhost:4566`), so the exact same configuration provisions both environments. That's the whole point of LocalStack — we don't maintain a separate "local-only" setup script.

For step 3 specifically, the `terraform/` directory contains `lambda.tf`, which declares everything needed for the image-resize pipeline:

| Resource | What it does |
|---|---|
| `aws_iam_role.image_resizer` + two policies | Grants the Lambda permission to read/write the S3 bucket and send to the DLQ |
| `data.archive_file.image_resizer` | Zips up `server/lambda/imageResizer/dist/bundle/` (which is why we built the Lambda first in step 1) |
| `aws_lambda_function.image_resizer` | The actual Lambda — Node 24, 512 MB, 30 s timeout, handler `index.handler` |
| `aws_lambda_permission.allow_s3_invoke` | Allows S3 to invoke the Lambda |
| `aws_s3_bucket_notification.image_uploads` | The trigger: every `s3:ObjectCreated:*` event under the `raw/` prefix invokes the Lambda |
| `aws_sqs_queue.image_resizer_dlq` | Dead-letter queue — failed Lambda invocations land here for 14 days so we can inspect them |

Without this step, the Lambda doesn't exist in LocalStack and uploads to `raw/` are silently ignored — the API would return a `processed/` URL that never resolves.

### Commands

```sh
# First time only — downloads the AWS provider plugin into terraform/.terraform/
terraform -chdir=terraform init

# Shows a "plan" diff (what will be created / changed / destroyed) and asks
# you to type `yes` to apply it. On the very first run, expect ~7 resources
# to be created.
terraform -chdir=terraform apply
```

`terraform apply` is **idempotent** — re-running it when nothing changed produces "No changes". When you rebuild the Lambda bundle (`npm run build`), the `source_code_hash` changes, and the next `apply` will redeploy just the function code without touching IAM, the bucket, or the DLQ.

### Verifying it worked

```sh
# Lambda registered?
aws --endpoint-url=http://localhost:4566 lambda list-functions \
  --query 'Functions[].FunctionName'
# Expect: ["image-resizer"]

# Bucket notification wired up?
aws --endpoint-url=http://localhost:4566 s3api get-bucket-notification-configuration \
  --bucket breadsheet-images-local
# Expect: a LambdaFunctionConfigurations entry with prefix "raw/"

# DLQ exists?
aws --endpoint-url=http://localhost:4566 sqs list-queues
# Expect: a URL ending in /image-resizer-dlq
```

### If something goes wrong

```sh
# Re-read the current state from LocalStack (useful if you restarted Docker)
terraform -chdir=terraform refresh

# Nuke everything and re-apply from scratch (LocalStack only — never run this in prod)
terraform -chdir=terraform destroy
terraform -chdir=terraform apply
```

A full `docker compose down -v` wipes LocalStack's state volume, after which you'll need to delete `terraform/terraform.tfstate*` (Terraform thinks the resources still exist) and re-run `init` + `apply`.

> **Note:** LocalStack **Pro** is required for S3 → Lambda triggers. Confirm `LOCALSTACK_AUTH_TOKEN` is set in your shell or `.env`.

---

## 4. Start the server

```sh
cd server
npm install
npm run db:deploy           # applies migrations incl. plausibilityFlag (Task 6)
npm run dev
```

The server expects `server/.env`. Current values already have `VISION_MODE=live`.

- For LLM testing: switch to `VISION_MODE=llm` and add `GEMINI_API_KEY`.
- For pure offline testing: switch to `VISION_MODE=mock`.

---

## 5. Run the backend test suite first

```sh
cd server && npm test
```

This covers Task 5 (uploadImage, extract-label, product submission, verify-vote thresholds). Fix any red tests before continuing to manual testing.

---

## 6. Manual API testing via Postman

Import:
- `docs/postman/breadsheet.postman_collection.json`
- `docs/postman/breadsheet.postman_environment.json`

Run the Supabase sign-in request first to populate the Bearer token. Then walk through, in order:

### 6.1 — `POST /api/products/upload-image`
- ✅ Valid JPEG → 200; response URL contains `/processed/` and a UUID.
- ✅ PNG bytes → 200 (pipeline converts to JPEG).
- ✅ SVG bytes → 415 `unsupported_format`.
- ✅ >8 MB payload → 413 `image_too_large`.
- ✅ Missing `kind` field → 400.

### 6.2 — Verify Lambda fired
```sh
aws --endpoint-url=http://localhost:4566 s3 ls s3://breadsheet-images-local/processed/
```
The resized object should appear shortly after upload. Open the returned URL in a browser to confirm.

### 6.3 — `POST /api/products/extract-label`
- ✅ Text path: `{ rawText: "..." }` (>50 chars) → 200, `ExtractedLabel` shape.
- ✅ Too-short rawText → 400.
- ✅ Multipart image (mock mode) → 200.
- ✅ Anonymous user → 403.

### 6.4 — `POST /api/products`
- ✅ Full valid payload → 201, `status: PENDING_REVIEW`.
- ✅ Invalid barcode → 422.
- ✅ Missing required field → 422.
- ✅ Same user re-submitting own pending product → 200 (update).
- ✅ Different user submitting same pending barcode → 409.

### 6.5 — `GET /api/products/:barcode`
- ✅ Registered user sees `unverified: true`, `submission` block populated.
- ✅ Anonymous user → 404 for `PENDING_REVIEW` products.

### 6.6 — `POST /api/products/:barcode/verify` (approve)
- ✅ Submitter voting → 403.
- ✅ Two non-submitter approvals → product flips to `VERIFIED`.

### 6.7 — `DELETE /api/products/:barcode/verify` and rejection threshold
- ✅ Two non-submitter rejections → product flips to `REJECTED` (use a fresh barcode).

---

## 7. Frontend smoke test (optional but recommended)

```sh
cd bread-sheet-app
npm install
npm run ios     # or: npm run android / npm run web
```

Walk the Add Product flow end-to-end against the local server: barcode → image upload → label extraction → submit → re-open product detail to see `PENDING_REVIEW` state.

---

## Quick Reference — useful inspection commands

```sh
# List raw uploads
aws --endpoint-url=http://localhost:4566 s3 ls s3://breadsheet-images-local/raw/product/
aws --endpoint-url=http://localhost:4566 s3 ls s3://breadsheet-images-local/raw/label/

# List processed (Lambda output)
aws --endpoint-url=http://localhost:4566 s3 ls s3://breadsheet-images-local/processed/

# Inspect DB
cd server && npx prisma studio

# Tail Lambda logs
aws --endpoint-url=http://localhost:4566 logs tail /aws/lambda/breadsheet-image-resizer --follow
```
