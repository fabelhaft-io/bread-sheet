#!/bin/sh
# Runs once on LocalStack startup (via /etc/localstack/init/ready.d/).
# Idempotent — re-runs update in place.
#
# Provisions the local image pipeline:
#   1. S3 bucket
#   2. image-resizer Lambda (from the bundle mounted at /opt/lambda/imageResizer,
#      built on the host with `npm run build` in server/lambda/imageResizer/)
#   3. S3 ObjectCreated:raw/* → Lambda trigger
#
# This mirrors terraform/ (the production path) so `docker compose up` alone
# yields a working pipeline without a local Terraform install.
set -e

BUCKET=breadsheet-images-local
LAMBDA_NAME=image-resizer
LAMBDA_BUNDLE=/opt/lambda/imageResizer
LAMBDA_RUNTIME=nodejs24.x  # keep in sync with terraform/lambda.tf
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# ── 1. Bucket ────────────────────────────────────────────────────────────────
if ! awslocal s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  awslocal s3 mb "s3://$BUCKET"
  echo "[init] Created S3 bucket: $BUCKET"
else
  echo "[init] S3 bucket $BUCKET already exists; skipping."
fi

# ── 2. Lambda ────────────────────────────────────────────────────────────────
if [ ! -f "$LAMBDA_BUNDLE/index.js" ]; then
  echo "[init] WARNING: $LAMBDA_BUNDLE/index.js not found — image-resizer Lambda NOT deployed."
  echo "[init]          Build it on the host first:  cd server/lambda/imageResizer && npm run build"
  echo "[init]          then restart LocalStack:     docker compose restart localstack"
  exit 0
fi

# Zip with python's zipfile so entries use forward slashes regardless of host OS.
ZIP=/tmp/imageResizer.zip
rm -f "$ZIP"
(cd "$LAMBDA_BUNDLE" && python3 -m zipfile -c "$ZIP" index.js node_modules)

if awslocal lambda get-function --function-name "$LAMBDA_NAME" >/dev/null 2>&1; then
  awslocal lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --zip-file "fileb://$ZIP" >/dev/null
  echo "[init] Updated Lambda code: $LAMBDA_NAME"
else
  # LocalStack does not enforce IAM — any well-formed role ARN is accepted.
  awslocal lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime "$LAMBDA_RUNTIME" \
    --handler index.handler \
    --timeout 30 \
    --memory-size 512 \
    --role arn:aws:iam::000000000000:role/image-resizer-lambda-role \
    --zip-file "fileb://$ZIP" >/dev/null
  echo "[init] Created Lambda: $LAMBDA_NAME ($LAMBDA_RUNTIME)"
fi

awslocal lambda wait function-active-v2 --function-name "$LAMBDA_NAME"

# ── 3. S3 → Lambda trigger (ObjectCreated on raw/) ──────────────────────────
LAMBDA_ARN="arn:aws:lambda:$REGION:000000000000:function:$LAMBDA_NAME"
awslocal s3api put-bucket-notification-configuration \
  --bucket "$BUCKET" \
  --notification-configuration "{
    \"LambdaFunctionConfigurations\": [{
      \"LambdaFunctionArn\": \"$LAMBDA_ARN\",
      \"Events\": [\"s3:ObjectCreated:*\"],
      \"Filter\": {\"Key\": {\"FilterRules\": [{\"Name\": \"prefix\", \"Value\": \"raw/\"}]}}
    }]
  }"
echo "[init] Wired S3 ObjectCreated (raw/*) -> $LAMBDA_NAME"
