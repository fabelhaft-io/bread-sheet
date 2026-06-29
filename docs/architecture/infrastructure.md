# Infrastructure & Deployment

Covers local development setup, the cloud infrastructure (AWS — ECS Fargate), and the push-based CD
pipeline. The dev cloud environment is currently a **hand-built Fargate stack** being imported into
Terraform — the step-by-step build, verification, and import map live in
[`fargate-handbuild.md`](fargate-handbuild.md); the design + cost rationale in
[`cheap-prod-fargate.md`](cheap-prod-fargate.md).

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

## Cloud Infrastructure (AWS — ECS Fargate)

> **Status.** The dev cloud environment runs on a **hand-built ECS Fargate stack** — full build,
> verification, and the **Terraform import map** are in [`fargate-handbuild.md`](fargate-handbuild.md).
> Importing it into Terraform is the last open step of that runbook (Objective 14). The **legacy EKS
> Terraform** (`eks.tf`, `irsa.tf`, the OIDC provider in `gcp-wif.tf`, `terraform/k8s/`) still exists
> in the repo but is **superseded** — kept only as a spin-up/destroy learning sandbox (~$170/mo idle
> vs ~$15–30/mo for Fargate). `terraform/` will become the source of truth once the import lands.

### Architecture (dev)

Public hostname **`https://server.dev.bread-sheet.com`** → ALB → Fargate task → RDS. The security-group
chain enforces `internet → ALB → task(:3000) → RDS(:5432)`, each internal hop referencing the previous
group's SG id (no CIDRs).

