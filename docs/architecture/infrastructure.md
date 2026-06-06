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
| LocalStack | 4566 | AWS service emulation (S3, Lambda, IAM, STS) |
| Server (app-dev profile) | 3000 | API server with hot-reload via nodemon |

LocalStack allows developers to test S3 uploads and Lambda triggers without an AWS account or cost.

**Lambda build (required before `terraform apply`):**
The image-resizer Lambda is a TypeScript package at `server/lambda/imageResizer/`. Terraform's `archive_file` data source reads the compiled output from `dist/bundle/`, so the Lambda must be built before applying:

```sh
cd server/lambda/imageResizer
npm install
npm run build   # outputs dist/bundle/ (JS + sharp Linux x64 binary)
cd ../../..
terraform -chdir=terraform apply
```

The build script installs the Linux x64 variant of sharp into `dist/bundle/node_modules/` regardless of the host OS, producing a Lambda-compatible artifact.

---

## Cloud Infrastructure (Terraform)

`terraform/` is the single source of truth for all AWS resources. Apply via CI or manually:

```sh
cd terraform && terraform apply
```

### Resources provisioned

| Resource | Service | Purpose |
|----------|---------|---------|
| VPC, subnets, security groups | AWS Networking | Isolated network for EKS and RDS |
| EKS Cluster + managed node groups | Amazon EKS | Kubernetes cluster for the API server |
| PostgreSQL instance | Amazon RDS | Managed production database |
| Container registry | Amazon ECR | Stores versioned server Docker images |
| Object storage | Amazon S3 | Product images (`raw/` and `processed/` prefixes) |
| Image resize function | AWS Lambda | S3-triggered; resizes uploaded images asynchronously |
| Dead-letter queue | Amazon SQS | Captures Lambda failures for ops alerting |

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

1. **Test** — run full test suites (`npm test` in `server/` and `bread-sheet-app/`).
2. **Build image** — `docker build -t <ecr-repo>/bread-sheet-server:$GIT_SHA .`
3. **Push to ECR** — image tagged with the Git commit SHA.
4. **Update manifest** — pipeline checks out the K8s manifest repo and updates the `image` tag in `deployment.yaml` to the new SHA, then commits and pushes.

### ArgoCD (Continuous Deployment)

1. Detects the manifest change pushed by CI.
2. Applies it to the EKS cluster.
3. Kubernetes performs a rolling update: new pods with the new image start before old pods terminate.

### Kubernetes Manifests (`/k8s`)

YAML files declaring the desired cluster state (Deployments, Services, Ingress). ArgoCD treats these as the authoritative source.

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
