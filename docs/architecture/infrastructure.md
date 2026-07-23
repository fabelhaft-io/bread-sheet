# Infrastructure & Deployment

Covers local development setup, the cloud infrastructure (AWS — ECS Fargate), and the push-based CD
pipeline.

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
`scripts/localstack-init.sh` runs on LocalStack startup (`/etc/localstack/init/ready.d/`) and provisions the full local pipeline — the S3 bucket, the `image-resizer` Lambda, and the `s3:ObjectCreated:*` (prefix `raw/`) trigger — mirroring production without requiring a local Terraform install. The Lambda bundle is mounted into the container from `server/lambda/imageResizer/dist/bundle/`, so it must be built first:

```sh
cd server/lambda/imageResizer
npm install
npm run build   # outputs dist/bundle/ (JS + sharp Linux x64 binary)
cd ../..
docker compose up -d   # init hook deploys the Lambda; re-run after rebuilds via
                       # docker compose restart localstack
```

If the bundle is missing the init script logs a warning and skips the Lambda — uploads still work, but `processed/` objects are never written.

---

## Cloud Infrastructure (AWS — ECS Fargate)

The dev cloud environment is a **Fargate stack fully owned by Terraform** (`terraform/`). All
resources were hand-built first (for learning), then imported into state with zero drift —
`terraform plan` reports no changes. The build log and import map are in
[`fargate-handbuild.md`](fargate-handbuild.md).

### Architecture (dev)

Public hostname **`https://server.dev.bread-sheet.com`** → ALB → Fargate task → RDS. The security-group
chain enforces `internet → ALB → task(:3000) → RDS(:5432)`, each internal hop referencing the previous
group's SG id (no CIDRs).