| Component | Resource | Notes |
|---|---|---|
| Network | VPC `10.0.0.0/16`, 2 public + 2 private subnets, **no NAT** | Task runs in the **public** subnets with a public IP (pulls the GHCR image and reaches Supabase / GCP / SSM via the IGW); RDS is private-only. ~$33/mo saved vs NAT. |
| Ingress | Application Load Balancer + ACM cert + Route 53 alias | HTTPS `:443` (cert for `server.dev.bread-sheet.com`) → IP target group (`:3000`, health `GET /`); HTTP `:80` → 301. |
| Compute | ECS **Fargate** service `breadsheet-dev-server-service` on cluster `breadsheet-server-dev` | Desired 1, `256`/`512`, **X86_64** (image is `linux/amd64`), `assignPublicIp=ENABLED`, rolling deploy + circuit-breaker rollback, 120 s health-check grace (migrations run before serving). |
| Database | RDS PostgreSQL `db.t4g.micro`, single-AZ, private, encrypted | Reachable only from the task SG on `5432`. SSM-stored password now; keyless RDS IAM auth deferred (ADR 0002). |
| Images | S3 bucket `breadsheet-dev-s3-…` | `raw/*` private (task `s3:PutObject` only), `processed/*` scoped public-read; resize Lambda deferred (reuse `lambda.tf`). |
| Image registry | GHCR `ghcr.io/fabelhaft-io/bread-sheet-server` (public) | **Not ECR** — the execution role needs no pull secret. |
| Secrets | SSM Parameter Store `/breadsheet/dev/*` | `DATABASE_URL` (SecureString), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`; injected into the container via the task-def `secrets` block by the **execution** role. |
| Identity | IAM execution + task + deployer roles, GitHub OIDC provider | All keyless. Task role = the app's identity (S3 + the principal GCP WIF federates). Deployer assumed by CI via OIDC. |
| Keyless GCP | WIF pool `breadsheet-dev` + **AWS provider** + SA `breadsheet-dev-vision` | See § Keyless Google Cloud. |

**Container image.** Published to the free **GitHub Container Registry**
(`ghcr.io/fabelhaft-io/bread-sheet-server`, public) by `.github/workflows/build-image.yml` on push to
`main` — never ECR. The task definition pins the immutable `:<git-sha>` tag.

### Keyless Google Cloud (Vision/Vertex) — Fargate WIF

On Fargate the federation source is the **AWS task role** (the EKS OIDC provider in `gcp-wif.tf` is the
legacy path). The setup: a Workload Identity Pool with an **AWS provider** (`account_id`, plus an
attribute-condition scoping trust to the task role's assumed-role ARN), a GCP service account
`breadsheet-dev-vision` with `roles/aiplatform.user` (Cloud Vision needs **no** role — API-enablement
+ an authenticated SA suffices; `roles/cloudvision.user` does not exist), and a `workloadIdentityUser`
binding to the task-role principalSet. At runtime the app builds a google-auth `AwsClient` with a
**programmatic credential supplier** (`server/src/services/gcpWorkloadIdentity.ts`) that reads AWS
credentials from the **ECS container endpoint** — *not* EC2 IMDS, which doesn't serve task-role
credentials on Fargate — and exchanges them for a short-lived GCP token that impersonates the SA. No
key file is mounted. Env: `GCP_WORKLOAD_IDENTITY_AUDIENCE` + `GCP_SERVICE_ACCOUNT_EMAIL` (see
[`fargate-handbuild.md`](fargate-handbuild.md) Objective 12).

### Remote state (S3 backend)

> The `apply` commands below currently provision the **legacy EKS** stack. Once the hand-built
> Fargate resources are imported (Objective 14), the same backend + `apply` mechanics drive the
> Fargate stack and the EKS files are removed. Until then, the running dev environment is managed by
> hand per [`fargate-handbuild.md`](fargate-handbuild.md), not by `terraform apply`.

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

### Resources (Fargate target — to be imported)

The components in the § Architecture table above are the resources Terraform will own after the
Objective-14 import: VPC/subnets/SGs (no NAT), ALB + target group + ACM cert + Route 53 alias, the
ECS cluster + Fargate service + task definition, RDS, the S3 bucket, the three IAM roles + GitHub
OIDC provider, the SSM parameters, and the GCP WIF pool/AWS-provider/SA. The resize Lambda + SQS DLQ
are deferred (reuse `lambda.tf`).

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

## Deployment Pipeline (push-based CD to ECS)

ECS is **push-deployed** — CI calls the ECS API to roll the service. There is no ArgoCD pull loop
(that was the EKS model). Keyless throughout: GitHub Actions assumes an AWS IAM **deployer role** via
OIDC, no stored AWS keys.

### CI/CD (GitHub Actions)

1. **Test** — `npm test` in `server/` and `bread-sheet-app/` (`.github/workflows/test.yml`).
2. **Build & push** — the `build` job in `build-image.yml` builds `server/Dockerfile` and pushes
   `ghcr.io/<owner>/bread-sheet-server` at `:<git-sha>` (immutable) + `:latest`, using the built-in
   `GITHUB_TOKEN`.
3. **Deploy to dev (automatic)** — the `deploy-dev` job (`needs: build`) assumes the deployer role via
   OIDC, **fetches the active task definition**, swaps in the `:<git-sha>` image
   (`amazon-ecs-render-task-definition`), registers a new revision, and `update-service`s the dev
   service, waiting for `services-stable` (`amazon-ecs-deploy-task-definition`). Merge to `main` ⇒ dev
   redeploys, no human step.

The task definition is **fetched from AWS, not stored in the repo**, so CD only swaps the image and
never clobbers the env/secrets owned by the (hand-built, soon Terraform-owned) task def.

**Rollback** = re-deploy the previous task-def revision (ECS keeps them); the deployment **circuit
breaker** auto-reverts a failed rollout.

**Prod promotion (deferred — no prod stage yet):** a gated release (git tag / GitHub Release / manual
dispatch + an `environment: production` required reviewer) promoting the **same** already-built
`:<git-sha>` to a prod service. Built when a prod cluster/service exists.

### Database migrations — ride along

The container command is `sh -c "npm run db:deploy && node dist/server.js"`, so **every new task runs
`prisma migrate deploy` before serving**. Prisma's migration lock keeps the brief two-task
rolling-deploy overlap safe — no separate migration Job or initContainer is needed on Fargate.

---

## Infrastructure as Code Principles

- **End state:** all cloud resources defined in `terraform/`, no manual console drift. The dev
  Fargate stack is currently hand-built and being imported into Terraform (Objective 14 in
  [`fargate-handbuild.md`](fargate-handbuild.md) maintains the import map); the legacy EKS files are
  removed once that lands.
- Lambda source and configuration live in `terraform/` alongside other infra.
- Secrets (DB connection string, Supabase keys) live in **SSM Parameter Store** (SecureString for the
  DB) and are injected into the container via the task-def `secrets` block — never committed. Google
  Cloud access is **keyless** via Workload Identity Federation; no GCP key or `GEMINI_API_KEY` is
  stored in production.
