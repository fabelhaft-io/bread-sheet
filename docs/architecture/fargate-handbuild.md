# Fargate Prod — Hands-On Build Log (learn-by-doing, then import to Terraform)

A **living, resumable** runbook for building the cheap Fargate production stack
([architecture & decisions](cheap-prod-fargate.md)) **by hand** first — to learn AWS — then
importing the result into Terraform. Update the status fields as we go.

**Status legend:** ✅ done · 🔄 in progress · ⏸️ blocked · ⬜ not started

---

## How we work (the rules)

- **Coach, not autopilot.** Each step is an **objective** + a **definition of done** + *why* it
  matters. No clickpaths or copy-paste commands — Jano explores the console (UI first, to *see* the
  service), googles, and figures out the *how*. Hints/clarifications on request.
- **UI first, then CLI.** Build each service in the console at least once; once comfortable, switch
  to the `aws` CLI (the commands translate cleanly to Terraform later).
- **Verify together.** Once AWS creds are configured on the dev machine, Claude runs **read-only**
  `aws … describe/list` calls to inspect what was built and check it against the done-criteria.
- **Keep it running.** Resources stay up after the learning pass; we then **`terraform import`**
  each into Terraform (see [Import map](#import-map)). Cost is accepted — mitigate via tagging +
  not leaving experiments half-built.
- **Maintain the import map** as we create resources, so the import phase is mechanical.

## Groundwork

| Item | Status | Notes |
|---|---|---|
| AWS credentials working (`aws sts get-caller-identity`) | ⬜ | Run `! aws configure` (or `! aws configure sso`) in-session. |
| Region chosen | ⬜ | **Proposed: `eu-central-1` (Frankfurt)** — EU users, aligns with GCP `europe-west1`. Confirm. |
| Common tag applied to everything | ⬜ | e.g. `project=bread-sheet` (+ `env=prod`). Eases cost tracking, cleanup, import. |

---

## Build order & status

Dependency order — this is also the eventual Terraform reference graph. Each row links to its detail
section as it's fleshed out.

| # | Objective | Status |
|---|---|---|
| 1 | [Network foundation (VPC, subnets, IGW, routes; no NAT)](#objective-1--network-foundation-vpc) | 🔄 |
| 2 | Security groups (ALB SG, task SG, RDS SG) | ⬜ |
| 3 | RDS PostgreSQL (`db.t4g.micro`, single-AZ, private) | ⬜ |
| 4 | Container image on GHCR (already produced by CI) | ⬜ |
| 5 | IAM roles (ECS task role + execution role) | ⬜ |
| 6 | ECS cluster (Fargate) | ⬜ |
| 7 | Task definition (image, env, secrets, migrate command) | ⬜ |
| 8 | ALB + target group + ACM cert + HTTPS listener | ⬜ |
| 9 | ECS service (wires task → target group) | ⬜ |
| 10 | Route 53 record → ALB | ⬜ |
| 11 | GCP Workload Identity Federation (AWS provider trusting the task role) | ⬜ |
| 12 | Secrets in SSM Parameter Store (`DATABASE_URL`, `SUPABASE_*`) | ⬜ |
| 13 | Import everything into Terraform | ⬜ |

---

## Objective 1 — Network foundation (VPC)  🔄

**Goal:** a VPC with **public + private subnets across 2 AZs**, an **internet gateway**, and route
tables so the **public** subnets route `0.0.0.0/0` to the IGW. **No NAT gateway.**

**Why this shape:** the Fargate task sits in the **public** subnets (with a public IP) so it can
pull from GHCR and reach Supabase/GCP without a NAT (~$33/mo saved); RDS sits in the **private**
subnets, reachable only from inside the VPC.

**Definition of done:**
- [ ] A VPC with a sensible CIDR (e.g. a /16).
- [ ] 2 public + 2 private subnets, each pair in a different AZ.
- [ ] An internet gateway attached to the VPC.
- [ ] Public route table has a default route to the IGW; private route table does **not**.
- [ ] No NAT gateway exists.
- [ ] Everything tagged `project=bread-sheet`.

**First-timer tip (not a clickpath):** the VPC console's **"Create VPC → VPC and more"** wizard
scaffolds subnets, route tables, and the IGW in one shot — good for seeing the whole picture. When
it asks about **NAT gateways, choose None**.

**Verification:** Claude will run `aws ec2 describe-vpcs / describe-subnets / describe-route-tables /
describe-internet-gateways` (read-only) and confirm against the checklist.

---

## Import map

Filled in as resources are created; drives the Terraform import phase (objective 13).

| Resource | AWS ID | Planned TF address | Imported |
|---|---|---|---|
| _(none yet)_ | | | ⬜ |

---

## Session log

- _Session 1:_ agreed the approach (hand-build whole stack → import), wrote this runbook, started
  Objective 1.