| Component | Resource | Notes |
|---|---|---|
| Network | VPC `10.0.0.0/16`, 2 public + 2 private subnets, **no NAT** | Task runs in the **public** subnets with a public IP (pulls the GHCR image and reaches Supabase / GCP / SSM via the IGW); RDS is private-only. ~$33/mo saved vs NAT. |
| Ingress | Application Load Balancer + ACM cert + Route 53 alias | HTTPS `:443` (cert for `server.dev.bread-sheet.com`) → IP target group (`:3000`, health `GET /`); HTTP `:80` → 301. |
| Compute | ECS **Fargate** service `breadsheet-dev-server-service` on cluster `breadsheet-server-dev` | Desired 1, `256`/`512`, **X86_64** (image is `linux/amd64`), `assignPublicIp=ENABLED`, rolling deploy + circuit-breaker rollback, 120 s health-check grace (migrations run before serving). |
| Database | RDS PostgreSQL `db.t4g.micro`, single-AZ, private, encrypted | Reachable only from the task SG on `5432`. Keyless RDS IAM auth (`DB_AUTH=iam`) via `@aws-sdk/rds-signer` — see [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md). |
| Images | S3 bucket `breadsheet-dev-s3-…` | `raw/*` private (task `s3:PutObject` only), `processed/*` scoped public-read; resize Lambda deferred. |
| Image registry | GHCR `ghcr.io/fabelhaft-io/bread-sheet-server` (public) | **Not ECR** — the execution role needs no pull secret. |
| Secrets | SSM Parameter Store `/breadsheet/dev/*` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`; injected into the container via the task-def `secrets` block by the **execution** role. `DATABASE_URL` is no longer a secret (keyless IAM auth — no password). |
| Identity | IAM execution + task + deployer roles, GitHub OIDC provider | All keyless. Task role = the app's identity (S3, `rds-db:connect`, + the principal GCP WIF federates). Deployer assumed by CI via OIDC. |
| Keyless GCP | WIF pool `breadsheet-dev` + **AWS provider** + SA `breadsheet-dev-vision` | See § Keyless Google Cloud. |

**Container image.** Published to the free **GitHub Container Registry**
(`ghcr.io/fabelhaft-io/bread-sheet-server`, public) by `.github/workflows/build-image.yml` on push to
`main` — never ECR. The task definition pins the immutable `:<git-sha>` tag.

### Database Authentication — Keyless RDS IAM Auth

The app authenticates to RDS without a stored password. The mechanism:

- **Runtime queries:** `configs/databaseConfig.ts` (when `DB_AUTH=iam`) creates an `@aws-sdk/rds-signer`
  `Signer` and returns an async `password` callback. The `pg.Pool` invokes it on each new physical
  connection — minting a 15-min IAM auth token (local signing, no network round-trip).
- **Migrations:** the Prisma migration engine reads `DATABASE_URL` directly and cannot use the pg.Pool
  callback. The ECS startup script (`scripts/start.sh`) mints a token via `scripts/rds-token.mjs` and
  injects it into `DATABASE_URL` before running `npm run db:deploy`.
- **IAM:** the task role has `rds-db:connect` scoped to the DB instance resource ID + the
  `breadsheet_iam` Postgres user (which has the `rds_iam` grant).
- **TLS:** mandatory for IAM auth. The pg pool verifies the RDS server cert against the CA bundle
  shipped in the Docker image (`certs/rds-global-bundle.pem`, `DB_SSL=verify-full`).

See [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md) for the full
rationale and migration history.

### Keyless Google Cloud (Vision/Vertex) — Fargate WIF

On Fargate the federation source is the **AWS task role**. The setup: a Workload Identity Pool with an
**AWS provider** (`account_id`, plus an attribute-condition scoping trust to the task role's
assumed-role ARN), a GCP service account `breadsheet-dev-vision` with `roles/aiplatform.user` (Cloud
Vision needs **no** role — API-enablement + an authenticated SA suffices; `roles/cloudvision.user` does
not exist), and a `workloadIdentityUser` binding to the task-role principalSet. At runtime the app
builds a google-auth `AwsClient` with a **programmatic credential supplier**
(`server/src/services/gcpWorkloadIdentity.ts`) that reads AWS credentials from the **ECS container
endpoint** — *not* EC2 IMDS, which doesn't serve task-role credentials on Fargate — and exchanges them
for a short-lived GCP token that impersonates the SA. No key file is mounted. Env:
`GCP_WORKLOAD_IDENTITY_AUDIENCE` + `GCP_SERVICE_ACCOUNT_EMAIL` (see
[`fargate-handbuild.md`](fargate-handbuild.md) Objective 12).

### Terraform Layout

```
terraform/
  main.tf         # providers (aws + google), data sources
  variables.tf    # all input variables
  locals.tf       # name_prefix, tags
  backend.tf      # S3 remote state, per-env keys
  network.tf      # VPC, subnets, IGW, route tables (no NAT)
  security.tf     # ALB / task / RDS security groups + cross-referencing rules
  rds.tf          # DB subnet group + RDS instance
  iam.tf          # execution / task / deployer roles, policies, GitHub OIDC provider
  s3.tf           # images bucket + public-access-block + ownership + policy + CORS
  ssm.tf          # SSM parameters (Supabase URL + key)
  ecs.tf          # ECS cluster + task definition + service
  alb.tf          # ALB + target group + listeners + ACM cert + validation
  dns.tf          # Route 53 zone (dev.bread-sheet.com) + A-alias → ALB
  gcp-wif.tf      # GCP WIF pool + AWS provider + SA + bindings
  outputs.tf      # Useful references (URLs, ARNs, names)
  environments/
    dev.tfvars           # Variable values for dev
    dev.s3.tfbackend     # Backend config for dev state
```

### Remote State (S3 backend)

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

### Apply

```sh
# Init selects the backend + downloads modules. Re-run when switching environments.
terraform -chdir=terraform init -backend-config=environments/dev.s3.tfbackend

