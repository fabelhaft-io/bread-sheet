# Remote state — S3 backend with per-environment state keys.
#
# Configuration is partial: the concrete bucket/key/region come from a
# per-environment *.tfbackend file passed at init time, so one root serves
# all environments without committing environment-specific backend wiring here.
#
#   terraform init -backend-config=environments/dev.s3.tfbackend
#   terraform init -backend-config=environments/production.s3.tfbackend
#
# Locking uses the S3-native lock file (use_lockfile, Terraform >= 1.10) — no
# DynamoDB table required. The state bucket must be created once out-of-band
# (see docs/architecture/infrastructure.md § Remote state bootstrap).
#
# For the LocalStack ("local") environment the same backend targets the
# LocalStack S3 endpoint — see environments/local.s3.tfbackend.
terraform {
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}
