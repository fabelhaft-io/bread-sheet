# Cheap Always-On Prod on AWS — ECS Fargate (plan)

> **Status:** plan / target architecture, not yet built. The current `terraform/` provisions an
> EKS stack (see [`infrastructure.md`](infrastructure.md)); this document describes the cheaper
> Fargate stack intended to replace it for production, while **keeping the EKS stack as a
> spin-up-and-destroy learning sandbox** (see [§ EKS sandbox](#eks-sandbox)).

## Why

BreadSheet is a small private app — a handful of users. EKS costs **~$170/mo idle** (control plane
$73 + NAT $33 + nodes $30 + ELB $18 + RDS), which is ~30× the real workload. The goal is to **stay
on AWS** (the project exists to learn AWS) while cutting cost ~80% and running **continuously**. The
fix is to drop the expensive pieces — EKS control plane, NAT gateway, multi-AZ — and replace them
with cheaper AWS-native services that teach the **mainstream "ECS web app"** pattern.

## Target cost (us-east-1, approx; region + free tier vary)

| Component | Service | ~$/mo | Notes |
|---|---|---|---|
| Compute | 1× Fargate task, 0.25 vCPU / 0.5 GB, 24/7 | ~9 | Scale the task size, not a node count. |
| Ingress | Application Load Balancer | ~16 | Stable DNS + ACM TLS + health checks. The one real swap-cost vs. EKS. |
| Database | RDS PostgreSQL `db.t4g.micro`, single-AZ, 20 GB | ~13 | **Free for 12 months** on the RDS free tier. |
| Images | S3 + resize Lambda + SQS DLQ | ~1 | **Kept** — cheap and high learning value. |
| Registry | GHCR (free) or ECR | 0–1 | GHCR public package = $0; ECR ≈ $0.10/GB. |
| TLS / DNS | ACM (free certs) + Route 53 zone | ~0.5 | |
| Logs / data transfer | CloudWatch Logs + egress | ~1–3 | Tiny at this scale. |
| **Total (steady state)** | | **~$30** | **~$15 with RDS free tier; ~$3–5 if Fargate→EC2 free tier.** |

Still ~6× cheaper than EKS, and it teaches ECS/Fargate, ALB, ACM, VPC, RDS, S3 events, IAM task
roles, and CloudWatch.

## Architecture

```
                 Route 53  ──>  ACM cert
                    │
   Internet ──> ALB (public subnets, :443)
                    │  target group (IP targets, :3000), health check GET /
                    ▼
        ECS Service (Fargate, desired=1)
        task in PUBLIC subnet, assignPublicIp=ENABLED  ── egress via IGW (no NAT)
          ├─ container: ghcr.io/fabelhaft-io/bread-sheet-server
          ├─ task role        → S3 (images) + AWS identity for GCP WIF
          └─ execution role   → pull image, write CloudWatch logs
                    │
        ┌───────────┼───────────────┐
        ▼           ▼               ▼
   RDS Postgres   S3 bucket     Supabase Auth (SaaS)   GCP Gemini/Vision (SaaS)
   (private,      raw/ ─ S3 event ─> resize Lambda ─> processed/   ─┐
    no egress)                                   SQS DLQ            │
                                                                    └─ keyless via WIF (AWS role)
```

**Key networking decision — no NAT gateway.** The Fargate task runs in a **public subnet with a
public IP** so it can pull its image and reach Supabase / GCP / S3 over the Internet Gateway (free).
It is *not* directly reachable: its security group only allows ingress from the **ALB's** security
group on port 3000. RDS sits in **private subnets** (no egress needed). This is the standard
cheap-ECS pattern and removes the $33/mo NAT.

## Terraform: reuse / trim / add

The cheap stack reuses most of what's written. Concretely:

| File | Action | Detail |
|---|---|---|
| `s3.tf`, `lambda.tf` | **Reuse as-is** | Image pipeline (S3 + resize Lambda + SQS) is kept. |
| `backend.tf`, `environments/*.s3.tfbackend` | **Reuse** | S3 remote state, per-env keys. |
| `main.tf`, `variables.tf`, `locals.tf`, `outputs.tf` | **Adapt** | Drop EKS/node vars; add ECS/ALB/ACM vars + outputs. |
| `network.tf` (VPC module) | **Trim** | `enable_nat_gateway = false`; public subnets for the task + ALB, private for RDS. |
| `rds.tf` | **Reuse, retarget** | Keep single-AZ `db.t4g.micro`; SG ingress now references the **Fargate task SG** instead of the EKS node SG. |
| `eks.tf`, `irsa.tf` | **Remove** (this stack) | IRSA → ECS **task role**. Files preserved on the EKS branch. |
| `gcp-wif.tf` | **Rewrite** | OIDC(EKS) → **AWS** provider type federating the task role (see below). |
| `terraform/k8s/*` | **Remove** (this stack) | Replaced by the ECS task definition + service. |
| `ecs.tf` | **Add** | Cluster, task definition, service, task + execution roles, task SG, CloudWatch log group. |
| `alb.tf` | **Add** | ALB, target group (IP), HTTPS listener, ACM cert (DNS-validated), ALB SG. |

**Migrations.** With a single task, run them inline as the container command:
`sh -c "npm run db:deploy && node dist/server.js"` (Prisma's migration lock makes this safe for one
task). If the service later scales >1, switch to a dedicated one-off `aws ecs run-task` migrate task
in CI before the service update.

**Secrets.** Task definition `secrets` pulls from **SSM Parameter Store** SecureString (free):
`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`, and `GEMINI_API_KEY` (only if
using the API-key auth path). Non-secret config stays as task `environment` entries.

## GCP auth without EKS (Workload Identity, AWS flavor)

The EKS-OIDC WIF does not apply off-cluster. Two options:

1. **Keyless via AWS-role federation (recommended for learning, no stored key).**
   - WIF pool **provider** of type `aws { account_id = <acct> }` (replaces the OIDC provider).
   - Attribute condition restricts to the **ECS task role** ARN.
   - GCP service account keeps `roles/cloudvision.user` + `roles/aiplatform.user`; the
     `workloadIdentityUser` member becomes the task role's assumed-role principalSet.
   - Pod cred config → `gcloud iam workload-identity-pools create-cred-config <provider> --aws
     --service-account=<sa>`; the google-auth lib reads the task's AWS creds from the ECS metadata
     endpoint automatically. `GOOGLE_GENAI_USE_VERTEXAI=true`, `VISION_MODE=live`.
2. **Simplest — single `GEMINI_API_KEY`.** Set `VISION_MODE=llm` + `PLAUSIBILITY_MODE=gemini`
   (Gemini does OCR *and* the abuse gate), store the key in SSM. No GCP service account, no Vision
   API, no WIF. Free tier covers a handful of users. Good default if you don't need the WIF lesson.

## CI/CD

Reuse `.github/workflows/build-image.yml` (already builds + pushes to GHCR). Add a deploy step on
push to `main`: register a new task-definition revision with the new image tag and call
`aws ecs update-service --force-new-deployment` (e.g. via `aws-actions/amazon-ecs-deploy-task-definition`).
ECS performs a rolling replacement behind the ALB. No ArgoCD needed at this scale.

## EKS sandbox

The EKS stack is **not deleted** — it's a learning asset. Keep it on a dedicated branch
(e.g. `infra/eks-sandbox`, forked from the current `feat/minor-fixes-maybe-test-deploy`), with the
Fargate stack on `main`. To learn/experiment:

```sh
git switch infra/eks-sandbox
terraform -chdir=terraform init -backend-config=environments/dev.s3.tfbackend
terraform -chdir=terraform apply  -var-file=environments/dev.tfvars
# ...explore EKS, kubectl, ArgoCD, IRSA...
terraform -chdir=terraform destroy -var-file=environments/dev.tfvars   # stop the meter
```

Because each stack uses a **distinct remote-state key**, they never collide. The two stacks share
`s3.tf`/`lambda.tf`/`rds.tf` patterns, so improvements can be cherry-picked between branches.

> Alternative (more work, cleaner long-term): restructure `terraform/` into shared `modules/` + two
> root stacks (`stacks/fargate/`, `stacks/eks/`) so both live on `main`, each with its own state.
> Branch-based is simpler to start; revisit if the duplication becomes annoying.

## Decisions (settled)

- **Ingress: ALB.** An internet-facing Application Load Balancer (~$16/mo) fronts the Fargate
  service: stable DNS, ACM TLS termination, and health-checked auto-replacement of the task. App
  Runner was considered and rejected (keeps the VPC/ALB learning). `alb.tf` is part of the build.
- **GCP auth: keyless WIF via the AWS task role** (option 1 above). No `GEMINI_API_KEY` stored; the
  WIF pool provider is type `aws`, federating the ECS task role. `VISION_MODE=live`,
  `GOOGLE_GENAI_USE_VERTEXAI=true`.
- **Database: RDS `db.t4g.micro` single-AZ** — free for the first 12 months, then ~$13/mo. Cost is
  revisited after the free-tier year (see FEATURES.md § Infrastructure cost optimization → migrate to
  containerized Postgres).
- **Registry: GHCR** (`ghcr.io/fabelhaft-io/bread-sheet-server`, free public package, already wired
  in `.github/workflows/build-image.yml`). No ECR.

## Implementation outline

> Being built **hands-on first** (console/CLI) then imported to Terraform — progress tracked in
> [`fargate-handbuild.md`](fargate-handbuild.md).

With the decisions above, the build is:

1. Add `ecs.tf` — cluster, task definition (GHCR image; command `db:deploy && start`), service
   (desired=1), task + execution IAM roles, task SG, CloudWatch log group. Task role is the AWS
   identity for GCP WIF and holds S3 access.
2. Add `alb.tf` — ALB, IP target group (health check `GET /`), HTTPS listener, ACM cert (DNS), ALB SG.
3. Trim `network.tf` — `enable_nat_gateway = false`; Fargate task + ALB in public subnets, RDS private.
4. Retarget `rds.tf` — SG ingress references the Fargate task SG.
5. Rewrite `gcp-wif.tf` — WIF provider type `aws` federating the task role (replaces the EKS-OIDC form).
6. Remove `eks.tf`, `irsa.tf`, and `terraform/k8s/*` on `main`; preserve them on `infra/eks-sandbox`.
7. CI — add an `aws ecs update-service` deploy step after the GHCR build.
8. Secrets — `DATABASE_URL`, `SUPABASE_*` from SSM Parameter Store SecureString.
