# Infrastructure & Deployment

Covers local development setup, cloud infrastructure (Terraform / AWS), and the GitOps deployment pipeline (EKS + ArgoCD).

---

## Local Development

Docker Compose orchestrates the local environment to mirror production as closely as possible.

```sh
# Start DB + LocalStack (default profile)
docker compose up -d

# Start DB + LocalStack + server (app-dev profile)
docker compose --profile app-dev up -d
```

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL 18-Alpine | 5432 | Primary database (`admin:password@localhost:5432/breadsheet`) |
| LocalStack | 4566 | AWS service emulation (S3, Lambda, IAM, STS, SQS) |
| Server (app-dev profile) | 3000 | API server with hot-reload via nodemon |

LocalStack allows developers to test S3 uploads and Lambda triggers without an AWS account or cost.

The server reaches LocalStack at `AWS_ENDPOINT_URL=http://localstack:4566` and must run with `S3_MODE=localstack` (set in `docker-compose.yml`): LocalStack requires path-style S3 addressing because virtual-hosted-style hostnames like `breadsheet-images-local.localstack` don't resolve inside the Docker network. Production uses `S3_MODE=aws` (SDK-default virtual-hosted addressing).

Image URLs returned to clients are assembled from `ASSET_BASE_URL` (in `server/.env`), which must point at a **device-reachable** address — locally that is `http://<host-LAN-ip>:4566/breadsheet-images-local` (LocalStack's port 4566 is published on the host). See `docs/architecture/backend.md` § Image Processing.

**Local image pipeline (LocalStack init hook):**
`scripts/localstack-init.sh` runs on LocalStack startup (`/etc/localstack/init/ready.d/`) and provisions the full local pipeline — the S3 bucket, the `image-resizer` Lambda, and the `s3:ObjectCreated:*` (prefix `raw/`) trigger — mirroring `terraform/` without requiring a local Terraform install. The Lambda bundle is mounted into the container from `server/lambda/imageResizer/dist/bundle/`, so it must be built first:

```sh
cd server/lambda/imageResizer
npm install
npm run build   # outputs dist/bundle/ (JS + sharp Linux x64 binary)
cd ../..
docker compose up -d   # init hook deploys the Lambda; re-run after rebuilds via
                       # docker compose restart localstack
```

If the bundle is missing the init script logs a warning and skips the Lambda — uploads still work, but `processed/` objects are never written.

**Lambda build for `terraform apply`:**
Terraform's `archive_file` data source reads the same compiled output from `dist/bundle/`, so the build step above is also required before applying:

```sh
terraform -chdir=terraform apply -var-file=environments/production.tfvars
```

The build script installs the Linux x64 variant of sharp into `dist/bundle/node_modules/` regardless of the host OS, producing a Lambda-compatible artifact. Keep the Lambda runtime in `scripts/localstack-init.sh` in sync with `terraform/lambda.tf` (currently `nodejs24.x`).

---

## Cloud Infrastructure (Terraform)

`terraform/` is the single source of truth for all AWS resources. Environment-specific
variables are in `terraform/environments/`. There are three environments — `local`
(LocalStack), `dev`, and `production` — selected by the `-var-file` you pass.

**Cloud resources are gated.** The VPC, EKS, RDS, and IRSA resources (plus GCP Workload Identity
Federation) are created only when `localstack_endpoint == ""` (real AWS). The `local` environment
keeps `localstack_endpoint` set, so it provisions **only** the S3 bucket + image-resizer Lambda —
the rest evaluate to `count = 0`. The gate is `local.cloud_count` in `locals.tf` (GCP WIF adds a
second toggle, `var.enable_google_wif`, via `local.gcp_count`).

**Container image.** The server image is **not** in ECR — it's published to the free
**GitHub Container Registry** (`ghcr.io/fabelhaft-io/bread-sheet-server`, public package) by
`.github/workflows/build-image.yml` on push to `main`. EKS pulls the public package with no
imagePullSecret.

**Keyless Google Cloud (Vision/Vertex).** `gcp-wif.tf` provisions a Workload Identity Pool +
OIDC provider trusting the EKS cluster OIDC issuer, a GCP service account with
`roles/cloudvision.user` + `roles/aiplatform.user`, and a `workloadIdentityUser` binding for the
`default:bread-sheet-server` ServiceAccount. The pod projects its SA token and exchanges it for
short-lived GCP credentials — no key file. Requires `gcp_project` (and uses the `hashicorp/google`
provider). See § Live Google Cloud below.

### Remote state (S3 backend)

State lives in an S3 backend with one key per environment (`<env>/terraform.tfstate`). The
backend is configured partially in `backend.tf`; concrete bucket/key/region come from a
per-environment `*.tfbackend` file at init time. Locking uses the S3-native lock file
(`use_lockfile`, Terraform ≥ 1.10) — no DynamoDB table.

**One-time bootstrap** (the state bucket must exist before the first `init`):

```sh
aws s3 mb s3://breadsheet-tfstate --region us-east-1
aws s3api put-bucket-versioning --bucket breadsheet-tfstate \
  --versioning-configuration Status=Enabled
```

> The repo still contains a legacy committed `terraform/terraform.tfstate` (LocalStack state).
> Once the remote backend is adopted, remove it from version control
> (`git rm --cached terraform/terraform.tfstate*`) — `.gitignore` already excludes future
> state files.

### Apply

```sh
# Init selects the backend + downloads modules. Re-run when switching environments.
terraform -chdir=terraform init -backend-config=environments/dev.s3.tfbackend

# dev
terraform -chdir=terraform apply -var-file=environments/dev.tfvars

# production
terraform -chdir=terraform init -backend-config=environments/production.s3.tfbackend
terraform -chdir=terraform apply -var-file=environments/production.tfvars

# Local (LocalStack) — backend targets LocalStack's emulated S3
terraform -chdir=terraform init -backend-config=environments/local.s3.tfbackend
terraform -chdir=terraform apply -var-file=environments/local.tfvars
```

To validate config without AWS credentials (no apply): `init -backend=false` then `validate`.

### Resources provisioned

| Resource | Service | Purpose |
|----------|---------|---------|
| VPC, subnets, security groups | AWS Networking | Isolated network for EKS and RDS |
| EKS Cluster + managed node groups | Amazon EKS | Kubernetes cluster for the API server |
| PostgreSQL instance | Amazon RDS | Managed production database |
| Object storage | Amazon S3 | Product images (`raw/` and `processed/` prefixes) |
| Image resize function | AWS Lambda | S3-triggered; resizes uploaded images asynchronously |
| Dead-letter queue | Amazon SQS | Captures Lambda failures for ops alerting |
| WIF pool + provider + service account | Google Cloud (via `hashicorp/google`) | Keyless Vision/Vertex auth for the server pod |

The **container registry is external**: the server image lives in GitHub Container Registry
(`ghcr.io/fabelhaft-io/bread-sheet-server`), not AWS — see § Container image above.

### S3 bucket layout

```
s3://breadsheet-assets/
├── raw/
│   ├── product/{uuid}.jpg    # Uploaded by API; triggers resize Lambda
│   └── label/{uuid}.jpg      # OCR fallback images; triggers resize Lambda
└── processed/
    ├── product/{uuid}.jpg    # Final product display images (max 1200 px)
    └── label/{uuid}.jpg      # Final label images (max 1600 px)
```

The prefix (`raw/product/` vs `raw/label/`) tells the Lambda which dimension cap to apply.

---

## Deployment Pipeline (GitOps with EKS + ArgoCD)

### Overview

A "pull-based" GitOps model: ArgoCD watches the manifest repository and applies any diff to the cluster automatically. No direct `kubectl apply` in production.

### CI Pipeline (GitHub Actions — triggered on push to `main`)

1. **Test** — run full test suites (`npm test` in `server/` and `bread-sheet-app/`) — `.github/workflows/test.yml`.
2. **Build & push image** — `.github/workflows/build-image.yml` builds `server/Dockerfile` and pushes `ghcr.io/<owner>/bread-sheet-server` tagged with both `:$GIT_SHA` and `:latest`, authenticating with the built-in `GITHUB_TOKEN` (no registry secret to manage).
3. **Update manifest** — update the `image` tag in `deployment.yaml` to the new SHA (commit/push for ArgoCD to pick up).

### ArgoCD (Continuous Deployment)

1. Detects the manifest change pushed by CI.
2. Applies it to the EKS cluster.
3. Kubernetes performs a rolling update: new pods with the new image start before old pods terminate.

### Kubernetes Manifests (`terraform/k8s/`)

YAML files declaring the desired cluster state. ArgoCD treats these as the authoritative source
(`argocd-application.yaml` points at this path).

| File | Purpose |
|------|---------|
| `deployment.yaml` | Server Deployment. An `initContainer` runs `npm run db:deploy` (Prisma migrate) before the server starts; probes hit `GET /`. Image is `ghcr.io/fabelhaft-io/bread-sheet-server:<tag>`. Mounts the projected SA token + WIF cred config for keyless Google Cloud. |
| `service.yaml` | `LoadBalancer` Service exposing the API on port 80 → container 3000. `loadBalancerSourceRanges` restricts the ELB to your IP (firewall). |
| `configmap.yaml` | Non-secret env (matches `server/src/configs/config.ts`): `S3_MODE=aws`, `S3_BUCKET_NAME`, `ASSET_BASE_URL`, `VISION_MODE=live`, `PLAUSIBILITY_MODE=gemini`, `GOOGLE_*` (WIF), `ALLOWED_ORIGINS`. |
| `secret.yaml` | **Template only** — `DATABASE_URL`, `SUPABASE_*` (no `GEMINI_API_KEY`; Google auth is keyless). Create the real Secret out-of-band (below); never commit values. |
| `serviceaccount.yaml` | `bread-sheet-server` SA, annotated with the IRSA role ARN (S3 access without static keys). |
| `gcp-wif-credconfig.yaml` | Non-secret WIF credential config ConfigMap — generated once from terraform outputs (below). |

**Deploy to dev (after `terraform apply`):**

```sh
aws eks update-kubeconfig --name "$(terraform -chdir=terraform output -raw cluster_name)"

# 1. App secret — DB (RDS-managed password from Secrets Manager) + Supabase.
kubectl create secret generic bread-sheet-server-secrets -n default \
  --from-literal=DATABASE_URL='postgresql://breadsheet:<pw>@<rds-endpoint>:5432/breadsheet' \
  --from-literal=SUPABASE_URL='https://<project>.supabase.co' \
  --from-literal=SUPABASE_PUBLISHABLE_DEFAULT_KEY='<key>'

# 2. WIF credential config (keyless Google Cloud) — see gcp-wif-credconfig.yaml header.
gcloud iam workload-identity-pools create-cred-config \
  "$(terraform -chdir=terraform output -raw gcp_wif_provider)" \
  --service-account="$(terraform -chdir=terraform output -raw gcp_service_account_email)" \
  --credential-source-file=/var/run/secrets/gcp/token --credential-source-type=text \
  --output-file=credential-configuration.json
kubectl create configmap gcp-wif-cred-config -n default --from-file=credential-configuration.json
# Copy the JSON's `audience` into deployment.yaml's serviceAccountToken.audience,
# fill GOOGLE_CLOUD_PROJECT in configmap.yaml, the IRSA ARN in serviceaccount.yaml,
# and your IP in service.yaml loadBalancerSourceRanges.

# 3. Apply the rest.
kubectl apply -f terraform/k8s/
```

The RDS master password is managed by AWS in Secrets Manager (`terraform output rds_master_secret_arn`) — read it from there rather than setting one manually.

---

## Database Migrations

Migrations must complete before any application pods start serving traffic.

**Option A — Kubernetes Job (preferred):**
The CI pipeline triggers a K8s Job that runs `npx prisma migrate deploy` and waits for completion before updating the `image` tag in the Deployment manifest. ArgoCD applies the Job first; the Deployment update follows.

**Option B — initContainer:**
An `initContainer` in the Deployment manifest runs the migration. Simpler, but risks concurrent migration attempts if multiple pods start simultaneously — only safe if Prisma's migration lock is reliable for your scale.

---

## Infrastructure as Code Principles

- All resources are defined in `terraform/` — no manual console changes.
- Lambda source and configuration live in `terraform/` alongside other infra.
- Secrets (DB password, Supabase keys, OFF credentials, Anthropic API key) are injected via environment variables managed by AWS Secrets Manager or Kubernetes Secrets — never committed to the repository.
