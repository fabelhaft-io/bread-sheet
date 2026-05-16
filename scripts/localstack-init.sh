#!/bin/sh
# Runs once on LocalStack startup (via /etc/localstack/init/ready.d/).
# Idempotent — re-runs are no-ops.
set -e

BUCKET=breadsheet-images-local

if ! awslocal s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  awslocal s3 mb "s3://$BUCKET"
  echo "[init] Created S3 bucket: $BUCKET"
else
  echo "[init] S3 bucket $BUCKET already exists; skipping."
fi