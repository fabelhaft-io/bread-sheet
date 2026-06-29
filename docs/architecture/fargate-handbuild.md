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
| 5  | [IAM roles (task + execution + CI deployer)](#objective-5--iam-roles-task--execution--ci-deployer) | ✅ |
| 6  | [S3 image bucket (+ resize pipeline, reuse TF)](#objective-6--s3-image-bucket)                 | ✅ |
| 7  | [ECS cluster (Fargate)](#objective-7--ecs-cluster-fargate)                                     | ✅ |
| 8  | [Task definition (image, env, secrets, migrate command) + CD pipeline](#objective-8--task-definition--cd-pipeline) | ✅ |
| 9  | [ALB + target group + ACM cert + HTTPS listener](#objective-9--alb--target-group--acm-cert--https-listener) | ✅ |
| 10 | [ECS service (wires task → target group)](#objective-10--ecs-service)                          | ✅ |
| 11 | Route 53 record → ALB (A-alias `server.dev.bread-sheet.com` → ALB)                             | ✅ |
| 12 | [GCP Workload Identity Federation (AWS provider trusting the task role)](#objective-12--gcp-workload-identity-federation) | ✅ |
| 13 | [Secrets in SSM Parameter Store (`DATABASE_URL`, `SUPABASE_*`)](#objective-13--secrets-in-ssm-parameter-store) | ✅ |
| 14 | [Import the hand-built stack into Terraform](#objective-14--import-the-hand-built-stack-into-terraform) | ⬜ |
| 15 | Post Build Adaptions                                                                           | ⬜ |

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
in Objective 13). Tagged `Project=breadsheet` + `Stage=dev`. Verified read-only against every
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
manually now** and store it in **SSM Parameter Store** ([Objective 13](#build-order--status)); do
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
  ([Objective 8](#objective-8--task-definition--cd-pipeline)) overrides this as an ECS `command`;
  check how `docker-entrypoint.sh` forwards its args so `db:deploy` runs before serving.

Because the package is public, the [Objective 5](#build-order--status) execution role needs **no
GHCR pull credentials**. The task definition pins the immutable **`:<git-sha>`** tag.

**Definition of done:**
- [x] CI builds and pushes the server image on merge to `main` — `:<git-sha>` + `:latest`.
- [x] Workflow actions on the Node 24 runtime (no Node 20 deprecation warnings).
- [x] **Package visibility is Public** — anonymous registry pull succeeds (no image-pull secret).

---

## Objective 5 — IAM roles (task + execution + CI deployer)  ✅

**Built:** GitHub OIDC provider `token.actions.githubusercontent.com` exists, plus
three roles — `breadsheet-dev-ecs-execution` (trust `ecs-tasks`, managed
`AmazonECSTaskExecutionRolePolicy`), `breadsheet-dev-ecs-task` (trust `ecs-tasks`, **no policy
yet**), and `breadsheet-dev-deployer` (trust GitHub OIDC `AssumeRoleWithWebIdentity`,
`aud=sts.amazonaws.com` + `sub=repo:fabelhaft-io/bread-sheet:ref:refs/heads/main`; inline
`BreadsheetServerDeployment_DEV` = ECS deploy actions + `iam:PassRole` scoped to the two role ARNs
with `iam:PassedToService=ecs-tasks`). All keyless, all tagged `Project=breadsheet`/`Stage=dev`.
First pass was created with inconsistent names + an execution-policy-on-the-task-role mix-up and a
malformed OIDC `sub` (the console wizard concatenated the repo URL into the path); recreated clean
under the kebab convention. The task role's scoped S3 policy (`PutRawImagesInS3` inline:
`s3:PutObject` on `raw/*`) was added in [Objective 6](#objective-6--s3-image-bucket) once the bucket
existed — **closing the previously-open item**.

**Goal:** three IAM roles, each a least-privilege identity for a different actor, and **zero static
access keys** anywhere (matching the IRSA/WIF keyless posture):
1. **ECS execution role** — assumed by the ECS agent to *set the task up*.
2. **ECS task role** — assumed by the *running container* (the app's own AWS identity).
3. **GitHub-OIDC deployer role** — assumed by GitHub Actions to *deploy* (Objective 8 CD).

**Why this shape — three actors, three identities:** the execution-vs-task split is the single most
confused thing in ECS. The **execution role** is *infrastructure plumbing* — it acts **around** the
container before/while it starts: write CloudWatch logs, and (Objective 13) read the SSM parameters
injected as `secrets`. The **task role** is the *app's* identity **inside** the container — it's
what the code uses to call S3, and the AWS principal **GCP WIF federates** (Objective 12). The
**deployer role** is CI's identity. Keeping them separate means each carries only its own
least-privilege policy, and a leak of one isn't a leak of the others.

**Per role:**

- **Execution role** — trust principal `ecs-tasks.amazonaws.com`. Start from the AWS-managed
  `AmazonECSTaskExecutionRolePolicy` (CloudWatch Logs + ECR pull). **No registry credentials
  needed** — the GHCR package is public ([Objective 4](#objective-4--container-image-on-ghcr)). Add
  SSM `ssm:GetParameters` (+ `kms:Decrypt` if the SecureString uses a CMK) when secrets land in
  Objective 13.
- **Task role** — trust principal `ecs-tasks.amazonaws.com`. Permissions = what the *app* needs:
  scoped S3 access to the images bucket (`raw/*` put, `processed/*` get as the code requires).
  **Record this role's ARN** — Objective 12 (GCP WIF) federates it.
- **Deployer role** — trust a **GitHub OIDC identity provider** (`token.actions.githubusercontent.com`,
  one per account, created first). Trust conditions pin `aud=sts.amazonaws.com` **and** `sub` to
  **this repo** (`repo:fabelhaft-io/bread-sheet:ref:refs/heads/main` for dev; a
  `:environment:production` sub for the gated prod job). Permissions: `ecs:RegisterTaskDefinition`,
  `ecs:UpdateService`, `ecs:DescribeServices`, and `iam:PassRole` **scoped to exactly the task +
  execution role ARNs** (registering a task def passes those two roles — never `Resource: *` here).

**Definition of done:**
- [x] Execution role assumable only by `ecs-tasks.amazonaws.com`; has CloudWatch Logs (base managed
      policy); no GHCR/registry creds (public image).
- [x] Task role assumable only by `ecs-tasks.amazonaws.com` ✓; **S3 access scoped to the images
      bucket** (`PutRawImagesInS3` inline policy, `s3:PutObject` on `raw/*`, added in
      [Objective 6](#objective-6--s3-image-bucket)); ARN `breadsheet-dev-ecs-task` recorded for
      Objective 12.
- [x] A GitHub OIDC provider exists; the deployer role trusts it with `sub` pinned to this repo
      (and branch/environment), `aud=sts.amazonaws.com`.
- [x] Deployer role perms limited to the ECS deploy actions + `iam:PassRole` on **only** the two
      role ARNs (with `iam:PassedToService=ecs-tasks.amazonaws.com`).
- [x] **No IAM user access keys** created for any of this; everything is role assumption.
- [x] All tagged `Project=breadsheet` + `Stage=dev`.

**First-timer tip (not a clickpath):** every role is **two** documents — a **trust policy** (*who
may assume it*) and **permissions policies** (*what it may do*); get both right, they're edited in
different places in the console. Debugging heuristic for later: logs missing or a secret won't
inject → **execution role**; the app gets `AccessDenied` calling S3 → **task role**. For the
deployer, the sharp edge is **`iam:PassRole`** — CI can't register a task def that references the
task/exec roles unless it's explicitly allowed to pass *those ARNs*; scope it, don't wildcard it.
And the OIDC **`sub`** condition is a security control — a loose pattern (e.g. `repo:org/*`) lets
*any* repo/branch assume the role. You can build task + execution roles now; the deployer role can
be built now too but is only exercised once the service exists ([Objective 10](#build-order--status)).

**Verification:** Claude will run `aws iam get-role` / `list-attached-role-policies` /
`list-role-policies` / `get-role-policy` and `aws iam list-open-id-connect-providers` (read-only) to
confirm: each role's **trust principal** is correct (`ecs-tasks` for task/exec; the GitHub OIDC
provider with a repo-scoped `sub` for the deployer), the deployer's `iam:PassRole` `Resource` is
**exactly** the two role ARNs (not `*`), and that **no access keys** exist on any related user.

---

## Objective 6 — S3 image bucket  ✅

**Built (eu-west-1):** bucket `breadsheet-dev-s3-493942067033-eu-west-1-an` (the console's
auto-suggested name — kept; S3 buckets can't be renamed, and the name is config-only since the DB
stores keys not URLs). ACLs **disabled** (`ObjectOwnership=BucketOwnerEnforced`). Block Public
Access set **precisely**: the two ACL blocks ON (`BlockPublicAcls`/`IgnorePublicAcls`), the two
policy blocks OFF (`BlockPublicPolicy`/`RestrictPublicBuckets`) — the minimum to let a scoped public
policy work. Bucket policy `PublicReadAllowProcessed` grants `s3:GetObject` to `Principal:*` on
**`processed/*` only** (no `ListBucket` → no enumeration; `raw/*` stays private; UUID keys are
unguessable). CORS = `GET` from `*`. The deferred task-role policy was added here:
`breadsheet-dev-ecs-task` inline `PutRawImagesInS3` = `s3:PutObject` on `raw/*` **only** — the server
never `GetObject`s (it writes `raw/` and returns the predicted `processed/` key; the device reads
`processed/` directly via `ASSET_BASE_URL`), so no read grant on the task identity. Tagged
`Project=breadsheet` + `Stage=dev`. Verified read-only against every done-criterion.

**Recorded for Objective 8:** `ASSET_BASE_URL =
https://breadsheet-dev-s3-493942067033-eu-west-1-an.s3.eu-west-1.amazonaws.com`, `S3_MODE=aws`.
CloudFront (OAC) deliberately deferred — see [post-build adaptations](#post-build-adaptations) A2.

**Goal:** one private S3 bucket for user-uploaded images, following the app's existing
`raw/{kind}/{uuid}.jpg` (uploads) → `processed/{uuid}.jpg` (resized) **prefix convention**, plus
the scoped task-role S3 policy that was deferred from Objective 5. The bucket is regional
(`eu-west-1`) and depends on nothing else in the stack.

**Why now / why this shape:** the app stores image **keys** in the DB and resolves them at read
time via `ASSET_BASE_URL` (never persists absolute URLs — see CLAUDE.md). So this objective produces
two things the later steps need: the **bucket ARN** (closes the
[Objective 5](#objective-5--iam-roles-task--execution--ci-deployer) task-role S3 item) and the
**`ASSET_BASE_URL`** value the task definition ([Objective 8](#objective-8--task-definition--cd-pipeline))
injects. It's missing from the original build order because the
[plan](cheap-prod-fargate.md) marked `s3.tf`/`lambda.tf` as "reuse as-is" Terraform — but this dev
account has **zero buckets**, so the bucket must actually be created.

**Two parts, different urgency:**
- **The bucket** — do now. Simple, and it unblocks the task role + `ASSET_BASE_URL`.
- **The resize pipeline** (S3 `ObjectCreated` event → resize Lambda → `processed/`, + SQS DLQ) —
  **reuse the existing `terraform/lambda.tf`**, deferrable. The app functions storing `raw/` images
  without it; `processed/` resizing is an enhancement. Don't hand-build it.

**Read-access decision (flag, don't rush):** Block Public Access is **on by default** (correct). To
let the device fetch image URLs you either (a) **keep the bucket private and front it with
CloudFront** (Origin Access Control) — best for caching + security, or (b) add a **scoped public-read
bucket policy** on `processed/*` (+ `raw/*` if needed) — simpler for dev. Recommended: a narrow
public-read policy for dev now, CloudFront as a [post-build adaptation](#post-build-adaptations).
Either way `ASSET_BASE_URL` is `https://<bucket>.s3.eu-west-1.amazonaws.com` (or the CDN domain), and
`S3_MODE=aws`.

**Definition of done:**
- [x] A bucket in `eu-west-1`, tagged `Project=breadsheet` + `Stage=dev`. —
      `breadsheet-dev-s3-493942067033-eu-west-1-an` (console auto-name; not renameable, fine).
- [x] Block Public Access reviewed and set per the decision above (not blindly relaxed). — 2 ACL
      blocks ON, 2 policy blocks OFF; ACLs disabled (`BucketOwnerEnforced`).
- [x] CORS configured for the app if the client GETs images cross-origin. — `GET` from `*`.
- [x] **Task role (`breadsheet-dev-ecs-task`) given a scoped S3 policy** for this bucket ARN
      (`s3:PutObject` on `raw/*`) — **closes the Objective 5 open item**. (No `s3:GetObject` — the
      task never reads; the device reads `processed/*` via the public bucket policy.)
- [x] `ASSET_BASE_URL` value decided and recorded for Objective 8. —
      `https://breadsheet-dev-s3-493942067033-eu-west-1-an.s3.eu-west-1.amazonaws.com`, `S3_MODE=aws`.
- [x] Resize Lambda + SQS: noted as deferred (reuse `terraform/lambda.tf`), not blocking.

**First-timer tip (not a clickpath):** bucket names are **globally unique** and DNS-style
(lowercase, no underscores) — `breadsheet-dev-images`. S3 is **regional** (data lives in
`eu-west-1`) even though the *name* is global. The `raw/`/`processed/` "folders" are just key
prefixes — S3 has no real directories; the bucket is flat storage and the app + Lambda own the
convention. Don't disable Block Public Access wholesale to make images load — that exposes the whole
bucket; scope any public read to a **bucket policy on the specific prefix**, or front with CloudFront.

**Verification:** Claude will run `aws s3api get-bucket-location / get-public-access-block /
get-bucket-policy / get-bucket-cors / get-bucket-tagging` and re-read the task role's inline policy
(read-only) to confirm the bucket is in `eu-west-1`, public access is intentional (not wide open),
and the task role's S3 statement is scoped to this bucket ARN.

---

## Objective 7 — ECS cluster (Fargate)  ✅

**Built (eu-west-1):** cluster `breadsheet-server-dev` — `ACTIVE`, capacity providers `FARGATE` +
`FARGATE_SPOT`, **zero registered container instances** (pure Fargate, no EC2). Container Insights
**disabled** (dev cost choice). Tagged `Project=breadsheet` + `Stage=dev`. First attempt failed on
the **Service Connect namespace** path (it wanted the `AWSServiceRoleForECS_ServiceConnect`
service-linked role, which didn't exist — the base `AWSServiceRoleForECS` SLR *did* auto-create);
deleted that stack and recreated the bare cluster **without a namespace** (we have one service →
ALB, so no service-to-service discovery is needed). The console created it via a **CloudFormation
stack** (`Infra-ECS-Cluster-breadsheet-server-dev-7c4a32c2`) — noted in the import map so Objective
14 deals with the stack (delete-with-retain or leave) rather than letting it fight Terraform.
Verified read-only against every done-criterion.

**Goal:** one ECS **cluster** in `eu-west-1` that runs tasks on **Fargate** (serverless — no EC2
instances to manage), tagged `Project=breadsheet` + `Stage=dev`. This is the logical home the task
definition (Objective 8) and service (Objective 10) will attach to.

**Why this shape — a cluster is just a namespace:** with Fargate there are **no servers in the
cluster**. An ECS cluster is a *logical grouping* + a set of **capacity providers** that tell ECS
*where* to place tasks. For Fargate the providers are **`FARGATE`** (on-demand) and
**`FARGATE_SPOT`** (cheaper, interruptible). The cluster itself **costs nothing** — you pay only for
the vCPU/memory of tasks while they run. So this objective is deliberately small: it unblocks
Objectives 8/10 without committing to anything expensive. Keep it on **`FARGATE`** (on-demand) for
the always-on server task — Spot can evict it; revisit Spot only for throwaway/batch work later.

**Container Insights (cost flag):** enabling Container Insights ships per-task metrics to
CloudWatch, which **costs extra** (custom metrics + logs). For a cheap dev box, **leave it off** (or
the default) — the app's own structured request logs plus the ECS service events are enough to
debug a rollout. Note the choice either way.

**Definition of done:**
- [x] An ECS cluster exists in `eu-west-1`. — `breadsheet-server-dev`, `ACTIVE`.
- [x] It uses the **Fargate** capacity providers (`FARGATE`; `FARGATE_SPOT` may be associated but
      the server task will pin on-demand `FARGATE`). **No EC2/ASG capacity** attached. —
      `FARGATE` + `FARGATE_SPOT`, `registeredContainerInstances=0`.
- [x] Container Insights decision made and noted (recommended **off** for dev cost). — `disabled`.
- [x] Tagged `Project=breadsheet` + `Stage=dev`.

**First-timer tip (not a clickpath):** the console's **"Create cluster"** now defaults to
**AWS Fargate (serverless)** — that's the whole choice; don't add an EC2 instance/Auto Scaling group
(that's the *other*, server-managed ECS mode you're deliberately avoiding). There's nothing to size
here — capacity is decided per-task in Objective 8. This is the cheapest, least-committal step in the
build; its only job is to exist so the service has somewhere to live.

**Verification:** Claude will run `aws ecs describe-clusters` (read-only) and confirm the cluster is
`ACTIVE`, its `capacityProviders` are the Fargate ones (no EC2 capacity), Container Insights matches
the noted decision, and the `Project`/`Stage` tags are present. The import map gets the cluster ARN.

---

## Objective 8 — Task definition + CD pipeline  ✅

> **Part A ✅** (task-def artifact) · **Part B ✅** (dev CD verified — merge to `main` auto-deploys,
> keyless; rev `:6` rolled out Session 14) · **prod promotion deferred** until a prod stage exists.

> Two halves: **(A) the task definition** — the static artifact describing *how to run one task*
> (registered now, inspectable immediately), and **(B) the CD pipeline** that registers new
> revisions on every push. The CD half can only be **tested once the ECS service exists
> (Objective 10)**, so this session does **(A)**; (B) is wired alongside/after Objective 10.

### Part A — the task definition (the artifact)  ✅

**Built:** task def family `breadsheet-dev-server`, **active revision `:5`** — `FARGATE`/`awsvpc`,
`256`/`512`, **X86_64**/LINUX, both role ARNs, image pinned to the full SHA
`:b8ab5acc34e31364dc4b51c0b7a560e213bc5c49`, port `3000`, `command =
["sh","-c","npm run db:deploy && node dist/server.js"]` (migrations ride along), `AWS_REGION=eu-west-1`
+ the S3/mode/deep-link env, the three `/breadsheet/dev/*` SSM secrets, and `awslogs` →
`/ecs/breadsheet-dev-server` (pre-created, 1-day retention, stream-prefix `breadsheet-server`). Modes
are `mock` for the first deploy. Revisions `:1`–`:4` were the iteration: `:2` put the launch line in
`entryPoint` (works — the leftover image `CMD` becomes ignored `sh -c` positional args — but moved to
`command` for cleanliness + Terraform parity) and was missing `AWS_REGION` (the S3 client sets no
region itself → "Region is missing" without it); `:5` fixed both. Verified read-only against every
Part-A done-criterion. **Won't run until the service references it (Objective 10).**

**Goal:** register a Fargate task definition `breadsheet-dev-server` that runs the server container —
pinning the immutable image, splitting plain `environment` from SSM `secrets`, running migrations
before serving, and shipping logs to CloudWatch. Everything it references already exists
(cluster, both roles, image, bucket, secrets).

**Concrete spec (the values are all decided by earlier objectives):**

*Task-level:*
- `family = breadsheet-dev-server`; `requiresCompatibilities = ["FARGATE"]`; `networkMode = awsvpc`.
- `cpu = "256"`, `memory = "512"` — the **smallest Fargate size** (~$9/mo always-on). Bump to
  `512`/`1024` only if the container OOMs (watch the first migrate+boot). `db:deploy` (Prisma
  `migrate deploy`) is light, so 256/512 should hold.
- `runtimePlatform = { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" }` — **X86_64 is
  mandatory**: the image is single-arch `linux/amd64` ([Objective 4](#objective-4--container-image-on-ghcr)).
  ARM64 here would fail to start.
- `executionRoleArn = arn:aws:iam::493942067033:role/breadsheet-dev-ecs-execution` (pulls image,
  reads SSM secrets, writes logs).
- `taskRoleArn = arn:aws:iam::493942067033:role/breadsheet-dev-ecs-task` (the app's identity — S3
  `PutObject`; the principal GCP WIF federates in Objective 12).

*Container `server`:*
- `image = ghcr.io/fabelhaft-io/bread-sheet-server:b8ab5acc34e31364dc4b51c0b7a560e213bc5c49`
  (the current `main` SHA — **pin the full git SHA, never `:latest`**).
- `essential = true`; `portMappings = [{ containerPort: 3000, protocol: "tcp" }]`.
- `command = ["sh","-c","npm run db:deploy && node dist/server.js"]` — **migrations ride along**:
  every task runs `prisma migrate deploy` before serving (Prisma's migration lock keeps the brief
  two-task rolling-deploy overlap safe). The `node:24-alpine` stock entrypoint just `exec`s these
  args; the prisma CLI is present (the Dockerfile keeps devDeps).
- `environment` (plain, non-secret):
  - `PORT=3000`, `NODE_ENV=production`, `LOG_LEVEL=info`
  - **`DB_SSL=verify-full`** — **required** (added Session 15): the runtime `pg` driver adapter
    (`src/db.ts`) does its own TLS, separate from the Prisma migration engine. Without this the app
    throws at startup (fail-fast). `verify-full` verifies the RDS server cert against the CA bundle
    baked into the image (`certs/rds-global-bundle.pem`). Relying on the URL's `sslmode=require`
    instead fails at *query* time (pg ≥ 8.22 treats it as verify-full against the default trust store,
    which lacks the RDS CA → `could not accept SSL connection: EOF`). See [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md).
  - **`AWS_REGION=eu-west-1`** — **required**: `imageService.ts` builds `new S3Client({...})` with
    no region, and ECS does **not** auto-inject one → without it every S3 call throws "Region is
    missing." Do **not** set `AWS_ENDPOINT_URL` (SDK v3 honours it and would misroute S3 off AWS).
  - `S3_MODE=aws`, `S3_BUCKET_NAME=breadsheet-dev-s3-493942067033-eu-west-1-an`,
    `ASSET_BASE_URL=https://breadsheet-dev-s3-493942067033-eu-west-1-an.s3.eu-west-1.amazonaws.com`
  - `VISION_MODE=mock`, `PLAUSIBILITY_MODE=mock` — **mock for the first deploy** so the task is
    decoupled from GCP credentials; flip to `live`/`llm`/`gemini` only after Objective 12 (GCP WIF).
  - `APP_DEEP_LINK_SCHEME=breadsheet` (production build scheme, not the Expo Go `exp+breadsheet`).
  - `ALLOWED_ORIGINS` — optional; CORS only matters for Expo **web** (native RN doesn't enforce it).
    Set to the web origin if/when there is one; the code default (`http://localhost:8081`) is
    harmless for an API the mobile app calls.
- `secrets` (injected from SSM by the execution role — [Objective 13](#objective-13--secrets-in-ssm-parameter-store)):
  - `DATABASE_URL` ← `arn:aws:ssm:eu-west-1:493942067033:parameter/breadsheet/dev/DATABASE_URL`
  - `SUPABASE_URL` ← `…:parameter/breadsheet/dev/SUPABASE_URL`
  - `SUPABASE_PUBLISHABLE_DEFAULT_KEY` ← `…:parameter/breadsheet/dev/SUPABASE_PUBLISHABLE_DEFAULT_KEY`
- `logConfiguration = awslogs` → `awslogs-group=/ecs/breadsheet-dev-server`,
  `awslogs-region=eu-west-1`, `awslogs-stream-prefix=server`.

**Pre-req — create the CloudWatch log group first:** `/ecs/breadsheet-dev-server`. The managed
`AmazonECSTaskExecutionRolePolicy` grants `logs:CreateLogStream` + `logs:PutLogEvents` but **not**
`logs:CreateLogGroup`, so an auto-create would fail — make the group up front (a 1-day/short
retention is fine for dev). Tag it `Project=breadsheet` + `Stage=dev`.

**Definition of done (Part A):**
- [x] CloudWatch log group `/ecs/breadsheet-dev-server` exists (pre-created), 1-day retention.
- [x] Task def `breadsheet-dev-server` registered: `FARGATE`/`awsvpc`, `256`/`512`, **X86_64**,
      both role ARNs set.
- [x] Container pins the **full-SHA** image, exposes `3000`, runs the migrate+serve `command`.
- [x] `environment` includes **`AWS_REGION=eu-west-1`** and the S3/mode/deep-link vars; **no**
      `AWS_ENDPOINT_URL`; modes are `mock` for the first deploy.
- [x] `secrets` map the three `/breadsheet/dev/*` SSM ARNs to env vars.
- [x] `awslogs` configured to the pre-created group. Active revision `:5` recorded for the import map.

**First-timer tip (not a clickpath):** a task definition is **immutable** — every change registers a
new **revision** (`:1`, `:2`, …); the service points at one revision, which is what makes rollback
"point back one." Author it as **JSON registered via `aws ecs register-task-definition
--cli-input-json`** (the JSON maps almost 1:1 to the eventual `aws_ecs_task_definition`, unlike the
console form). The single most common first error is **CPU architecture** (console defaults ARM64 →
the amd64 image won't run) and the second is **forgetting `AWS_REGION`** (above). You can register
and inspect the revision now; it won't *run* until the service (Objective 10) references it.

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
  phase ([Objective 14](#build-order--status)) — likely its own short ADR.

**Definition of done (for the CD half):**
- [x] A GitHub OIDC deployer role exists; Actions assumes it with no static AWS keys. — role
      `breadsheet-dev-deployer`, trust `sub=repo:fabelhaft-io/bread-sheet:ref:refs/heads/main`.
- [x] **`deploy-dev` job written** in `build-image.yml` (`needs: build`): OIDC →
      fetch active task def (`describe-task-definition` + `jq` strip read-only fields) → render the
      `:<sha>` image (`amazon-ecs-render-task-definition`) → `amazon-ecs-deploy-task-definition`
      (`wait-for-service-stability`), `concurrency: deploy-dev`. **Task def is fetched from AWS, not a
      repo file**, so CD only swaps the image and never clobbers the hand-built env/secrets.
- [x] **Deployer policy ARN fixed** (AWS-side): `DeployToService` resource now
      `service/breadsheet-server-dev/breadsheet-dev-server-service` — confirmed working (CD's
      `update-service` succeeded, no `AccessDenied`).
- [x] **Verified on merge to `main`** (Session 14): the run's `build` → `deploy-dev` both succeeded
      keylessly (OIDC); the service rolled to **revision `:6`** (`rolloutState COMPLETED`, running 1)
      pinned to the merge SHA `c5881051…`, and `https://server.dev.bread-sheet.com/` still returns
      `200`.
- [x] Task def pins the immutable `:<git-sha>` tag, not `:latest`. — the render step injects
      `…:${{ github.sha }}`; active rev `:6` image is `…:c5881051…`.
- [ ] Rollback (optional, untested): `aws ecs update-service --task-definition breadsheet-dev-server:5`
      restores the previous image; ECS keeps revisions, so it's a one-liner. Verify when convenient.
- [ ] **Prod (deferred — no prod stage yet):** a gated release (tag/release/dispatch +
      `environment: production` reviewer) promoting the **same `:<sha>`** to the prod service. Build
      when the prod cluster/service exists.

---

## Objective 9 — ALB + target group + ACM cert + HTTPS listener  ✅

> The public front door. Five sub-parts in dependency order: **(9.0) Route 53 hosted zone +
> delegation** → **(9.1) ACM certificate (DNS-validated)** → **(9.2) target group (type IP)** →
> **(9.3) the ALB itself** → **(9.4) listeners (HTTPS:443 + HTTP:80 redirect)**. The zone and the
> cert are the long-pole — DNS delegation + validation propagate on the registrar's clock, not ours,
> so start them first and let them bake while you build the rest.

**Domain decision (Session 11):** domain registered **at an external registrar**; chosen DNS path is
a **Route 53 hosted zone** (AWS owns DNS; registrar delegates via NS records) so ACM validation + the
ALB alias are Route 53 records that import to Terraform. Domain `bread-sheet.com`; dev hostname
**`server.dev.bread-sheet.com`** (mirrors the `breadsheet-server-dev` cluster name; the apex stays free for
whatever else the domain serves). Recommended to delegate the **`dev.bread-sheet.com` subzone** (create the
hosted zone for `dev.bread-sheet.com`, add its 4 NS records at the registrar) — keeps the apex untouched and
scopes AWS DNS to the dev environment. Hosted zone `Z08021021I2ON3AX4JM0` created and **delegation
verified** (registrar NS → Route 53's four nameservers resolve publicly).

**Goal:** an **internet-facing Application Load Balancer** in the two **public** subnets, terminating
**TLS** with an ACM cert for `server.dev.bread-sheet.com`, forwarding to an **IP target group** (`GET /` health check,
port `3000`) that the ECS service (Objective 10) registers tasks into. Port `443` serves; port `80`
301-redirects to `443`.

**Why this shape — the ALB is the one real swap-cost vs EKS, and it earns its ~$16/mo:** it gives a
**stable DNS name + TLS termination + health-checked target replacement**. Fargate task IPs are
ephemeral (every redeploy gets new ENIs), so nothing downstream should ever point at a task directly —
it points at the ALB, and the **ECS service keeps the target group's membership in sync** as tasks
come and go. TLS terminates *at the ALB* (ACM cert), so the container speaks plain HTTP on `3000`
behind it — the app needs no cert handling. This is also why the SG chain
([Objective 2](#objective-2--security-groups)) is shaped the way it is: the ALB SG is the only thing
the internet can reach, and the task SG only accepts `3000` *from the ALB SG*.

**9.0 — Route 53 hosted zone + delegation (do first; it's the long-pole):**
- Create a **public hosted zone** for `bread-sheet.com` (or just `dev.bread-sheet.com` if you want to delegate only
  a subzone and leave the apex untouched at the registrar). Route 53 issues **4 nameservers**.
- At the **external registrar**, set the domain's (or subdomain's) **NS records** to those four.
  Delegation then propagates — minutes to a couple of hours. **Nothing AWS-side is blocked while it
  propagates**, but the cert (9.1) can't validate until it has.
- This zone is also where Objective 11's ALB alias record lands — so Objective 11 effectively folds
  into the tail of this objective.

**9.1 — ACM certificate (DNS-validated, MUST be in `eu-west-1`):**
- Request a public cert in ACM for `server.dev.bread-sheet.com` (add `bread-sheet.com`/wildcard SANs only if you'll use
  them). **Region matters:** an ALB can only use a cert in **its own region** — request it in
  **`eu-west-1`**, *not* `us-east-1` (that habit is for CloudFront; using it here = "cert not
  selectable on the listener").
- Choose **DNS validation**. ACM emits a `CNAME` record; because DNS now lives in Route 53, ACM can
  **create that record for you in one click** (or you add it). Status goes `Pending → Issued` once it
  sees the record (after 9.0's delegation lands). Don't move to the HTTPS listener until **Issued**.

**9.2 — Target group (type IP — this is the Fargate-specific gotcha):**
- ⚠️ **Right service first.** Searching the console for "target group" returns **two** identically
  labelled results: **EC2 → Target groups** (ELBv2 — *this* is the ALB's kind, ARN
  `arn:aws:elasticloadbalancing:…`) and **VPC → Target groups** (**VPC Lattice** — a different
  service-mesh product, ARN `arn:aws:vpc-lattice:…`, **cannot** attach to an ALB). The ALB and its
  target groups all live under the **EC2** topic; the VPC topic owns Lattice. Create the ELBv2 one
  (a Lattice TG was created by mistake first, then deleted).
- **Target type = IP**, *not Instance*. `awsvpc`/Fargate tasks have their own ENI/IP and are **not**
  EC2 instances — an Instance target group can't register them and the service create later just
  fails. Protocol `HTTP`, port `3000`, protocol version **HTTP1** (Express is HTTP/1.1; the ALB still
  serves HTTP/2 to clients and downgrades on the backend hop), in `vpc-03b6a4b37cf1c9183`.
- **Health check: `GET /`, matcher `200`.** Confirmed safe: `app.ts` answers `/` with `200` *before*
  the `/api` rate limiter and with no auth — so health probes never get `429`/`401`. Leave the
  defaults sane (e.g. healthy threshold 2–3, interval 30s); a shorter interval just adds log noise
  (every probe is a `request:finish` line) for no benefit on a single task.
- **Register nothing by hand.** Leave the target group empty — the **ECS service (Objective 10)** is
  what registers/deregisters task IPs. A hand-registered IP would just go stale on the next deploy.

**9.3 — The ALB:**
- **Internet-facing**, IP type `ipv4`, across **both public subnets** (`subnet-00be20939dfa25198`,
  `subnet-063f2548f1d3c9c20`) — an ALB needs ≥2 subnets in different AZs.
- Security group = the **ALB SG** (`sg-00776b71913d8fd38`) — the one already allowing `443` from the
  internet. **Not** the default SG.

**9.4 — Listeners:**
- **HTTPS `:443`** — attach the **Issued** ACM cert; default action **forward** to the 9.2 target
  group. (A modern security policy / `ELBSecurityPolicy-TLS13-*` is fine.)
- **HTTP `:80`** — default action **redirect to HTTPS** (`HTTP_301`, host/path/query preserved). This
  is the moment to **add the `80`-from-internet rule to the ALB SG** that
  [Objective 2](#objective-2--security-groups) deliberately deferred (it noted `80` as "add later with
  the listener").

**Definition of done:**
- [x] Route 53 **public hosted zone** for `dev.bread-sheet.com` (`Z08021021I2ON3AX4JM0`) exists;
      registrar **NS records delegate to Route 53's 4 nameservers** — delegation verified resolving
      (`dig NS dev.bread-sheet.com` → the four `awsdns` nameservers).
- [x] ACM cert for `server.dev.bread-sheet.com` in **`eu-west-1`**, **DNS-validated**, status
      **ISSUED** (validation `CNAME` added via "Create records in Route 53"; issued 2026-06-29, valid
      through 2027-01-13) — `arn:…:certificate/916cc3ff-c297-463d-9b1a-bcab71e5cdb5`.
      `RenewalEligibility=INELIGIBLE` until attached to the ALB listener (9.4).
- [x] **IP** target group, protocol `HTTP` port `3000` (HTTP1), in the VPC, health check `GET /`
      matcher `200`; **left empty** (ECS service registers targets in Objective 10). —
      `breadsheet-dev-alb-target-group/7d12e1f454011d54`; healthy threshold left at default `5`
      (~2.5 min to first-healthy — optionally lower to 2–3 for snappier deploys).
- [x] **Internet-facing** ALB across **both public subnets**, attached to the **ALB SG** (not
      default), tagged `Project=breadsheet` + `Stage=dev`. — `breadsheet-dev-alb`, IPv4, DNS
      `breadsheet-dev-alb-1430077274.eu-west-1.elb.amazonaws.com` (canonical zone `Z32O12XQLNTSW2`).
- [x] **HTTPS:443** listener forwards to the target group using the Issued cert (TLS1.3 policy
      `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09`).
- [x] **HTTP:80** redirect — added: `:80 → 301 HTTPS:443` (host/path/query preserved) + ALB SG `80`
      ingress from `0.0.0.0/0` **and** `::/0` (symmetric with the `443` rule).
- [x] ALB DNS name + canonical zone ID, target-group ARN, cert ARN, hosted-zone ID recorded for the
      import map (and Objective 11's alias record).

**First-timer tip (not a clickpath):** build it **bottom-up** in the console — the create-ALB wizard
asks for a listener, the listener asks for a target group, so **make the target group first** (you
can't pick "IP" retroactively). The single most common dead-end here is **a task that never goes
healthy**, and it's almost always one of three things: target-group type wasn't **IP**, the **task
SG** doesn't allow `3000` *from the ALB SG* (it does — Objective 2), or the **health-check path** 404s
(it won't — `/` returns 200). The cert won't appear on the `:443` listener dropdown until it's
**Issued** *and* in **eu-west-1** — if it's missing, check the region first. Don't register targets
yourself — an empty target group is **correct** at this stage; it lights up in Objective 10.

**Verification:** Claude will run (read-only) `aws route53 list-hosted-zones` +
`list-resource-record-sets` (NS delegation + validation CNAME), `aws acm describe-certificate`
(`Status=ISSUED`, `DomainName=<HOSTNAME>`, region `eu-west-1`), `aws elbv2 describe-load-balancers`
(scheme `internet-facing`, the two public subnets, ALB SG), `describe-target-groups` (`TargetType=ip`,
port `3000`, health-check path `/`), and `describe-listeners` (`:443` forward w/ cert ARN; `:80`
redirect to HTTPS). It will also confirm the ALB SG now has the `80` ingress. Import map gets the ALB,
target group, listeners, cert, and hosted zone.

---

## Objective 10 — ECS service  ✅

**Built:** service `breadsheet-dev-server-service` on cluster `breadsheet-server-dev` —
`arn:…:service/breadsheet-server-dev/breadsheet-dev-server-service`. `FARGATE`, desired/running `1`,
task def `breadsheet-dev-server:5`, `awsvpc` across both public subnets with the Task SG only and
**`assignPublicIp=ENABLED`**, LB-wired to the target group (`server:3000`), grace period `120s`,
deployment circuit breaker + rollback on. **First real task start succeeded end-to-end:** image
pulled from GHCR, SSM secrets injected, `db:deploy` **connected to RDS and applied all 10 migrations**
(closes the [Objective 3](#objective-3--rds-postgresql)/[13](#objective-13--secrets-in-ssm-parameter-store)
`DATABASE_URL` verification), `Server running on port 3000`, target **healthy**. Verified the full
path with curl: `http://…:80` → `301` HTTPS, and `https://server.dev.bread-sheet.com/` (SNI) →
valid cert + `200 Bread Sheet API is running`. The initial `unhealthy` was just the registration
window (app needs ~150s of passing checks after the ~90s migrate+boot — the 120s grace kept ECS from
killing it). **Note for 8B:** actual service name is `breadsheet-dev-server-service`, so the deployer
policy's `UpdateService` resource must be `service/breadsheet-server-dev/breadsheet-dev-server-service`
(currently the stale `service/breadsheet-dev/breadsheet-dev-server`).

> **The milestone of the whole build** — the first time a real task starts. The service is the
> controller that turns the static task definition into a *running, self-healing* task, keeps the ALB
> target group in sync as tasks churn, and runs rolling deploys. Creating it **is the first deploy**
> (done by hand); [Objective 8B](#objective-8--task-definition--cd-pipeline) later automates every
> subsequent one. Everything it references already exists (cluster, task def `:5`, target group,
> roles, secrets, RDS).

**Goal:** an ECS **service** `breadsheet-dev-server` on cluster `breadsheet-server-dev`, launch type
**FARGATE**, running **1** copy of task def `breadsheet-dev-server:5`, placed in the **public** subnets
with the **Task SG** and a **public IP**, wired to the ALB **target group** so the container's `3000`
receives traffic once `GET /` is healthy.

**Why a service (not `run-task`):** a one-off `run-task` starts a container and walks away. A
**service** is a *control loop* — it maintains the desired count (restarts a crashed/killed task),
**registers each task's IP into the target group** (and deregisters on stop), and orchestrates
**rolling deploys** (start new revision → wait for target health → drain old). This is the piece that
makes the ALB's empty target group fill itself and stay correct forever.

**Concrete spec (all values decided by earlier objectives):**
- **Cluster** `breadsheet-server-dev`; **launch type** `FARGATE` (on-demand, *not* SPOT for an
  always-on API); **platform version** `LATEST`.
- **Task definition** `breadsheet-dev-server:5`; **desired count** `1` (dev — one task).
- **Network (`awsvpc`):**
  - **Subnets:** the **two public** subnets (`subnet-00be20939dfa25198`, `subnet-063f2548f1d3c9c20`).
  - **Security group:** the **Task SG** (`sg-0a74a20cd899f7b06`) **only** — not the default SG.
  - **`assignPublicIp = ENABLED`** ← ⚠️ **the single most important setting.** With **no NAT**
    ([Objective 1](#objective-1--network-foundation-vpc)), the task's only route to the internet is its
    own public IP via the IGW. It needs that route at **startup** to pull the image from GHCR and for
    the **execution role** to fetch SSM secrets / write CloudWatch logs — *and* at runtime to reach
    Supabase/GCP. `DISABLED` here = task can't pull its image or its secrets and never starts.
- **Load balancer wiring:** attach **target group**
  `breadsheet-dev-alb-target-group/7d12e1f454011d54`, **container `server`**, **port `3000`**. (The
  service registers task IPs into it — you don't.)
- **Health-check grace period: ~120 s.** ← the second critical setting. The container runs
  `npm run db:deploy && node dist/server.js` — so it spends the first chunk of its life **migrating,
  not listening on 3000**. Without a grace period the ALB marks the task unhealthy during migration
  and ECS kills it before it ever serves (a restart loop that looks like a health-check failure but is
  really "killed too early"). The grace period tells ECS to ignore ALB health during initial boot.
- **Deployment:** rolling (ECS), `minimumHealthyPercent=100` / `maximumPercent=200` (briefly runs a
  2nd task during deploys — the Prisma migration lock keeps the migrate-on-boot overlap safe). **Enable
  the deployment circuit breaker with rollback** — on a failed rollout ECS auto-reverts to the last
  good revision instead of churning. Recommended for dev.
- **Tags** `Project=breadsheet` + `Stage=dev`.

**What this first start actually tests (it closes several deferred verifications):**
- **Image pull** from GHCR (public, `linux/amd64` ↔ task `X86_64`) over the public IP + IGW.
- **SSM secret injection** by the execution role — closes the [Objective 13](#objective-13--secrets-in-ssm-parameter-store)
  "value never decrypted/tested" item: if `DATABASE_URL` et al. are wrong, the task fails to start.
- **`DATABASE_URL` correctness + RDS reachability** — `db:deploy` runs `prisma migrate deploy`, which
  *actually connects* to RDS over `5432` (Task SG → RDS SG). First proof the endpoint/password/`sslmode`
  from [Objective 3](#objective-3--rds-postgresql)/13 are right.
- **`AWS_REGION`** present (the S3 client) and the app boots and answers `GET /` → `200`.

**Failure-mode playbook (this is where you'll actually debug):**
- **Task never reaches `RUNNING` (PENDING → STOPPED):** read `describe-tasks` → `stoppedReason` +
  the container `reason`.
  - `CannotPullContainerError` → `assignPublicIp` not ENABLED (no route to GHCR), or an arch mismatch
    (must be X86_64 — it is), or GHCR transient.
  - `ResourceInitializationError: unable to pull secrets` → execution role can't reach SSM (no public
    IP) or a wrong parameter ARN in the task def.
- **Task `RUNNING` but target `unhealthy` / task cycling:** read the **CloudWatch logs**
  (`/ecs/breadsheet-dev-server`) and the **service events**.
  - Migrations error / `db:deploy` exits non-zero → container exits → task STOPPED. Almost always a
    **`DATABASE_URL`** problem (host, password, `sslmode=require`) or RDS not reachable. The logs show
    the Prisma error.
  - Healthy app but killed mid-migration → **raise the grace period**.
- **Rollout never stabilizes** → the circuit breaker rolls back; read `describe-services` → `events[]`
  (plain-English narration of every placement decision).

**Definition of done:**
- [x] Service `breadsheet-dev-server-service` on `breadsheet-server-dev`, `FARGATE`, desired count
      `1`, task def `breadsheet-dev-server:5`.
- [x] `awsvpc`: **both public subnets**, **Task SG only**, **`assignPublicIp=ENABLED`**.
- [x] Load balancer attached: target group `…/7d12e1f454011d54`, container `server`, port `3000`.
- [x] Health-check grace period set (`120 s`) to cover migrate+boot.
- [x] Deployment circuit breaker + rollback enabled; rolling `100/200`.
- [x] **One task `RUNNING`, target `healthy`** — `curl http://<alb-dns>/` → `301`→HTTPS, and
      `https://server.dev.bread-sheet.com/` (SNI via `--connect-to`, pre-DNS) → valid cert + `200`.
- [x] `db:deploy` succeeded in the logs (**closed the Objective 3/13 `DATABASE_URL` verification**).
- [x] Service tagged `Project=breadsheet` + `Stage=dev`; service ARN recorded for the import map.
- [ ] **Deployer policy ARN to correct** for 8B: `service/breadsheet-server-dev/breadsheet-dev-server-service`
      (currently the stale `service/breadsheet-dev/breadsheet-dev-server` — wrong cluster **and** wrong
      service name; CD would `AccessDenied`). Do this when wiring 8B.

**First-timer tip (not a clickpath):** two settings cause ~all first-start failures and both are easy
to miss — **`assignPublicIp=ENABLED`** (no NAT means no image, no secrets without it) and the
**health-check grace period** (migrations run before the app listens). Keep **desired count at 1**
while iterating so there's one task and one log stream to read. The console "Create service" flow is
fine here, but the values map 1:1 to `aws ecs create-service` / the eventual `aws_ecs_service`. Don't
register anything in the target group by hand — the service does it; if the target group stays empty
after the task is RUNNING, the **load-balancer wiring on the service** is missing, not the target
group. Name the service **`breadsheet-dev-server`** so it matches the task-def family and the (to-be-
corrected) deployer ARN.

**Verification:** Claude will run (read-only) `aws ecs describe-services` (running/desired count +
`events[]`), `aws ecs list-tasks`/`describe-tasks` (task `RUNNING`, `assignPublicIp`, attached SG +
subnets, `stoppedReason` if any), `aws elbv2 describe-target-health` (target `healthy`), and
`aws logs tail /ecs/breadsheet-dev-server` (migration success + clean boot). It will confirm the
service is wired to the target group with container `server:3000` and that the first task serves
`GET /` → `200`. Import map gets the service ARN.

---

## Objective 12 — GCP Workload Identity Federation  🔄

> **12a (GCP federation) ✅** — pool `breadsheet-dev` + AWS provider `aws-ecs` (scoped to the task
> role), SA `breadsheet-dev-vision` (`aiplatform.user`), `workloadIdentityUser` bound to the task-role
> principalSet. **12b (app wiring + mode flip) ⬜.**

> Keyless GCP access from the Fargate task — so the app calls **Vertex AI (Gemini)** and **Cloud
> Vision** as a GCP service account **without any service-account key**, using its **AWS task-role
> identity** as the federation source. Two halves: **(12a) the GCP federation** (hand-build — the
> focus of this objective) and **(12b) the app credential wiring** (a code change, with a real
> Fargate-specific gotcha). The existing `terraform/gcp-wif.tf` is the **EKS/OIDC** variant — it
> federates a Kubernetes SA token; Fargate needs a different trust source (an **AWS provider**), so
> this is a parallel build, not a reuse.

**Why WIF (and why an AWS provider):** the app authenticates to GCP purely through **ADC**
(`geminiClient.ts` → `new GoogleGenAI({ vertexai: true })`; `visionService.ts` → `new
ImageAnnotatorClient()` — both implicit). In prod, ADC must resolve to a **keyless** credential. WIF
lets GCP **trust an external identity** and exchange it for a short-lived token that **impersonates a
GCP service account** — no key ever created. For EKS the external identity was a k8s OIDC token; on
Fargate it's the **AWS task role**, so the WIF pool needs an **AWS provider** (GCP trusts an AWS
account + verifies an STS `GetCallerIdentity` the caller signs with its AWS creds).

**The runtime chain (what happens on a Gemini/Vision call):**
1. The container holds the **task role** (`breadsheet-dev-ecs-task`) creds via the ECS container
   credentials endpoint.
2. Google ADC signs an STS `GetCallerIdentity` request with those AWS creds and presents it to **GCP
   STS** (`sts.googleapis.com`).
3. GCP STS verifies it against the pool's **AWS provider** (trusts account `493942067033`), checks
   the **attribute condition** (only the task role), and returns a **federated token**.
4. That token **impersonates** the GCP SA (`roles/iam.workloadIdentityUser`), which carries
   `roles/aiplatform.user` + `roles/cloudvision.user`.
5. The app calls Vertex/Vision **as the SA**. No key, no static secret.

### 12a — the GCP federation (hand-build)

GCP context: project `breadsheet-496522` (number **`1054240616692`**); APIs `aiplatform`, `vision`,
`iam`, `iamcredentials` already enabled — **also enable `sts.googleapis.com`** (the token-exchange
endpoint). Build:

- **Workload Identity Pool** — e.g. `breadsheet-dev` (no pool exists yet).
- **AWS provider** in the pool — `--account-id=493942067033`. **Scope it to the task role** with an
  **attribute condition** so *only* `breadsheet-dev-ecs-task` can federate, not every role in the
  account, e.g.
  `assertion.arn.startsWith('arn:aws:sts::493942067033:assumed-role/breadsheet-dev-ecs-task/')`.
  Map `google.subject = assertion.arn` (+ the `attribute.aws_role` mapping for the principal below).
- **Service account** `breadsheet-dev-vision` — grant `roles/aiplatform.user` (Vertex/Gemini).
  **Note:** `roles/cloudvision.user` **does not exist** (the EKS `gcp-wif.tf` references it — a latent
  bug to fix before import). Cloud Vision (`VISION_MODE=live`) does **no resource-level IAM** — it's
  authorized by API-enablement + an authenticated SA + billing, so a same-project SA needs no Vision
  role. If a live OCR call ever 403s, add `roles/serviceusage.serviceUsageConsumer` — not
  speculatively.
- **Impersonation binding** — grant `roles/iam.workloadIdentityUser` on that SA to the **task-role
  principalSet**:
  `principalSet://iam.googleapis.com/projects/1054240616692/locations/global/workloadIdentityPools/breadsheet-dev/attribute.aws_role/arn:aws:sts::493942067033:assumed-role/breadsheet-dev-ecs-task`.

This is two layers of scoping (provider attribute condition **and** the principalSet on the binding)
— both pin the trust to exactly the Fargate task role.

### 12b — app credential wiring (code change) + the Fargate gotcha

The app reaches GCP via ADC, normally pointed at a **WIF credential-config JSON**
(`GOOGLE_APPLICATION_CREDENTIALS`) generated by
`gcloud iam workload-identity-pools create-cred-config … --aws`. That JSON holds **no secret** — just
the pool/provider/SA references + instructions for *where to get the AWS creds*.

⚠️ **The Fargate gotcha — the cred-config's default AWS source doesn't work on Fargate.** The `--aws`
cred-config emits **EC2 IMDS** URLs (`169.254.169.254`) to fetch the AWS creds + region. **Fargate
does not serve task-role creds via IMDS** — they come from the **container credentials endpoint**
(`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `169.254.170.2`). Google's auth library uses AWS **env
vars** if present, else **IMDS** — and on Fargate *neither* is populated, so the out-of-the-box
cred-config fails to fetch creds.

**Resolution — a programmatic AWS credential supplier.** Construct a `GoogleAuth` / external-account
client with a custom **`AwsSecurityCredentialsSupplier`** backed by `@aws-sdk/credential-providers`
(`fromContainerMetadata()` / `fromNodeProviderChain()` — these natively read the ECS container
endpoint), and pass that auth into the genai + Vision clients instead of relying on implicit ADC. This
is a small change to `geminiClient.ts` + `visionService.ts` (inject a shared auth). With the supplier
in code, you may not need the JSON file at all — the pool/provider/SA + supplier can be configured
programmatically.

**Then flip the env** (task-def `environment`, plain — not secrets): `GOOGLE_GENAI_USE_VERTEXAI=true`,
`GOOGLE_CLOUD_PROJECT=breadsheet-496522`, `GOOGLE_CLOUD_LOCATION=europe-west1`, and move
`VISION_MODE`/`PLAUSIBILITY_MODE` off `mock` (`llm`/`gemini`). Ship via the CD pipeline (Objective 8B).

**Staged approach (recommended):** build + verify **12a** first (the GCP side is independently
checkable), then do **12b** (supplier + flip modes) as its own change so a federation bug and a
code bug don't tangle.

**Definition of done:**
- [x] `sts.googleapis.com` enabled; Workload Identity Pool `breadsheet-dev` exists (ACTIVE).
- [x] An **AWS provider** `aws-ecs` (`account-id=493942067033`) with an **attribute condition**
      scoping to `assumed-role/breadsheet-dev-ecs-task` only (verified ACTIVE).
- [x] SA `breadsheet-dev-vision` with `roles/aiplatform.user` (Vertex/Gemini). Cloud Vision needs no
      role — `roles/cloudvision.user` doesn't exist; API-enablement + authenticated SA suffices.
- [x] `roles/iam.workloadIdentityUser` bound to the **task-role principalSet** on that SA (verified).
- [x] App wired (`services/gcpWorkloadIdentity.ts`): a google-auth `AwsClient` with a programmatic
      `AwsSecurityCredentialsSupplier` backed by the AWS SDK default provider chain (reads the ECS
      container endpoint, **not** IMDS). Injected into the genai (`googleAuthOptions.authClient`) +
      Vision (`{ authClient }`) clients; `null` → default ADC locally. Added
      `@aws-sdk/credential-provider-node` dep. Typecheck + full suite green (413 tests, incl. new
      `gcpWorkloadIdentity.test.ts`). **Not yet deployed.**
- [x] Task-def env flipped (plain `environment`): `GOOGLE_GENAI_USE_VERTEXAI=true`,
      `GOOGLE_CLOUD_PROJECT=breadsheet-496522`, `GOOGLE_CLOUD_LOCATION=europe-west1`,
      `GCP_WORKLOAD_IDENTITY_AUDIENCE=//iam.googleapis.com/projects/1054240616692/locations/global/workloadIdentityPools/breadsheet-dev/providers/aws-ecs`,
      `GCP_SERVICE_ACCOUNT_EMAIL=breadsheet-dev-vision@breadsheet-496522.iam.gserviceaccount.com`, and
      `PLAUSIBILITY_MODE=gemini` / `VISION_MODE=llm` (off `mock`). **Deploy the code first**, then flip.
- [x] **End-to-end:** an upload exercising plausibility/extraction succeeds against real
      Vertex/Vision (logs show a successful call, no auth error).
- [ ] WIF pool/provider/SA recorded for the import map.

**First-timer tip (not a clickpath):** the mental flip from the EKS setup is the **trust source** —
*OIDC token* (k8s) becomes *AWS STS identity* (the task role), so it's a **`create-aws`** provider,
not `create-oidc`. Scope it to the **one role** (attribute condition) — an unscoped AWS provider
trusts *every* identity in the account. The single thing that will bite you is the **IMDS-vs-container
endpoint** gap above: a cred-config that works on your laptop/EC2 will silently fail on Fargate until
the programmatic supplier is in place — so verify the GCP side independently first, then expect to
touch app code for 12b. Keep the Vertex **location** to a Gemini-supported region (`europe-west1`).

**Verification:** Claude will run (read-only) `gcloud iam workload-identity-pools describe` +
`… providers describe` (account-id + attribute condition), `gcloud iam service-accounts get-iam-policy`
(the `workloadIdentityUser` binding to the task-role principalSet) and
`gcloud projects get-iam-policy` (the SA's `aiplatform.user`/`cloudvision.user`). The true end-to-end
proof is a real upload after 12b — checking the task logs for a successful Vertex/Vision response.

---

## Objective 13 — Secrets in SSM Parameter Store  ✅

> Pulled forward (before Objectives 8–10) because the task definition's `secrets` block references
> these parameter ARNs — the secrets must exist before the task def can name them.

**Built (eu-west-1, Standard tier — free):** three parameters under `/breadsheet/dev/` —
`DATABASE_URL` (**SecureString**, default `alias/aws/ssm` key → no `kms:Decrypt` grant needed),
`SUPABASE_URL` + `SUPABASE_PUBLISHABLE_DEFAULT_KEY` (**String**; publishable key isn't secret).
All tagged `Project=breadsheet` + `Stage=dev`. Execution role `breadsheet-dev-ecs-execution` got an
inline policy `GetDevEnvVariablesFromSystemsManagerParameterStore` (`ssm:GetParameters` scoped to
`…:parameter/breadsheet/dev/*`, not `*`) — **closes the Objective 5 SSM open item**. Verified
read-only **without decryption** (names/types/tier/KMS key + the role policy); the `DATABASE_URL`
*value* is unverifiable until a task connects to RDS at Objective 10. ARNs in the import map.

**Goal:** the sensitive / env-specific runtime config lives in **SSM Parameter Store** under a
hierarchical path (`/breadsheet/dev/*`), and the **execution role** is granted scoped
`ssm:GetParameters` on that path — closing the SSM item deferred from
[Objective 5](#objective-5--iam-roles-task--execution--ci-deployer). At minimum: `DATABASE_URL`
(SecureString), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`.

**Why SSM (not Secrets Manager):** Parameter Store **Standard tier is free** (SecureString included)
— Secrets Manager charges ~$0.40/secret/mo + API calls and adds rotation we don't need. ECS injects
both the same way (task-def `secrets` → env var in the container), so SSM is the cheaper equivalent.
This is the same call already made for the RDS password in
[ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md).

**Why the execution role (not the task role):** secrets are resolved **at container start**, by the
ECS agent — that's the **execution** role's job (the same role that pulls the image and writes logs).
The app code never calls SSM itself, so the **task** role gets nothing here.

**Secret vs plain — only sensitive values belong here:** `DATABASE_URL` is the one true secret
(carries the DB password) → **SecureString**. `SUPABASE_URL` and the **publishable** key are
env-specific but **not secret** (the publishable key is designed to ship in the app bundle) — keep
them here as plain **String** for centralisation, or push them to the task-def `environment` later;
either is fine. Non-sensitive config (`PORT`, `NODE_ENV`, `S3_MODE`, `S3_BUCKET_NAME`,
`ASSET_BASE_URL`, `LOG_LEVEL`, `VISION_MODE`, `PLAUSIBILITY_MODE`, `APP_DEEP_LINK_SCHEME`, and the
Vertex/WIF trio) stays as plain `environment` in the task def — don't pay the indirection for
non-secrets.

**`DATABASE_URL` value:** assemble from Objective 3 —
`postgresql://<master_user>:<password>@breadsheet-dev-database-1.cna48wy46m01.eu-west-1.rds.amazonaws.com:5432/breadsheet?sslmode=require`.
The password is the one you set manually on the RDS instance. (Can't be smoke-tested until a task can
reach RDS — verified at [Objective 10](#build-order--status).)

**KMS:** store SecureString under the **default `alias/aws/ssm`** AWS-managed key (free; its key
policy lets in-account SSM callers decrypt, so the execution role needs **no extra `kms:Decrypt`**).
Only a customer-managed CMK would require adding `kms:Decrypt` to the execution role.

**Definition of done:**
- [x] `DATABASE_URL` exists as a **SecureString** at `/breadsheet/dev/DATABASE_URL`
      (default `aws/ssm` key), value assembled from the RDS endpoint + master creds. — key
      `alias/aws/ssm` confirmed; value not decrypted (tested at Objective 10).
- [x] `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_DEFAULT_KEY` exist under `/breadsheet/dev/` (String).
- [x] Execution role (`breadsheet-dev-ecs-execution`) has an inline policy granting
      `ssm:GetParameters` scoped to `arn:aws:ssm:eu-west-1:493942067033:parameter/breadsheet/dev/*`
      (no `kms:Decrypt` needed for the `aws/ssm` key) — **closes the Objective 5 SSM item**. —
      `GetDevEnvVariablesFromSystemsManagerParameterStore`.
- [x] Parameters tagged `Project=breadsheet` + `Stage=dev` (Standard tier — free).
- [x] Parameter ARNs recorded for the Objective 8 task-def `secrets` block + the import map.

**First-timer tip (not a clickpath):** prefer the **CLI** for the SecureString so the DB password
isn't pasted into a browser field — and pass the value via a file or `--cli-input-json`, not inline,
so it doesn't land in shell history (`aws ssm put-parameter --type SecureString`). The **hierarchical
path** (`/breadsheet/dev/NAME`) is the trick that makes the execution-role grant a single scoped
wildcard (`…:parameter/breadsheet/dev/*`) instead of one ARN per secret. Standard tier (≤4 KB,
free) is plenty — don't pick Advanced. Note the `DATABASE_URL` parameter *name* you pick — the
task-def `secrets` block maps `valueFrom: <parameter ARN>` → the container env var.

**Verification:** Claude will run `aws ssm describe-parameters` + `get-parameters-by-path` (read-only,
**without** `--with-decryption` — never prints secret values) to confirm the three names/types/tier
exist under `/breadsheet/dev/`, and re-read the execution role's inline policy
(`aws iam get-role-policy`) to confirm `ssm:GetParameters` is scoped to the `/breadsheet/dev/*` ARN
(not `*`). Import map gets the parameter ARNs + the new execution-role policy.

---

## Objective 14 — Import the hand-built stack into Terraform  ⬜

> The payoff of the whole build: bring every hand-built **dev** resource under Terraform **in place**
> (no recreate — dev keeps serving), driving `terraform plan` to a **zero-diff no-op**. The
> [import map](#import-map) already lists all ~35 resources with their AWS IDs and planned TF
> addresses — this objective turns that table into HCL + state, slice by slice in dependency order.

**Decisions locked in (Session 16):**
- **Import in place, never recreate.** Dev is live (`https://server.dev.bread-sheet.com/` → `200`); we
  *adopt* the running resources into state, we do **not** destroy/re-apply them.
- **Raw resources, no modules.** Drop the `terraform-aws-modules/{vpc,eks,rds}` modules — the import map
  targets raw addresses (`aws_vpc.main`, `aws_subnet.public["az1"]`), and raw resources import cleanly
  one-to-one. Modules scatter dozens of internal addresses (`module.vpc.aws_subnet.public[0]`, …) that
  are painful to import and re-key.
- **Delete the EKS stack** (`eks.tf`, `irsa.tf`, `k8s/`, the OIDC-variant `gcp-wif.tf`, and the `local`
  env files). It describes the abandoned EKS design and was **never applied** to this account — deleting
  it destroys nothing real. The learning value stays in git history; **tag the pre-deletion commit**
  (`git tag eks-architecture <sha>`) so it's one `git checkout` away. (Genuine EKS practice belongs in a
  throwaway/dedicated project where it can actually be `apply`-ed cheaply, not as dead HCL here.)
- **Two cloud environments only: `dev` (filled now) + `prod` (scaffolded, deferred).** Drop the `local`
  Terraform environment — LocalStack Community can't emulate ECS/ALB/ACM/Route 53/RDS, so `terraform
  apply` there would test almost nothing; local dev already runs on docker-compose +
  `scripts/localstack-init.sh`, which stays **untouched**. Removing local-TF also lets us **delete the
  entire `is_local` / `cloud_count` / LocalStack-endpoints machinery** from `main.tf`/`locals.tf` — a
  real simplification, not just a deletion.

**Goal:** a single `terraform/` root that describes **exactly the deployed dev Fargate stack** (and a
deferred `prod` stage), with `terraform plan` reporting **no changes** after every resource in the
[import map](#import-map) is imported. Terraform then owns the infrastructure; the
[CD pipeline](#objective-8--task-definition--cd-pipeline) keeps owning task-def revisions.

**Why import (not recreate), and why `import {}` blocks:** recreating would tear down a working,
DNS-fronted, certificate-validated service — pointless churn and downtime for resources that already
exist correctly. Terraform `>= 1.10` (already pinned in `main.tf`) supports **declarative `import {}`
blocks** + **`terraform plan -generate-config-out=generated.tf`**: we write an `import` block per
import-map row (the AWS IDs are all recorded), let Terraform **generate a first draft of the HCL**, then
hand-refine it to idiomatic config and drive the post-import `plan` to **zero diff**. That turns ~35
imports from "hand-write HCL blind" into "review and tidy generated HCL." A non-empty diff after import
is the signal the HCL doesn't yet match reality — fix the HCL, never `apply` it away.

**Target file layout (after the rewrite):**
```
terraform/
  main.tf       # providers (aws + google) only — no LocalStack/is_local machinery
  variables.tf  # trimmed to what the Fargate stack needs
  locals.tf     # name_prefix + tags; no cloud_count / is_local
  backend.tf    # S3 remote state, per-env keys (dev, prod)
  network.tf    # raw aws_vpc / aws_subnet / aws_internet_gateway / aws_route_table(+assoc) — NO NAT
  security.tf   # aws_security_group {alb, task, rds} + cross-referencing rules
  rds.tf        # aws_db_subnet_group + aws_db_instance (breadsheet-dev-database-1)
  iam.tf        # exec / task / deployer roles, their policies, the GitHub OIDC provider
  s3.tf         # images bucket + public-access-block + ownership + policy + cors
  ssm.tf        # 3 /breadsheet/dev/* params + exec-role SSM inline policy
  ecs.tf        # aws_ecs_cluster + aws_ecs_task_definition + aws_ecs_service
  alb.tf        # aws_lb + target group + 443/80 listeners + aws_acm_certificate(+validation)
  dns.tf        # aws_route53_zone (dev) + A-alias record → ALB
  gcp-wif.tf    # REWRITTEN: AWS-provider WIF (pool + aws provider + SA + bindings) — not OIDC/IRSA
  environments/{dev,prod}.tfvars + {dev,prod}.s3.tfbackend
  # DELETED: eks.tf, irsa.tf, k8s/, lambda.tf(local path), environments/local.*
```

**Import order — slice by the build/dependency graph** (the same order this runbook was built; `plan`
to a no-op after each slice, then commit):

1. **Bootstrap** — confirm the S3 remote-state backend + `dev` key exist (`backend.tf` /
   `environments/dev.s3.tfbackend`); `terraform init`. Delete the EKS/local files; **tag the old commit**.
   Strip the `is_local`/`cloud_count` machinery from `main.tf`/`locals.tf`.
2. **Network** — `aws_vpc.main`, the 4 subnets, `aws_internet_gateway.main`, the 2 route tables (+ their
   default route + subnet associations).
3. **Security groups** — `aws_security_group.{alb,task,rds}` + the SG-referencing ingress rules.
4. **RDS** — `aws_db_subnet_group.main`, `aws_db_instance.main`.
5. **IAM** — `aws_iam_openid_connect_provider.github`, the exec/task/deployer roles + their inline/managed
   policy attachments.
6. **S3** — bucket + `aws_s3_bucket_public_access_block` + `aws_s3_bucket_ownership_controls` +
   `aws_s3_bucket_policy` + `aws_s3_bucket_cors_configuration`.
7. **SSM** — the 3 parameters + the exec-role SSM policy (see the `DATABASE_URL`-in-state edge below).
8. **ECS** — `aws_ecs_cluster.main`, `aws_ecs_task_definition.server`, `aws_ecs_service.server`
   (see the task-def-drift + CFN-stack edges below).
9. **ALB / ACM** — `aws_lb.main`, `aws_lb_target_group.server`, the `:443`/`:80` listeners,
   `aws_acm_certificate.server` (+ its validation record).
10. **DNS** — `aws_route53_zone.dev`, the `server.dev.bread-sheet.com` A-alias record.
11. **GCP WIF** — pool + AWS provider + SA + the two bindings (HCL rewritten from the EKS variant).

**Three edges to decide as we hit them (all already flagged in this runbook):**

- **Task-def drift — `ignore_changes`.** [CD](#objective-8--task-definition--cd-pipeline) registers a new
  task-def revision on every push, *outside* Terraform. Put `lifecycle { ignore_changes = [task_definition] }`
  on `aws_ecs_service.server` so TF owns the cluster/service/roles/ALB while CD owns revisions. Import the
  task def at its current revision for completeness, but expect TF to not track subsequent revisions.
  **Likely its own short ADR.**
- **ECS cluster's CloudFormation stack — single-owner cleanup.** The cluster was created by the console via
  a CFN stack (`Infra-ECS-Cluster-breadsheet-server-dev-7c4a32c2`). Importing the cluster into Terraform
  gives it two owners. Resolve by **deleting the CFN stack with `--retain-resources`** (keeps the live
  cluster, drops CFN's claim) once the cluster is safely in TF state.
- **`DATABASE_URL` SecureString — secret-in-state.** Importing the SecureString reads the DB password into
  Terraform state (S3 backend — ensure it's encrypted + access-locked). **Recommended:** import the
  parameter but set `lifecycle { ignore_changes = [value] }` so TF never churns or re-exposes it on
  rotation; treat the value as hand/SSM-owned. This whole question disappears at
  [adaptation A1](#post-build-adaptations) (keyless RDS IAM auth removes the password entirely — see
  [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md)).

**Definition of done:**
- [ ] EKS/local artefacts deleted (`eks.tf`, `irsa.tf`, `k8s/`, `environments/local.*`); pre-deletion
      commit tagged `eks-architecture`. `is_local`/`cloud_count`/LocalStack-endpoints machinery removed.
- [ ] `terraform/` root rewritten to raw, Fargate-only resources per the layout above; `terraform init`
      against the **dev** S3 backend succeeds.
- [ ] Every [import map](#import-map) row imported (an `import {}` block per resource) and its `Imported`
      box flipped to ✅.
- [ ] `aws_ecs_service.server` carries `ignore_changes = [task_definition]`; the ECS cluster's CFN stack
      deleted with `--retain-resources` (single owner).
- [ ] `DATABASE_URL` parameter handled per the secret-in-state decision (recommend `ignore_changes = [value]`).
- [ ] **`terraform plan` reports `No changes` on the dev workspace** — the whole stack is described and
      adopted with zero drift.
- [ ] `prod` env files scaffolded (`environments/prod.{tfvars,s3.tfbackend}`) but not applied — promotion
      deferred until a prod stage exists.
- [ ] `docs/architecture/infrastructure.md` updated to describe the Fargate Terraform root (replacing the
      EKS description); a `lifecycle`/CD-ownership ADR added if we write one.

**First-timer tip (not a clickpath):** the golden rule is **post-import `plan` must be a no-op** — if it
shows changes, the *HCL* is wrong (a default attribute you didn't set, a tag case mismatch, an ordering
difference), so edit the config to match reality; **never `apply` to "fix" a freshly imported resource**
or you'll mutate live infra. Import **one slice at a time** and `plan` between them — a 35-resource
big-bang import is impossible to debug. Generated config (`-generate-config-out`) is a *draft*, not the
answer: it's verbose and often pins computed/default fields you should delete. Watch for the usual
import mismatches: missing `aws_route_table_association`/default `aws_route` (subnets/IGW look fine but
routing drifts), the implicit default-egress SG rule, and S3's split sub-resources (BPA, ownership,
policy, CORS are each their own resource, not bucket attributes). Keep secrets (`DATABASE_URL`) out of
plan output.

**Verification:** the objective is *self-verifying* — a clean `terraform plan` (`No changes`) on the dev
workspace is the proof the Terraform config matches the deployed stack. Claude will additionally
spot-check (read-only) that no resource was recreated during import (`terraform state list` covers every
import-map row), confirm the ECS service's `ignore_changes`, and confirm the CFN stack is gone
(`aws cloudformation describe-stacks` → not found) while the cluster still serves `200`.

---

## Post-build adaptations

Improvements deliberately **deferred** until the stack runs end-to-end, so they don't sit on the
critical path. Each is self-contained and safe to do as its own change once the app is deployed and
serving.

| # | Adaptation | Trigger / prerequisite | Reference |
|---|---|---|---|
| A1 | **Migrate DB auth to keyless IAM** — swap the SSM password for RDS IAM authentication via the Prisma `@prisma/adapter-pg` driver adapter + a `pg.Pool` async `password` callback that mints a 15-min auth token. Grant the DB user `rds_iam`; enforce TLS with the RDS CA bundle (`rejectUnauthorized: true`). The instance's IAM-auth toggle is already on (Objective 3). | App deployed and serving over the SSM password first. | [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md) |
| A2 | **Front the images bucket with CloudFront (OAC)** — make the bucket fully private (all four BPA blocks ON; drop the `processed/*` public-read policy) and serve reads through a CloudFront distribution using Origin Access Control, for edge caching + a hidden origin. Repoint `ASSET_BASE_URL` to the CDN domain. | App deployed and serving `processed/*` over the scoped public-read policy first. | [Objective 6](#objective-6--s3-image-bucket) |

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
| GitHub OIDC provider | `arn:…:oidc-provider/token.actions.githubusercontent.com` | `aws_iam_openid_connect_provider.github` | ⬜ |
| ECS execution role | `breadsheet-dev-ecs-execution` | `aws_iam_role.ecs_execution` | ⬜ |
| ECS task role | `breadsheet-dev-ecs-task` | `aws_iam_role.ecs_task` | ⬜ |
| Task role S3 inline policy | `breadsheet-dev-ecs-task:PutRawImagesInS3` | `aws_iam_role_policy.ecs_task_s3` | ⬜ |
| CI deployer role | `breadsheet-dev-deployer` | `aws_iam_role.deployer` | ⬜ |
| ECS cluster | `breadsheet-server-dev` (CFN stack `Infra-ECS-Cluster-breadsheet-server-dev-7c4a32c2`) | `aws_ecs_cluster.main` | ⬜ |
| SSM param `DATABASE_URL` | `/breadsheet/dev/DATABASE_URL` (SecureString) | `aws_ssm_parameter.database_url` | ⬜ |
| SSM param `SUPABASE_URL` | `/breadsheet/dev/SUPABASE_URL` | `aws_ssm_parameter.supabase_url` | ⬜ |
| SSM param `SUPABASE_PUBLISHABLE_DEFAULT_KEY` | `/breadsheet/dev/SUPABASE_PUBLISHABLE_DEFAULT_KEY` | `aws_ssm_parameter.supabase_key` | ⬜ |
| Execution role SSM inline policy | `breadsheet-dev-ecs-execution:GetDevEnvVariablesFromSystemsManagerParameterStore` | `aws_iam_role_policy.ecs_execution_ssm` | ⬜ |
| CloudWatch log group | `/ecs/breadsheet-dev-server` | `aws_cloudwatch_log_group.server` | ⬜ |
| ECS task definition | `breadsheet-dev-server` (active rev `:5`) | `aws_ecs_task_definition.server` | ⬜ |
| Route 53 hosted zone | `Z08021021I2ON3AX4JM0` (`dev.bread-sheet.com`) | `aws_route53_zone.dev` | ⬜ |
| ACM certificate | `arn:…:certificate/916cc3ff-c297-463d-9b1a-bcab71e5cdb5` (`server.dev.bread-sheet.com`) | `aws_acm_certificate.server` | ⬜ |
| ALB | `…:loadbalancer/app/breadsheet-dev-alb/370ee9fd8cef94ff` (DNS `breadsheet-dev-alb-1430077274.eu-west-1.elb.amazonaws.com`, canonical zone `Z32O12XQLNTSW2`) | `aws_lb.main` | ⬜ |
| ALB target group | `…:targetgroup/breadsheet-dev-alb-target-group/7d12e1f454011d54` | `aws_lb_target_group.server` | ⬜ |
| HTTPS:443 listener | (under the ALB above) | `aws_lb_listener.https` | ⬜ |
| HTTP:80 listener (301→HTTPS) | (under the ALB above) | `aws_lb_listener.http_redirect` | ⬜ |
| ECS service | `…:service/breadsheet-server-dev/breadsheet-dev-server-service` | `aws_ecs_service.server` | ⬜ |
| Route 53 A-alias record | `server.dev.bread-sheet.com` → ALB (in zone `Z08021021I2ON3AX4JM0`) | `aws_route53_record.server` | ⬜ |
| GCP WIF pool | `breadsheet-dev` (project `breadsheet-496522`/`1054240616692`) | `google_iam_workload_identity_pool.aws` | ⬜ |
| GCP WIF AWS provider | `aws-ecs` (account `493942067033`, scoped to task role) | `google_iam_workload_identity_pool_provider.aws_ecs` | ⬜ |
| GCP service account | `breadsheet-dev-vision@breadsheet-496522.iam.gserviceaccount.com` (uniqueId `107807807341293118930`) | `google_service_account.vision` | ⬜ |
| GCP project role binding (`aiplatform.user` → SA) | `breadsheet-496522 roles/aiplatform.user serviceAccount:breadsheet-dev-vision@breadsheet-496522.iam.gserviceaccount.com` | `google_project_iam_member.vision_aiplatform` | ⬜ |
| GCP SA impersonation binding | `workloadIdentityUser` → task-role principalSet | `google_service_account_iam_member.wif` | ⬜ |
| S3 images bucket | `breadsheet-dev-s3-493942067033-eu-west-1-an` | `aws_s3_bucket.images` | ⬜ |
| — bucket public-access block | (same bucket) | `aws_s3_bucket_public_access_block.images` | ⬜ |
| — bucket ownership controls | (same bucket) | `aws_s3_bucket_ownership_controls.images` | ⬜ |
| — bucket policy (`processed/*` public read) | (same bucket) | `aws_s3_bucket_policy.images` | ⬜ |
| — bucket CORS | (same bucket) | `aws_s3_bucket_cors_configuration.images` | ⬜ |

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
  drift) and wrote it up as the [Objective 8](#objective-8--task-definition--cd-pipeline) detail.
  Found Objective 4's premise was false — `build-image.yml` was only on a feature branch and had
  never run. Merged to `main`; first image built (`…/bread-sheet-server:b8ab5ac…` + `:latest`) and
  bumped the workflow actions to Node 24. Package set **Public**; Claude verified anonymous pull and
  read the image config — `linux/amd64`, port `3000`, entrypoint `docker-entrypoint.sh` +
  `node dist/server.js`. **Objective 4 ✅**. Next: Objective 5 (IAM roles — task + execution +
  the GitHub-OIDC deployer role for CD).
- _Session 6:_ Built the GitHub OIDC provider + three IAM roles. First pass had issues (execution
  policy wrongly on the task role, malformed OIDC `sub` from the console wizard concatenating the
  repo URL, names not matching the deployer's `PassRole` ARNs); Claude reviewed read-only, then
  recreated all three clean under the kebab convention (`breadsheet-dev-ecs-execution` /
  `-ecs-task` / `-deployer`) and deleted the old `=`-named roles. All keyless, tagged, import map
  updated. **Objective 5 🔄** — one open item: the task role's scoped S3 policy, deferred until the
  dev images bucket ARN exists. Next: Objective 6 (S3 image bucket — newly inserted; closes the
  task-role S3 item), then Objective 7 (ECS cluster).
- _Session 7:_ Compared image read-access options (scoped public-read vs CloudFront/OAC) on
  cost+complexity — cost is ~equal/tiny at dev scale, so chose **scoped public-read for dev now,
  CloudFront deferred** (added as post-build adaptation A2). Caught that the runbook over-specified
  the task-role scope: `imageService.ts` imports only `PutObjectCommand` (writes `raw/`, returns the
  predicted `processed/` key, never reads), so the task role needs **`PutObject` on `raw/*` only** —
  no `GetObject`. Hand-built the bucket `breadsheet-dev-s3-493942067033-eu-west-1-an` (ACLs disabled,
  BPA = 2 ACL-blocks ON / 2 policy-blocks OFF, `processed/*` public-read policy, GET CORS) and
  attached the task-role `PutRawImagesInS3` inline policy. Claude verified read-only against all
  done-criteria — **Objective 6 ✅**, **Objective 5 ✅** (open item closed), import map updated.
  `ASSET_BASE_URL`/`S3_MODE=aws` recorded for Objective 8. Next: Objective 7 (ECS cluster).
- _Session 8:_ Fleshed out the Objective 7 detail section, then hand-built the ECS cluster. First
  attempt failed on the **Service Connect namespace** path (missing `AWSServiceRoleForECS_ServiceConnect`
  SLR); since we run one service behind an ALB (no service-to-service discovery), recreated the bare
  cluster **without a namespace** — `breadsheet-server-dev`, Fargate-only (`FARGATE`+`FARGATE_SPOT`,
  no EC2), Container Insights off, tagged. Console created it via a CloudFormation stack (flagged in
  the import map for Objective 14). Claude verified read-only against all done-criteria —
  **Objective 7 ✅**. Next: Objective 8 (task definition + CD pipeline).
- _Session 9:_ Fleshed out and pulled forward Objective 13 (secrets must exist before the task-def
  `secrets` block names them). Split secret-vs-plain: only `DATABASE_URL` is a real secret
  (SecureString); Supabase URL + publishable key are non-secret Strings; mode flags/non-sensitive
  config stay as plain task-def env. Built three `/breadsheet/dev/*` params (Standard tier, free,
  `aws/ssm` key) + the execution-role inline `ssm:GetParameters` scoped to the path. Claude verified
  read-only **without decryption** — **Objective 13 ✅**, **Objective 5 SSM item closed**, import map
  updated. Next: Objective 8 (task definition) → 9 (ALB) → 10 (service, first real task start).
- _Session 10:_ Fleshed out Objective 8 Part A (the task-definition artifact) with a field-by-field
  spec, pre-created the CloudWatch log group, and registered the task def. Iterated `:2`→`:5`: `:2`
  put the launch line in `entryPoint` (functional but moved to `command`) and omitted `AWS_REGION`
  (the S3 client sets no region → "Region is missing"); `:5` is clean. Claude verified read-only
  against all Part-A criteria — **Objective 8 Part A ✅** (revision `:5`), import map updated
  (log group + task def). Objective 8 stays 🔄 — **Part B (CD pipeline)** is wired alongside/after
  the service. Next: Objective 9 (ALB + target group + ACM cert + HTTPS listener).
- _Session 11:_ Built the whole front door. Domain `bread-sheet.com` is at an external registrar →
  chose a **Route 53 hosted zone** for the `dev.bread-sheet.com` **subzone** (apex left at registrar),
  delegated via NS records (verified resolving). ACM cert for `server.dev.bread-sheet.com`
  (DNS-validated, `eu-west-1`, **ISSUED**) — caught the stall: the validation CNAME hadn't been added
  to the zone. Hostname chosen `server.dev.bread-sheet.com` (mirrors the cluster). Target group:
  first created a **VPC Lattice** TG by mistake (the EC2-vs-VPC "Target groups" console trap),
  deleted it, recreated the **ELBv2** one (type **IP**, HTTP/3000, HTTP1, `GET /`, empty). ALB
  `breadsheet-dev-alb` (internet-facing, both public subnets, ALB SG, IPv4 — discussed dualstack:
  frontend-only, backend needs nothing, but VPC is IPv4-only so deferred). Listeners: `:443` forward
  w/ cert + `:80`→301 HTTPS; added the `80` ALB-SG ingress (v4+v6). Claude verified every sub-part
  read-only — **Objective 9 ✅**, import map updated. Also wrote up **ALB** and **DNS & TLS** sections
  in the personal knowledge hub. Next: Objective 10 (ECS service — first real task start).
- _Session 12:_ Fleshed out Objective 10, then hand-built the ECS service
  `breadsheet-dev-server-service` (FARGATE, desired 1, public subnets + Task SG +
  `assignPublicIp=ENABLED`, LB-wired to the target group, 120s grace, circuit-breaker rollback). The
  **first real task started cleanly**: GHCR image pull, SSM secret injection, and `db:deploy` applied
  all 10 migrations against RDS (closing the deferred `DATABASE_URL` verification), app up on 3000.
  Target briefly `unhealthy` — diagnosed read-only as the expected registration window (≈90s
  migrate+boot + 150s of passing checks), then flipped `healthy` on its own. Verified end-to-end with
  curl: `:80`→301, `https://server.dev.bread-sheet.com/` (SNI) → valid cert + `200`. **Objective
  10 ✅**, import map updated. Caught that the deployer policy's `UpdateService` ARN is stale (wrong
  cluster + service name) — flagged for 8B. Next: Objective 11 (Route 53 alias → ALB), then 8B (CD)
  and 12 (GCP WIF).
- _Session 13:_ Added the Route 53 **A-alias** `server.dev.bread-sheet.com` → ALB
  (`EvaluateTargetHealth=true`). Verified read-only — resolves to the live ALB IPs and
  `https://server.dev.bread-sheet.com/` returns `200` with a valid cert (no spoofing). **Objective
  11 ✅**, import map updated. Wrote **ECS Service** + **Route 53 alias** sections in the personal
  knowledge hub. Remaining: 8B (CD pipeline + deployer-ARN fix), 12 (GCP WIF), 14 (Terraform import),
  15 (post-build adaptations). Next: Objective 8B or 12.
- _Session 14:_ Built **Objective 8B (dev CD)**: added a `deploy-dev` job to `build-image.yml`
  (`needs: build`) — keyless GitHub-OIDC → fetch active task def (`describe-task-definition` + `jq`
  strip) → render `:<sha>` image → `amazon-ecs-deploy-task-definition` with
  `wait-for-service-stability`, `concurrency: deploy-dev`. Chose **fetch-task-def-from-AWS over a repo
  file** so CD only swaps the image (never clobbers the hand-built env/secrets). Fixed the deployer
  policy ARN (`service/breadsheet-server-dev/breadsheet-dev-server-service`). Discussed why the role
  ARN/account id are **not secrets** (OIDC trust is the boundary; if anything use `vars`, not Secrets
  — deferred to prod/Environments) and walked through **`iam:PassRole`** (the deployer *passes* the
  task/exec roles to ECS, scoped to those two ARNs + `PassedToService=ecs-tasks` — an escalation
  guard). Merged to main; Claude watched the run — `build`+`deploy-dev` green, service rolled to
  **rev `:6`** (`COMPLETED`, pinned to the merge SHA), still serving `200`. **Objective 8 ✅** (dev;
  prod promotion deferred). Next: Objective 12 (GCP WIF), then 14 (Terraform import).
- _Session 15:_ Hit a runtime DB bug surfacing *before* the GCP work: the app booted, migrations
  applied, `GET /` served `200` — but DB-backed queries failed, RDS logging
  `could not accept SSL connection: EOF detected` from the task's private IPs. Root cause: the runtime
  connection goes through the **`@prisma/adapter-pg` driver adapter** (`src/db.ts` → `pg.Pool`), a
  different TLS stack from the Prisma migration engine. `pg` ≥ 8.22 treats the URL's `sslmode=require`
  as `verify-full`, which validates the RDS cert against Node's default trust store — and the **RDS CA
  isn't in it**, so `pg` aborts the handshake. Migrations escaped it (Prisma's engine treats `require`
  as encrypt-only), which is why the failure was invisible at boot and the ALB health check (no DB)
  stayed green. **Fix (verify-full + CA bundle, per [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md)):**
  new `configs/databaseConfig.ts` validates a required `DB_SSL` (`disabled | verify-full`), and for
  `verify-full` strips `sslmode` from the URL (kills the pg deprecation warning + double-config) and
  sets `ssl:{ ca, rejectUnauthorized:true }` against the RDS global CA bundle now downloaded into the
  image (`certs/rds-global-bundle.pem`, Dockerfile). Local/compose + `.env.example` set `DB_SSL=disabled`
  (no local TLS); CLAUDE.md documented. 8 new unit tests; full suite green (432). **Deploy note:** the
  live **task-def `environment` must add `DB_SSL=verify-full`** (a new revision) — fail-fast means the
  new image won't boot without it. Next: deploy the fix, then Objective 12 (GCP WIF).
- _Session 16:_ Reviewed the whole runbook and the existing (EKS-shaped) `terraform/` root, then wrote
  the **[Objective 14](#objective-14--import-the-hand-built-stack-into-terraform)** plan: import the
  hand-built dev stack into Terraform **in place** (no recreate) via TF 1.10 `import {}` blocks +
  `-generate-config-out`, slice by dependency order, driving `terraform plan` to a **zero-diff no-op**.
  Locked four decisions: **raw resources (no modules)** for clean one-to-one imports; **delete the EKS
  stack** (`eks.tf`/`irsa.tf`/`k8s/`/OIDC `gcp-wif.tf`) — never applied, kept only in git history behind a
  `eks-architecture` tag; **two cloud envs (dev + prod), drop the `local` TF env** (LocalStack can't
  emulate ECS/ALB/ACM/Route 53/RDS — local dev stays on docker-compose + `localstack-init.sh`), which also
  lets the `is_local`/`cloud_count` machinery go. Flagged three edges to settle during import: task-def
  drift (`ignore_changes`), the ECS cluster's CFN stack (delete with `--retain-resources`), and the
  `DATABASE_URL` SecureString-in-state (recommend `ignore_changes = [value]`). Next: execute Objective 14
  — bootstrap + network slice first.
