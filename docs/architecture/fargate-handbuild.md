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
| AWS credentials working (`aws sts get-caller-identity`) | ✅ | Authenticated as `arn:aws:iam::493942067033:user/JanoDev` (non-root IAM admin user). Never create root access keys; root is MFA-locked and unused. |
| Region chosen | ✅ | **`eu-west-1` (Ireland)** — EU, close to GCP `europe-west1`, typically cheapest EU region. |
| Common tag applied to everything | ✅ | Tags `Project=breadsheet` + `Stage=dev` (capitalised keys, matching AWS's own `Name`). Eases cost tracking, cleanup, import. |

---

## Build order & status

Dependency order — this is also the eventual Terraform reference graph. Each row links to its detail
section as it's fleshed out.

| #  | Objective                                                                                      | Status |
|----|------------------------------------------------------------------------------------------------|---|
| 1  | [Network foundation (VPC, subnets, IGW, routes; no NAT)](#objective-1--network-foundation-vpc) | ✅ |
| 2  | [Security groups (ALB SG, task SG, RDS SG)](#objective-2--security-groups)                     | ✅ |
| 3  | [RDS PostgreSQL (`db.t4g.micro`, single-AZ, private)](#objective-3--rds-postgresql)            | ✅ |
| 4  | [Container image on GHCR](#objective-4--container-image-on-ghcr)                               | ✅ |
| 5  | IAM roles (ECS task role + execution role)                                                     | ⬜ |
| 6  | ECS cluster (Fargate)                                                                          | ⬜ |
| 7  | [Task definition (image, env, secrets, migrate command) + CD pipeline](#objective-7--task-definition--cd-pipeline) | ⬜ |
| 8  | ALB + target group + ACM cert + HTTPS listener                                                 | ⬜ |
| 9  | ECS service (wires task → target group)                                                        | ⬜ |
| 10 | Route 53 record → ALB                                                                          | ⬜ |
| 11 | GCP Workload Identity Federation (AWS provider trusting the task role)                         | ⬜ |
| 12 | Secrets in SSM Parameter Store (`DATABASE_URL`, `SUPABASE_*`)                                  | ⬜ |
| 13 | Import everything into Terraform                                                               | ⬜ |
| 14 | Post Build Adaptions                                                                           | ⬜ |

---

## Objective 1 — Network foundation (VPC)  ✅

**Built (eu-west-1):** VPC `vpc-03b6a4b37cf1c9183` (`10.0.0.0/16`). Public subnets auto-assign a
public IP; private do not. Subnets are named by **AZ ID** (`euw1-az1`/`euw1-az2`, stable across
accounts) rather than the per-account-randomised AZ *names* — note `az1`=`eu-west-1c`,
`az2`=`eu-west-1a`. No NAT gateway. All resources tagged `Project=breadsheet` + `Stage=dev`.
See the [import map](#import-map) for IDs. Verified read-only against every done-criterion below.

**Goal:** a VPC with **public + private subnets across 2 AZs**, an **internet gateway**, and route
tables so the **public** subnets route `0.0.0.0/0` to the IGW. **No NAT gateway.**

**Why this shape:** the Fargate task sits in the **public** subnets (with a public IP) so it can
pull from GHCR and reach Supabase/GCP without a NAT (~$33/mo saved); RDS sits in the **private**
subnets, reachable only from inside the VPC.

**Definition of done:**
- [x] A VPC with a sensible CIDR (e.g. a /16). — `10.0.0.0/16`
- [x] 2 public + 2 private subnets, each pair in a different AZ. — one public+private pair per AZ
- [x] An internet gateway attached to the VPC.
- [x] Public route table has a default route to the IGW; private route table does **not**.
- [x] No NAT gateway exists.
- [x] Everything tagged `project=bread-sheet`. — used `Project=breadsheet` + `Stage=dev`

**First-timer tip (not a clickpath):** the VPC console's **"Create VPC → VPC and more"** wizard
scaffolds subnets, route tables, and the IGW in one shot — good for seeing the whole picture. When
it asks about **NAT gateways, choose None**.

**Verification:** Claude will run `aws ec2 describe-vpcs / describe-subnets / describe-route-tables /
describe-internet-gateways` (read-only) and confirm against the checklist.

---

## Objective 2 — Security groups  ✅

**Built (eu-west-1, in `vpc-03b6a4b37cf1c9183`):** three SGs wiring the chain
`internet → ALB → 3000 → Task → 5432 → RDS`. ALB SG `sg-00776b71913d8fd38` allows `443` from
`0.0.0.0/0` **and** `::/0` (IPv6). Task SG `sg-0a74a20cd899f7b06` allows `3000` **only from the ALB
SG id**. RDS SG `sg-054c28ee2b5ddfdde` allows `5432` **only from the Task SG id**. Both internal
hops are SG-id references (zero CIDRs). ALB + Task keep default allow-all egress; **RDS SG egress was
stripped to empty** — fine and tighter: SGs are stateful so query responses return on the ingress
path, and Postgres never initiates outbound. All tagged `Project=breadsheet` + `Stage=dev` (plus a
`Ressource` tag — note the double-s spelling). Verified read-only against every done-criterion.

**Goal:** three security groups that encode the only paths traffic may take through the stack:
**internet → ALB → Fargate task → RDS**. Nothing skips a hop.

**Why this shape:** security groups are stateful and reference *each other* (not CIDRs) for
internal hops, so the rules stay correct no matter how IPs change. The chain enforces that the
database is reachable **only** from the app, and the app is reachable **only** through the load
balancer — the task and DB never take public inbound traffic even though the task lives in a public
subnet.

**The three groups (inbound rules; egress stays default "allow all" unless noted):**

- **ALB SG** — the only group exposed to the internet.
  - `443/tcp` from `0.0.0.0/0` (and `::/0` if you want IPv6) — HTTPS.
  - `80/tcp` from `0.0.0.0/0` — only so the listener can 301-redirect to HTTPS. Optional.
- **Task SG** (the Fargate ENI).
  - container port (**`3000/tcp`**) **from the ALB SG** (source = security group, not a CIDR).
  - No other inbound. Egress all — the task must reach GHCR, Supabase, GCP and RDS outbound.
- **RDS SG**.
  - `5432/tcp` **from the Task SG** (source = security group). Nothing else. No public inbound.

**Definition of done:**
- [x] Three SGs exist in `vpc-03b6a4b37cf1c9183`, tagged `Project=breadsheet` + `Stage=dev`.
- [x] ALB SG allows `443` (and optionally `80`) from the internet; nothing else inbound. — `443` from `0.0.0.0/0` + `::/0`; no `80` (the optional redirect — add later with the listener).
- [x] Task SG allows the container port **only from the ALB SG**; no CIDR-based inbound. — `3000` from ALB SG id.
- [x] RDS SG allows `5432` **only from the Task SG**; no public inbound. — `5432` from Task SG id.
- [x] Internal hops reference **security-group IDs**, not IP ranges.

**First-timer tip (not a clickpath):** create the three empty SGs first, then add the
cross-referencing rules — you can't point Task SG at ALB SG until ALB SG exists. When a rule's
source is "Custom" you can paste/select another SG's ID instead of a CIDR; that's the
security-group-referencing pattern. Don't tighten egress yet — default allow-all out is correct here
(the task genuinely needs broad outbound). Naming suggestion: `breadsheet-dev-{alb,task,rds}-sg`.

**Verification:** Claude will run `aws ec2 describe-security-groups` (read-only) and confirm each
group's ingress sources are the *referenced SG IDs* (not CIDRs) per the checklist, and that no
unintended `0.0.0.0/0` inbound exists on the task/RDS groups.

---

## Objective 3 — RDS PostgreSQL  ✅

**Built (eu-west-1):** instance `breadsheet-dev-database-1` — `postgres` **18.3** (matches local
PG 18), `db.t4g.micro`, single-AZ, `gp3` 20 GB, encrypted. **Not** publicly accessible; attached to
the RDS SG `sg-054c28ee2b5ddfdde` only; placed via DB subnet group `breadsheet-dev-db-subnets` which
holds **only** the two private subnets. Initial db `breadsheet`, port 5432, **IAM DB auth enabled**
(per [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md) — keeps the
keyless-migration door open). Endpoint
`breadsheet-dev-database-1.cna48wy46m01.eu-west-1.rds.amazonaws.com:5432` (becomes `DATABASE_URL`
in Objective 12). Tagged `Project=breadsheet` + `Stage=dev`. Verified read-only against every
done-criterion.

**Goal:** a single managed PostgreSQL instance (`db.t4g.micro`, single-AZ) living in the **private**
subnets, with **no public access**, attached to the **RDS SG** (`sg-054c28ee2b5ddfdde`) — so the
only thing that can open a connection to it is the Fargate task on `5432`.

**Why this shape:** `db.t4g.micro` (Graviton, burstable) is the cheapest always-on managed Postgres;
single-AZ drops the standby replica (Multi-AZ ~doubles the bill — fine to skip for dev). Placing it
in the private subnets with *Publicly accessible = No* means it has **no internet route in either
direction** (this is the payoff of the [no-NAT design](#objective-1--network-foundation-vpc)): the
DB is reachable only from inside the VPC, and the SG chain narrows that to "the task, on 5432, and
nothing else." RDS itself never needs outbound internet for normal Postgres serving.

**Key sub-concept — the DB subnet group:** RDS doesn't take subnet IDs directly; it takes a **DB
subnet group**, a named bundle of subnets it's allowed to place the instance (and any future
standby/replica) into. Put **only the two private subnets** in it — if a public subnet sneaks in,
RDS may land the instance somewhere with an IGW route. This is the RDS-specific wrapper that the
network objective was building toward.

**Definition of done:**
- [x] A PostgreSQL RDS instance, `db.t4g.micro`, **single-AZ** (Multi-AZ = No), in
      `vpc-03b6a4b37cf1c9183`. — `postgres 18.3`, `MultiAZ=false`.
- [x] Placed via a **DB subnet group containing only the two private subnets**
      (`subnet-030cd17b05d582d90`, `subnet-02d9c09aeec128710`). — `breadsheet-dev-db-subnets`.
- [x] **Publicly accessible = No** — the instance has no public IP.
- [x] Attached to the **RDS SG (`sg-054c28ee2b5ddfdde`) only** — not the VPC default SG.
- [x] Storage `gp3`, modest size (e.g. 20 GB), **encryption at rest on** (default KMS key is fine). — `gp3` 20 GB, encrypted.
- [x] An initial database (`breadsheet`, to match local) and a master user exist; port `5432`.
- [x] **IAM DB authentication enabled** on the instance (keeps the keyless-migration door open;
      coexists with password auth — see [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md)).
- [x] Tagged `Project=breadsheet` + `Stage=dev`.

**First-timer tip (not a clickpath):** the "Easy create" path hides the networking choices you most
need to see — prefer **Standard create** so you can pick the VPC, the DB subnet group, *Publicly
accessible = No*, and swap the default SG for the RDS SG. Skip **Multi-AZ** (the standby is the
single biggest cost lever here). The **master password** is a decided question — see
[ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md): **set a password
manually now** and store it in **SSM Parameter Store** ([Objective 12](#build-order--status)); do
*not* use the Secrets Manager managed password (separate paid secret, and we don't need rotation).
Also **enable the IAM DB authentication toggle** while you're here — it's a no-reboot modify that
coexists with password auth, and it keeps the door open to migrate to keyless IAM auth later (the
[post-build adaptation](#post-build-adaptations) below). Engine version: pick the newest
PostgreSQL RDS offers that Prisma supports (local runs Postgres 18 — match it if available, else the
latest 17.x). For a learn-by-doing dev box, low backup retention (1 day) is fine, and you may leave
**deletion protection off** so teardown stays easy — just remember it's off.

**Verification:** Claude will run `aws rds describe-db-instances` and `describe-db-subnet-groups`
(read-only) and confirm: `Engine=postgres`, `DBInstanceClass=db.t4g.micro`, `MultiAZ=false`,
`PubliclyAccessible=false`, `StorageEncrypted=true`, the attached `VpcSecurityGroups` is the RDS SG,
the DB subnet group contains **only** the two private subnets, and note the instance **endpoint**
(used to build `DATABASE_URL` later). It will also sanity-check that the endpoint resolves to a
**private** address.

---

## Objective 4 — Container image on GHCR  ✅

**Built:** `.github/workflows/build-image.yml` lived only on a feature branch until session 5; once
**merged to `main`** it ran and produced `ghcr.io/fabelhaft-io/bread-sheet-server` at tags
**`:b8ab5ac…`** (the merge SHA) and **`:latest`**. The package is **Public** (anonymous pull
confirmed). The workflow's actions were bumped to the Node 24 runtime (`checkout@v5`,
`login-action@v4`, `build-push-action@v7`) to clear the Node 20 deprecation warnings.

**Verified image facts (drive later objectives):**
- **Architecture `linux/amd64`, single-arch** → the Fargate task must be **CPU architecture =
  X86_64**, *not* ARM64. (Graviton/ARM Fargate would need a multi-arch or arm64 build first — the
  `t4g` RDS being Graviton is unrelated.)
- **Exposed port `3000/tcp`** → matches the Task SG and the ALB target group.
- **Entrypoint `docker-entrypoint.sh` + Cmd `node dist/server.js`** → the migrate command
  ([Objective 7](#objective-7--task-definition--cd-pipeline)) overrides this as an ECS `command`;
  check how `docker-entrypoint.sh` forwards its args so `db:deploy` runs before serving.

Because the package is public, the [Objective 5](#build-order--status) execution role needs **no
GHCR pull credentials**. The task definition pins the immutable **`:<git-sha>`** tag.

**Definition of done:**
- [x] CI builds and pushes the server image on merge to `main` — `:<git-sha>` + `:latest`.
- [x] Workflow actions on the Node 24 runtime (no Node 20 deprecation warnings).
- [x] **Package visibility is Public** — anonymous registry pull succeeds (no image-pull secret).

---

## Objective 7 — Task definition + CD pipeline  ⬜

> Detail for the task definition itself (image, env, secrets, the inline migrate+serve command) is
> fleshed out when we reach it. Captured **now** because the question "how does a new image reach
> Fargate?" belongs with the task definition — but note the CD can only be **tested once the ECS
> service exists (Objective 9)**, since there's nothing to update before then.

**Where we are today:** we have **CI, not CD**. `.github/workflows/build-image.yml` builds the
server image on push to `main` and pushes two tags — `…/bread-sheet-server:<git-sha>` (immutable)
and `:latest` (moving). **Nothing tells the running Fargate service to pick up a new image.** The
EKS plan's ArgoCD pull-reconcile loop does **not** carry over: ECS is **push**-deployed.

**The ECS deploy mechanic (the missing half):** an ECS *service* runs a *task-definition revision*,
and a task def pins an *image*. To ship code you (1) **register a new task-def revision** at the new
`:<git-sha>` image, (2) **`aws ecs update-service --task-definition <rev>`** → ECS does a **rolling
deployment** (start new task → wait for ALB target-group health → drain old), (3) **wait for
`services-stable`** so CI fails on a bad rollout. **Rollback = update-service back to the previous
revision** (ECS keeps them). Pin the task def to **`:<git-sha>`, never `:latest`** — that makes
"what's running" and "go back one" both deterministic.

**Dev — continuous deployment (automatic):** add a **deploy job** after `build`, on push to `main`:
auth to AWS (keyless, below) → render the task def with `image=…:<sha>` → register revision →
`update-service` on the **dev** cluster → wait stable. Building block:
`aws-actions/amazon-ecs-deploy-task-definition`. Merge to main ⇒ dev updates, no human step.
**Migrations ride along** — the container command is `sh -c "npm run db:deploy && node dist/server.js"`,
so every new task runs Prisma migrations before serving (the migration lock keeps the brief
two-task overlap safe).

**Prod — gated release (promote, don't rebuild):** trigger on a **git tag `v*` / GitHub Release /
manual `workflow_dispatch`**; deploy the **same already-built `:<sha>`** artifact that has been
running in dev to the **prod** cluster. Gate it with a **GitHub Environment `production` + required
reviewer** so the job pauses for a one-click approval before touching prod. Same job code as dev,
different cluster/service + an approval wall.

**Two prerequisites / decisions:**
- **Keyless AWS auth from GitHub Actions** — *not* stored AWS keys. Use **GitHub OIDC → an AWS IAM
  "deployer" role** (`aws-actions/configure-aws-credentials` with `role-to-assume`), trusting this
  repo's OIDC token, scoped to `ecs:RegisterTaskDefinition`, `ecs:UpdateService`,
  `ecs:DescribeServices`, and `iam:PassRole` (task + execution roles). This is a new IAM role —
  build it alongside the [Objective 5](#build-order--status) task/execution roles. Matches the
  IRSA/WIF keyless posture.
- **Terraform vs CD ownership of the task def** — CD registers new revisions outside Terraform on
  every deploy → drift. Standard fix: `lifecycle { ignore_changes = [task_definition] }` on
  `aws_ecs_service`; TF owns the cluster/service/roles/ALB, CD owns revisions. Decide at the import
  phase ([Objective 13](#build-order--status)) — likely its own short ADR.

**Definition of done (for the CD half):**
- [ ] A GitHub OIDC deployer role exists; Actions assumes it with no static AWS keys.
- [ ] Push to `main` auto-deploys to the **dev** ECS service (new task-def revision at `:<sha>`,
      waits `services-stable`).
- [ ] A **gated** prod release (tag/release/dispatch + required reviewer) promotes the **same
      `:<sha>`** to the prod service.
- [ ] Task def pins the immutable `:<git-sha>` tag, not `:latest`.
- [ ] Rollback verified: re-deploying the previous task-def revision restores the old image.

---

## Post-build adaptations

Improvements deliberately **deferred** until the stack runs end-to-end, so they don't sit on the
critical path. Each is self-contained and safe to do as its own change once the app is deployed and
serving.

| # | Adaptation | Trigger / prerequisite | Reference |
|---|---|---|---|
| A1 | **Migrate DB auth to keyless IAM** — swap the SSM password for RDS IAM authentication via the Prisma `@prisma/adapter-pg` driver adapter + a `pg.Pool` async `password` callback that mints a 15-min auth token. Grant the DB user `rds_iam`; enforce TLS with the RDS CA bundle (`rejectUnauthorized: true`). The instance's IAM-auth toggle is already on (Objective 3). | App deployed and serving over the SSM password first. | [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md) |

_Add rows here as we defer other "make it nicer once it works" items (e.g. tighten task egress,
add a CDN in front of assets, move logs to a retention policy)._

---

## Import map

Filled in as resources are created; drives the Terraform import phase (objective 13).

| Resource | AWS ID | Planned TF address | Imported |
|---|---|---|---|
| VPC | `vpc-03b6a4b37cf1c9183` | `aws_vpc.main` | ⬜ |
| Public subnet (az1 / euw1-az1) | `subnet-00be20939dfa25198` | `aws_subnet.public["az1"]` | ⬜ |
| Public subnet (az2 / euw1-az2) | `subnet-063f2548f1d3c9c20` | `aws_subnet.public["az2"]` | ⬜ |
| Private subnet (az1 / euw1-az1) | `subnet-030cd17b05d582d90` | `aws_subnet.private["az1"]` | ⬜ |
| Private subnet (az2 / euw1-az2) | `subnet-02d9c09aeec128710` | `aws_subnet.private["az2"]` | ⬜ |
| Internet gateway | `igw-0225dda92419c6318` | `aws_internet_gateway.main` | ⬜ |
| Public route table | `rtb-0356a8d52a6b9eb74` | `aws_route_table.public` | ⬜ |
| Private route table | `rtb-03a24fba42513e950` | `aws_route_table.private` | ⬜ |
| ALB security group | `sg-00776b71913d8fd38` | `aws_security_group.alb` | ⬜ |
| Task security group | `sg-0a74a20cd899f7b06` | `aws_security_group.task` | ⬜ |
| RDS security group | `sg-054c28ee2b5ddfdde` | `aws_security_group.rds` | ⬜ |
| DB subnet group | `breadsheet-dev-db-subnets` | `aws_db_subnet_group.main` | ⬜ |
| RDS instance | `breadsheet-dev-database-1` | `aws_db_instance.main` | ⬜ |

---

## Session log

- _Session 1:_ agreed the approach (hand-build whole stack → import), wrote this runbook, started
  Objective 1.
- _Session 2:_ AWS auth confirmed (`JanoDev`, `eu-west-1`). Decided to keep the default VPC and build
  a dedicated one. Hand-built the whole network foundation (VPC `10.0.0.0/16`, 2 public + 2 private
  subnets across both AZs, IGW, public/private route tables, no NAT) and tagged everything
  `Project=breadsheet`/`Stage=dev`. Claude verified read-only against all done-criteria — **Objective
  1 ✅**, import map filled. Next: Objective 2 (security groups).
- _Session 3:_ Hand-built the three security groups (ALB/Task/RDS) wiring the chain
  `internet → ALB → 3000 → Task → 5432 → RDS`. Internal hops use SG-id references (no CIDRs); RDS SG
  egress stripped to empty (fine — stateful return path). Claude verified read-only against all
  done-criteria — **Objective 2 ✅**, import map updated. Next: Objective 3 (RDS PostgreSQL).
- _Session 4:_ Discussed the no-NAT consequences and DB credential strategy; wrote
  [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md) (SSM password now,
  keyless IAM auth deferred — Prisma driver adapter + `pg` password callback makes it feasible
  without RDS Proxy) and added a Post-build adaptations section. Hand-built RDS: created the DB
  subnet group (private subnets only) first, then `breadsheet-dev-database-1` (`postgres 18.3`,
  `db.t4g.micro`, single-AZ, private, encrypted, RDS SG only, IAM auth on). Claude verified
  read-only against all done-criteria — **Objective 3 ✅**, import map updated. Next: Objective 4
  (container image on GHCR).
- _Session 5:_ Designed the CD pipeline (dev auto-deploy + gated prod promotion via GitHub
  Environment, keyless GitHub-OIDC deployer role, ECS rolling-deploy mechanic, Terraform task-def
  drift) and wrote it up as the [Objective 7](#objective-7--task-definition--cd-pipeline) detail.
  Found Objective 4's premise was false — `build-image.yml` was only on a feature branch and had
  never run. Merged to `main`; first image built (`…/bread-sheet-server:b8ab5ac…` + `:latest`) and
  bumped the workflow actions to Node 24. Package set **Public**; Claude verified anonymous pull and
  read the image config — `linux/amd64`, port `3000`, entrypoint `docker-entrypoint.sh` +
  `node dist/server.js`. **Objective 4 ✅**. Next: Objective 5 (IAM roles — task + execution +
  the GitHub-OIDC deployer role for CD).