# Plan (always review before apply)
terraform -chdir=terraform plan -var-file=environments/dev.tfvars

# Apply
terraform -chdir=terraform apply -var-file=environments/dev.tfvars
```

To validate config without AWS credentials (no apply): `init -backend=false` then `validate`.

### Terraform ↔ CD Ownership Split

CD (GitHub Actions) registers new task-definition revisions on every push — outside Terraform. To
prevent drift fights:

- `aws_ecs_service.server` has `lifecycle { ignore_changes = [task_definition] }` — Terraform owns the
  service; CD owns which revision it runs.
- `aws_ecs_task_definition.server` has `lifecycle { ignore_changes = [container_definitions] }` —
  Terraform owns the structure; CD updates the image tag.

### S3 Bucket Layout

```
s3://breadsheet-dev-s3-…/
├── raw/
│   ├── product/{uuid}.jpg    # Uploaded by API; triggers resize Lambda (deferred)
│   └── label/{uuid}.jpg      # OCR fallback images
└── processed/
    └── {uuid}.jpg            # Final display images (resize Lambda output)
```

### Pausing / Resuming the Dev Stack

Dev has no NAT gateway (~$33/mo already avoided). The remaining always-on costs are the Fargate
task (~$9/mo), RDS `db.t4g.micro` (~$12/mo), and the ALB (~$16–18/mo **flat**, regardless of
traffic — an ALB has no "stopped" state, only exists-or-doesn't). Two tiers, by how much of that
you want to shed.

**Tier 1 — CLI only, no Terraform changes (sheds the Fargate task + RDS compute):**

```sh
# Pause
aws ecs update-service --cluster breadsheet-server-dev --service breadsheet-dev-server-service --desired-count 0
aws rds stop-db-instance --db-instance-identifier breadsheet-dev-database-1

# Resume
aws rds start-db-instance --db-instance-identifier breadsheet-dev-database-1
aws ecs update-service --cluster breadsheet-server-dev --service breadsheet-dev-server-service --desired-count 1

# Check state
aws ecs describe-services --cluster breadsheet-server-dev --services breadsheet-dev-server-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount}' --output table
aws rds describe-db-instances --db-instance-identifier breadsheet-dev-database-1 \
  --query 'DBInstances[0].DBInstanceStatus' --output text
```

Paused looks like `running:0` (ECS) and RDS status `stopping` → `stopped`. Resumed looks like
`running:1` and RDS status `available`.

Caveats:
- RDS auto-restarts itself after **7 days** stopped (AWS-enforced) — re-run `stop-db-instance` if
  the pause runs longer.
- `aws_ecs_service.server` (`ecs.tf`) hardcodes `desired_count = 1`, and its
  `lifecycle.ignore_changes` only covers `task_definition`. Any `terraform apply` while paused —
  even for something unrelated — will see the drift and silently scale the service back to 1. Avoid
  `apply`ing while paused, or add `desired_count` to `ignore_changes` if pause/resume becomes
  routine.

**Tier 2 — also tear down the ALB (sheds the flat ~$16–18/mo charge too):**

```sh
# Pause (review first, then destroy)
terraform -chdir=terraform plan -destroy -var-file=environments/dev.tfvars -target=aws_lb.main
terraform -chdir=terraform destroy -var-file=environments/dev.tfvars -target=aws_lb.main

# Resume
terraform -chdir=terraform apply -var-file=environments/dev.tfvars
# then re-run the Tier 1 resume commands (RDS + ECS) — no point paying for compute with no ALB in front of it

# Check state
aws elbv2 describe-load-balancers --names breadsheet-dev-alb   # "LoadBalancerNotFoundException" while paused
terraform -chdir=terraform plan -var-file=environments/dev.tfvars   # "No changes" once fully resumed
```

`-target=aws_lb.main` on a destroy automatically cascades to everything that *depends on* the ALB —
`aws_lb_listener.https`, `aws_lb_listener.http_redirect`, and `aws_route53_record.server` — since
they'd otherwise reference a deleted resource. The target group, the ACM cert (+ validation), the
Route 53 zone, and the ECS service sit outside that dependency chain and are untouched, so the cert
stays `Issued` and nothing needs re-validating on resume — `apply` just recreates the ALB, listeners,
and alias record pointing at the new ALB's DNS name.

---

## Deployment Pipeline (push-based CD to ECS)

ECS is **push-deployed** — CI calls the ECS API to roll the service. There is no ArgoCD pull loop.
Keyless throughout: GitHub Actions assumes an AWS IAM **deployer role** via OIDC, no stored AWS keys.

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
never clobbers the env/secrets owned by Terraform.

**Rollback** = re-deploy the previous task-def revision (ECS keeps them); the deployment **circuit
breaker** auto-reverts a failed rollout.

**Prod promotion (deferred — no prod stage yet):** a gated release (git tag / GitHub Release / manual
dispatch + an `environment: production` required reviewer) promoting the **same** already-built
`:<git-sha>` to a prod service. Built when a prod cluster/service exists.

The mobile app has its own, unrelated build pipeline — see **Mobile App Build (Android APK)** below.

### Mobile App Build (Android APK)

`.github/workflows/build-apk.yml` is a manually-triggered (`workflow_dispatch`) workflow, separate
from the server's push-based CD above — it does not run on every push. It builds `bread-sheet-app/`
via **EAS Build** (Expo's cloud build service, not a local Gradle build in the runner): the job installs
`eas-cli` (`expo/expo-github-action`), runs `eas build --platform android --profile preview --wait
--json`, then downloads the resulting APK from the build's `artifacts.buildUrl` and uploads it as a
workflow artifact (30-day retention).

Profiles are defined in `bread-sheet-app/eas.json` — `preview` and `development` both set
`distribution: internal` + `android.buildType: apk` (installable `.apk`, not a Play Store `.aab`);
`production` is reserved for a future signed store build.

**One-time setup required before this workflow can run (not done by CI):**
1. `npx eas login` + `npx eas init` from `bread-sheet-app/` — creates the project on expo.dev and
   writes `extra.eas.projectId` into `app.json`. This step is interactive and must be run locally, then
   the resulting `app.json` change committed.
2. Add an `EXPO_TOKEN` repository secret — an access token from
   `expo.dev/accounts/<account>/settings/access-tokens`.

Because the app ships native modules (`expo-camera`, `@react-native-ml-kit/text-recognition`,
`expo-image-manipulator`) it cannot run in vanilla Expo Go — EAS Build compiles a real native binary
per `app.json`'s `plugins`, so this workflow (or an equivalent local `eas build`) is the only way to
get an installable build with those modules working end-to-end.

### Database Migrations — Ride Along

The container command is `sh scripts/start.sh`, which runs `npm run db:deploy` (Prisma migrations)
before `node dist/server.js`. When `DB_AUTH=iam`, the script mints an IAM token into `DATABASE_URL`
first — so the migration engine authenticates with a short-lived token too. Prisma's migration lock
keeps the brief two-task rolling-deploy overlap safe — no separate migration Job is needed.

---

## Infrastructure as Code Principles

- **All cloud resources defined in `terraform/`** — `terraform plan` shows no drift on the dev
  workspace. The build log and verification in [`fargate-handbuild.md`](fargate-handbuild.md)
  documents the hand-build → import journey.
- Secrets (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`) live in **SSM Parameter Store** and are
  injected via the task-def `secrets` block — never committed. Database auth is **keyless** (IAM).
  Google Cloud access is **keyless** via Workload Identity Federation.
- Lambda source and configuration will live in `terraform/` alongside other infra (resize Lambda is a
  deferred post-build adaptation).
- The **container registry is external**: the server image lives in GitHub Container Registry, not AWS.
