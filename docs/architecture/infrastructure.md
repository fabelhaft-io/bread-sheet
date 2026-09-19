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

### Live Google Vision & Gemini (local)

By default `VISION_MODE=mock` and `PLAUSIBILITY_MODE=mock` return fixture data — no GCP credentials
needed. To test against the real APIs:

**Vision (`VISION_MODE=live`):**
1. Install the [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) and run
   `gcloud auth application-default login` on the **host** (not inside a container). Credentials land
   at `~/.config/gcloud/application_default_credentials.json` and are picked up automatically by a
   server running on the host — no `GOOGLE_APPLICATION_CREDENTIALS` needed locally.
2. Enable the API: `gcloud services enable vision.googleapis.com --project=YOUR_PROJECT_ID`
3. Vision has no dedicated invoker role — Owner/Editor accounts can call it directly; otherwise grant
   `roles/serviceusage.serviceUsageConsumer`:
   ```sh
   gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
     --member="user:your-email@example.com" \
     --role="roles/serviceusage.serviceUsageConsumer"
   ```
4. Set `VISION_MODE=live` in `server/.env`.

**Gemini plausibility gate (`PLAUSIBILITY_MODE=gemini`):** the Add Product flow runs an AI check on
every uploaded image (rejects non-product/unusable photos, reads front-of-pack name/brand
suggestions, flags abuse — see [`backend.md`](backend.md)). Pick **one** auth method (both are read
by the shared `getGeminiClient()` factory — the app code is identical):

- **Vertex AI + ADC (recommended, no key).** Reuses the same ADC login as Vision:
  1. Enable the API: `gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID`
  2. Grant the role (skip if Owner/Editor):
     ```sh
     gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
       --member="user:your-email@example.com" \
       --role="roles/aiplatform.user"
     ```
  3. Point ADC quota at this project (Vertex requires billing enabled):
     `gcloud auth application-default set-quota-project YOUR_PROJECT_ID`
  4. Set in `server/.env` (leave `GEMINI_API_KEY` unset):
     ```env
     PLAUSIBILITY_MODE=gemini
     GEMINI_DAILY_CALL_CAP=100          # required whenever PLAUSIBILITY_MODE=gemini or VISION_MODE=llm
     GOOGLE_GENAI_USE_VERTEXAI=true
     GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
     GOOGLE_CLOUD_LOCATION=global
     ```
- **Gemini Developer API key (simplest, but a long-lived secret).** Create a key at
  [Google AI Studio](https://aistudio.google.com/apikey) (free tier, no GCP project/billing
  required), then in `server/.env`:
  ```env
  PLAUSIBILITY_MODE=gemini
  GEMINI_DAILY_CALL_CAP=100          # required whenever PLAUSIBILITY_MODE=gemini or VISION_MODE=llm
  GEMINI_API_KEY=your-key            # leave GOOGLE_GENAI_USE_VERTEXAI unset
  ```

**Running the server in a container with Vertex/ADC:** on the host (`npm run dev`), ADC is discovered
automatically. The `app-dev` **container** instead bind-mounts the host ADC file, controlled by
`GCLOUD_ADC_PATH` in the root `.env`:
```yaml
# docker-compose.yml
- ${GCLOUD_ADC_PATH}:/root/.config/gcloud/application_default_credentials.json:ro
```
Verify after `docker compose --profile app-dev up`:
```sh
docker compose exec server cat /root/.config/gcloud/application_default_credentials.json
```
Non-empty JSON means ADC is available inside the container.

**Production credentials:** in production, Vertex AI is the only Gemini path
(`GOOGLE_GENAI_USE_VERTEXAI=true`) and Vision uses `live`; both authenticate keylessly through
Workload Identity Federation — see § Keyless Google Cloud (Vision/Vertex) — Fargate WIF below.

### Running on Windows

The project is developed on Linux/Podman, but it runs on Windows with Docker too. Use a **native
Windows terminal (PowerShell or CMD)** — not WSL2 — and adapt as follows:

- **Compose runtime:** use Docker Desktop (`docker compose`). The Compose stack interpolates Windows
  host paths and environment variables that only resolve in a native Windows shell.
- **Copying env files:** replace `cp` with `Copy-Item`, e.g. `Copy-Item server/.env.example server/.env`.
- **ADC mount path:** set `GCLOUD_ADC_PATH` in the root `.env` to
  `${APPDATA}/gcloud/application_default_credentials.json`. `${APPDATA}` only resolves in
  PowerShell/CMD — from a WSL2 shell it is undefined and the mount silently fails, breaking
  Gemini/Vision auth in the container.
- **Multi-line `gcloud` commands:** use a backtick (`` ` ``) for line continuation instead of the `\`
  shown above, or put each command on one line.

> **Why not WSL2?** Expo needs to detect your host network interface to serve the dev bundle to
> devices/emulators, and the Compose stack relies on Windows-path mounts (the ADC file). Both break
> under WSL2. If you specifically want WSL2, run `gcloud` inside WSL and set `GCLOUD_ADC_PATH` to the
> Linux ADC path instead.

---

## Cloud Infrastructure (AWS — ECS Fargate)

The dev cloud environment is a **Fargate stack fully owned by Terraform** (`terraform/`). All
resources were hand-built first (for learning), then imported into state with zero drift —
`terraform plan` reports no changes. The build log and import map are in
[`fargate-handbuild.md`](fargate-handbuild.md).

### Architecture (dev)

Public hostname **`https://server.dev.bread-sheet.com`** → API Gateway (HTTP API) → VPC Link v2 →
Cloud Map → Fargate task → RDS. The security-group chain enforces
`API Gateway (managed) → VPC link ENI → task(:3000) → RDS(:5432)`, each internal hop referencing the
previous group's SG id (no CIDRs).

**There is no load balancer.** TLS terminates at API Gateway's managed fleet, outside the VPC, so the
VPC link ENIs take no public ingress at all — their security group only needs egress to the task. The
ALB was retired to remove its ~\$18/mo flat charge plus two per-AZ public IPv4 addresses; see
[ADR 0003](../architecture-decision-records/0003-always-on-production-cost-architecture.md).

| Component | Resource | Notes |
|---|---|---|
| Network | VPC `10.0.0.0/16`, 2 public + 2 private subnets, **no NAT** | Task runs in the **public** subnets with a public IP (pulls the GHCR image and reaches Supabase / GCP / SSM via the IGW); RDS is private-only. ~\$33/mo saved vs NAT. |
| Ingress | API Gateway **HTTP API** + VPC Link v2 + Cloud Map + ACM cert + Route 53 A-alias | No hourly charge; billed per request. Uses the **`$default` stage** (a named stage prepends itself to the backend path and would break every route) and a **`$default` route** (`ANY /{proxy+}` does not match `/`, which is the health endpoint). Integration timeout **30 s, not increasable** — the server's own budget nests inside it (20 s Gemini call / 25 s handler). Access logs → `/aws/apigateway/breadsheet-dev-api`. |
| Service discovery | Cloud Map private DNS namespace `breadsheet-dev.local`, service `server` | **SRV** records, TTL 15 — API Gateway's `DiscoverInstances` needs IP *and* port, and an A record carries no port. `health_check_custom_config` must be non-empty (`failure_threshold = 1`, deprecated but required) or AWS stores `null` and every plan re-replaces the service. |
| Compute | ECS **Fargate** service `breadsheet-dev-server-service` on cluster `breadsheet-server-dev` | Desired 1, `256`/`512`, **X86_64** (image is `linux/amd64`), `assignPublicIp=ENABLED`, rolling deploy + circuit-breaker rollback. Liveness is a **container `healthCheck`** (`wget`, not `curl` — the `node:24-alpine` runtime image has no curl) with `startPeriod = 150` to cover `scripts/start.sh` running `npm run db:deploy` before the server listens. `health_check_grace_period_seconds` was ALB-only and went with it; without the target group, this health check is the *only* thing that detects a wedged task and the only signal ECS reports into Cloud Map. Memory is the 512 MB minimum, measured rather than assumed: it was briefly raised to 1 GB on the theory that sharp/libvips needed the headroom, but ADR 0003 step 0b measured `MemoryUtilization` peaking at ~124 MB (about 24% of 512) across 60 serial image uploads. 256 CPU permits only 512 / 1024 / 2048 MB. Revisit if uploads grow — the sample used 521 KB images against a 4 MB multer cap. |
| Database | RDS PostgreSQL `db.t4g.micro`, single-AZ, private, encrypted | Reachable only from the task SG on `5432`. Keyless RDS IAM auth (`DB_AUTH=iam`) via `@aws-sdk/rds-signer` — see [ADR 0002](../architecture-decision-records/0002-rds-database-credentials.md). |
| Images | S3 bucket `breadsheet-dev-s3-…` behind a CloudFront distribution | `raw/*` private (task `s3:PutObject` only); `processed/*` reads go through CloudFront + OAC only — the bucket itself has no public policy (ADR 0005 L5, § CloudFront images distribution below). Resize Lambda deferred. |
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
  connection — minting a 15-min IAM auth token (local signing, no network round-trip). In this mode the
  config returns **discrete `host`/`port`/`user`/`database` fields, never a `connectionString`**, and
  `db.ts` passes whichever set it gets. This is load-bearing, not style: `pg` merges the two as
  `Object.assign({}, config, parse(config.connectionString))`, so the parsed URL overrides everything
  passed beside it — and `pg-connection-string` *always* emits a `password` key (`''` when the URL has
  none). Supplying both silently discards the signer callback, and RDS answers
  `PAM authentication failed for user "breadsheet_iam"` (Prisma `P1010`) on every connection. Because
  `start.sh` used to `export` the migration token into `DATABASE_URL`, the runtime adopted that
  15-minute token as a fixed password: the API worked for 15 minutes after each deploy, then 500ed on
  every route until redeployed. Guarded by the `pg config merge` block in `databaseConfig.test.ts`,
  which asserts through pg's real `ConnectionParameters`.
  A `DATABASE_URL` carrying query params is rejected at startup in this mode rather than having them
  dropped silently — discrete fields cannot carry them.
- **Migrations:** the Prisma migration engine reads `DATABASE_URL` directly and cannot use the pg.Pool
  callback. The ECS startup script (`scripts/start.sh`) calls `node scripts/rds-token.mjs --database-url`,
  which mints a token *and assembles the whole URL*, before running `npm run db:deploy`. The assembly
  belongs to the script rather than the shell because the token must be percent-encoded to sit in the
  password slot: an RDS auth token is itself shaped like `host:5432/?Action=connect&X-Amz-Signature=...`,
  so interpolating it raw ends the userinfo at its first `/` and Prisma rejects the result with
  `P1013: invalid port number in database URL`. Bare `scripts/rds-token.mjs` still prints the raw token,
  which is the form to paste at a `psql` password prompt. The token-bearing URL is scoped to the
  `npm run db:deploy` command and **deliberately not exported** — see the runtime bullet above for what
  leaking it into the server process cost.
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
  security.tf     # VPC link / task / RDS security groups. The task + vpclink groups use
                  # standalone *_rule resources, not inline blocks — see the note below.
  rds.tf          # DB subnet group + RDS instance
  iam.tf          # execution / task / deployer roles, policies, GitHub OIDC provider
  s3.tf           # images bucket + public-access-block + ownership + policy + CORS
  cloudfront.tf   # ADR 0005 L5: OAC + WAF web ACL + CloudFront distribution over the images bucket
  ssm.tf          # SSM parameters (Supabase URL + key)
  ecs.tf          # ECS cluster + task definition + service
  api-gateway.tf  # HTTP API + VPC link + integration + $default route/stage (+ throttled upload-image
                  # route) + custom domain + access logs
  service-discovery.tf # Cloud Map private DNS namespace + SRV service
  dns.tf          # Route 53 zone (dev.bread-sheet.com) + ACM cert + validation + A-alias → API Gateway
  gcp-wif.tf      # GCP WIF pool + AWS provider + SA + bindings
  budget.tf       # SNS billing_alerts topic (+ its consolidated access policy) + monthly AWS budget
  detection.tf    # ADR 0005 D: Cost Anomaly Detection, API Gateway + GeminiCalls alarms, GCP budget
  l4.tf           # ADR 0005 L4: RDS-stop budget action (AWS) + Pub/Sub-triggered billing-detach
                  # Cloud Function (GCP) — source at functions/billing-killswitch/
  outputs.tf      # Useful references (URLs, ARNs, names)
  environments/
    dev.tfvars           # Variable values for dev
    dev.s3.tfbackend     # Backend config for dev state
```

### Security groups: standalone rules, not inline blocks

`aws_security_group.task` and `aws_security_group.vpclink` declare **no inline `ingress`/`egress`
blocks**. Their rules are separate `aws_vpc_security_group_ingress_rule` /
`aws_vpc_security_group_egress_rule` resources. Two distinct problems forced this, both worth
knowing before anyone "tidies" them back inline:

* **Cycles.** vpclink egresses to task and task ingresses from vpclink. As inline blocks that is a
  dependency cycle Terraform refuses to plan. As separate resources it is three nodes it can order.
* **Deadlock on a changed reference.** When the task SG's inline ingress still referenced the ALB SG
  in state while the config had moved to vpclink, Terraform had no edge saying "revoke that rule
  before destroying the ALB SG". It scheduled the destroy first, and the destroy then blocked for
  15 minutes on `DependencyViolation` behind the very update that would have released it. The rule
  had to be revoked by hand with `aws ec2 revoke-security-group-ingress` to break the deadlock.

A related trap when migrating: `ingress`/`egress` on `aws_security_group` are `Optional` **and
`Computed`**, so deleting an inline block does *not* revoke the rules — it only stops managing them.
The rules stay in AWS, and the replacement standalone resources then fail with
`InvalidPermission.Duplicate`. Import them instead:

```sh
terraform import aws_vpc_security_group_egress_rule.task_all_ipv4 sgr-xxxxxxxx
```

Do not mix the two styles on one group: a security group with inline blocks treats itself as
authoritative over that group's whole rule set and will fight the standalone resources.

### Changing a task environment variable

Not obvious, and it will look like your change did nothing:

```
ecs.tf   aws_ecs_task_definition.server   ignore_changes = [container_definitions]
ecs.tf   aws_ecs_service.server           ignore_changes = [task_definition]
```

The `environment` array lives *inside* `container_definitions`, so editing a variable (or the
`.tfvars` behind one) produces **no plan diff at all**. Those blocks exist so CI's push-deployed
revisions are invisible to Terraform; the unintended cost is that Terraform can no longer change
task configuration. The CD pipeline cannot do it either — `build-image.yml` fetches the *live* task
definition and swaps only the image, carrying the old value forward.

Two steps, and both are needed:

```sh
# 1. Force a new revision. `ignore_changes` does not apply to a create, so the
#    replacement is built entirely from config. Any top-level attribute change
#    (cpu, memory) forces this on its own; otherwise ask for it explicitly.
terraform apply -var-file=environments/dev.tfvars -replace=aws_ecs_task_definition.server

# 2. Roll it out. The service ignores `task_definition`, so Terraform will not.
#    The family name resolves to the latest ACTIVE revision.
aws ecs update-service --cluster breadsheet-server-dev \
  --service breadsheet-dev-server-service \
  --task-definition breadsheet-dev-server --force-new-deployment
```

This is how `GOOGLE_CLOUD_LOCATION` was corrected from `europe-west1` to `global` after Vertex
returned `404 Publisher model ... not found` for `gemini-3.5-flash` in that region — a failure that
only appears in the **ECS** logs, since it is the app's upstream call failing rather than anything
in the ingress.

### Billing guardrail

`budget.tf` creates a monthly `COST` budget (`var.budget_limit_usd`, default `45`) that publishes to
an SNS topic. Two thresholds: `ACTUAL >= 80%`, and `FORECASTED >= 100%` — the second is the one that
matters, because dropping the ALB traded a flat hourly charge for per-request pricing with no
ceiling, and a forecast fires mid-month on a trend rather than after the money is spent.

**Alerts go nowhere until you subscribe.** AWS Budgets accepts only `EMAIL` or `SNS` subscribers —
there is no IAM-principal subscriber, and IAM users have no email attribute for AWS to resolve. The
topic keeps addresses out of the repo and out of Terraform state:

```sh
aws sns subscribe --topic-arn $(terraform -chdir=terraform output -raw billing_alerts_topic_arn) \
  --protocol email --notification-endpoint you@example.com
```

Confirm via the emailed link. There is deliberately no `aws_sns_topic_subscription` for email:
Terraform cannot perform the confirmation, so such a resource sits permanently *pending confirmation*
and shows as drift on every plan. Note also `aws_sns_topic_policy` granting `budgets.amazonaws.com`
publish rights — without it the budget applies cleanly and silently delivers nothing.

**This budget alone is not a stop.** It is one AWS-only signal on a monthly cycle; see
[ADR 0005](../architecture-decision-records/0005-cost-blast-radius-and-emergency-stop.md) for the
full blast-radius analysis and the layered emergency stop, of which this budget is one layer among
several (below). Note also that `FORECASTED >= 100%` needs several weeks of billing history before
AWS will emit a forecast, so on a young account `ACTUAL >= 80%` is the only notification actually
running.

### Cost blast radius — L1 throttle + D detection (ADR 0005, Phase 1)

**L1 — `api-gateway.tf`.** `aws_apigatewayv2_stage.default` sets `default_route_settings` to
**5 rps / burst 25** (the account default is 10,000 rps, so this is the only thing standing between
an unbounded gateway bill and a bounded one). A second route, `POST /api/products/upload-image`,
points at the *same* integration as `$default` — it exists purely so it can carry its own tighter
`route_settings` (**1 rps / burst 5**) on the Gemini upload path; do not remove it as dead code.

**D — `detection.tf`.** Four free signals, all publishing to the existing
`aws_sns_topic.billing_alerts` (whose access policy — `data.aws_iam_policy_document.billing_alerts`
in `budget.tf` — is the single place all of D's and the budget's publishers are granted `SNS:Publish`;
SNS allows only one policy per topic, so new publishers extend that one document rather than adding a
second `aws_sns_topic_policy`):

* `aws_ce_anomaly_monitor` + `aws_ce_anomaly_subscription` (Cost Anomaly Detection, `≥ $5` anomaly,
  `IMMEDIATE`). Both must use the **`aws.use1`** provider alias declared in `main.tf` — Cost
  Explorer's anomaly APIs are only reachable via the us-east-1 endpoint regardless of which region is
  actually monitored. **The monitor is imported, not created**: AWS allows exactly one
  `DIMENSIONAL`/`SERVICE` monitor per account, and this account already had one
  (`Default-Services-Monitor`, console-created years before this stack existed, carrying its own
  personal \$100/40%-threshold email subscription — left untouched). If this ever needs recreating
  from scratch on a fresh account, drop the import and let Terraform create it.
* `aws_cloudwatch_metric_alarm` on `AWS/ApiGateway` `Count` (`> 1000` in 5 min — sees requests the L1
  throttle rejected too, which is the point).
* `aws_cloudwatch_log_metric_filter` on `/ecs/breadsheet-dev-server` matching `request:finish` lines
  for the two Gemini paths, feeding a `GeminiCalls` metric, plus an alarm at `> 50`/hour. No
  application change — `requestLogger.ts`'s structured log line already carries `path` in JSON (the
  task runs `NODE_ENV=production`).
* `google_billing_budget.dev` on `breadsheet-496522`, thresholds at 5%/12.5%/25% of a 40-unit budget.
  **This billing account bills in EUR, not USD** (`gcloud billing accounts describe
  01E7A9-4D7E3E-165061`) — a `currency_code` mismatch is rejected by the Budgets API as a bare
  `400 invalid argument` with no field-level detail, so the budget is €40 with thresholds at
  €2/€5/€10, standing in for the ADR's dollar figures rather than a currency conversion of them. The
  `google` provider sets `billing_project`/`user_project_override` — local ADC has no quota project by
  default, and `billingbudgets.googleapis.com` (unlike the WIF-only APIs used until now) requires one.

**L2** (the in-process daily Gemini counter) has since landed — see `backend.md` § Daily call cap.
**L5** (CloudFront flat-rate Free plan + OAC over the image bucket) is fully applied, Free plan
subscription included — see § CloudFront images distribution below. **L4** (the AWS RDS-stop budget
action and the GCP billing-detach Cloud Function) has also landed — see § L4 backstops below.

### CloudFront images distribution (ADR 0005 L5)

`cloudfront.tf` fronts the images bucket with a CloudFront distribution so image egress stops being
an unbounded `$0.09/GB` S3 charge (`s3.tf`'s old `Principal: "*"` statement) and becomes something a
flat-rate plan can put a hard `$0` ceiling on. Three pieces, all required together:

1. **Origin Access Control (OAC)** (`aws_cloudfront_origin_access_control.images`) plus a rewritten
   `aws_s3_bucket_policy.images` (`s3.tf`) that only allows `s3:GetObject` from the distribution's
   own service-principal identity (`Condition.StringEquals["AWS:SourceArn"]`). The bucket has **no
   public policy statement at all** any more — a direct `https://<bucket>.s3....amazonaws.com/...`
   URL now 403s; only requests through the distribution succeed. `aws_s3_bucket_public_access_block`
   was tightened to match (`block_public_policy`/`restrict_public_buckets` → `true`).
2. **A WAF web ACL** (`aws_wafv2_web_acl.images`, empty rule set) — mandatory precondition for the
   flat-rate plan below, not optional. WAFv2 web ACLs scoped `CLOUDFRONT` only exist in the
   **us-east-1** API regardless of the distribution's actual footprint, so this reuses the same
   `aws.use1` provider alias as the Cost Anomaly monitor in `detection.tf`.
3. **`ASSET_BASE_URL`** moves from the S3 bucket's own hostname to the distribution's `*.cloudfront.net`
   domain (`ecs.tf`) — a **task environment variable**, so it needs the forced-replacement dance in
   § Changing a task environment variable above, not a plain `terraform apply`.

**What Terraform cannot do: subscribe the distribution to the Free plan.** Confirmed two ways — the
installed `aws` provider (`~> 6.39`) has no `pricing_plan`-shaped argument anywhere in its schema
(`aws_cloudfront_distribution`, `aws_cloudfront_connection_group`, `aws_cloudfront_distribution_tenant`
all checked), and [AWS's own docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html#manage-your-pricing-plans)
say plan management is console / AWS CLI / **PricingPlanManager API** only — a separate API surface
this provider version doesn't wrap. **Done for `dev`** (2026-09-09, manual console step):

```
AWS Console → CloudFront → Distributions → <images_cdn_distribution_id> → Manage Plan → Free
```

`dev`'s image egress is now the structural \$0 this layer is for, not pay-as-you-go-but-cheap.

**`prod` needs this repeated by hand.** `environments/prod.tfvars` doesn't exist yet (ADR 0003 step 7
hasn't been reached), but when it is, `cloudfront.tf` provisions `prod`'s own distribution/OAC/WAF ACL
automatically (it's `local.name_prefix`-keyed, nothing `dev`-specific) — the Free plan subscription
does **not** carry over, since it's per-distribution and spends the account's second Free plan (of 3;
`dev` used the first). Before subscribing `prod`, re-decide the caveat below for a user-facing stage
rather than silently reusing `dev`'s choice — see ADR 0005 § L5 for the two-line decision this needs.

**Deploy ordering matters, and bit us once already (2026-09-09).** Applying the bucket-policy change
before the task is redeployed with the new `ASSET_BASE_URL` breaks every image in the app for however
long that gap lasts — the old S3 URL 403s the moment the policy lands, and nothing serves the new
CloudFront URL until the forced task replacement rolls out. Worse, the first `-replace` attempt during
this rollout used the stale image pin still in `ecs.tf` at the time, silently redeploying an older
commit whose migration step crashed on every launch (`P1013: invalid port number` in the RDS IAM
token) — ECS's circuit breaker rolled each attempt back automatically, so the service stayed up, but
the image gap stayed open for longer than it should have. **Update the image pin to the currently-live
tag before running `-replace` on the task definition, every time**, then do both steps back to back:

```sh
terraform apply -var-file=environments/dev.tfvars
terraform apply -var-file=environments/dev.tfvars -replace=aws_ecs_task_definition.server
aws ecs update-service --cluster breadsheet-server-dev \
  --service breadsheet-dev-server-service \
  --task-definition breadsheet-dev-server --force-new-deployment
```

### L4 backstops (ADR 0005)

`../../terraform/backstops-budget.tf` — the "everything else failed and nobody was looking" tier, one hard stop per
vendor. Applied and verified 2026-09-09.

**AWS: stop RDS at 150% of budget.** `aws_budgets_budget_action.stop_rds` is a `RUN_SSM_DOCUMENTS`
action (`STOP_RDS_INSTANCES` against `aws_db_instance.main`), `AUTOMATIC` approval — a backstop that
needs a click isn't a backstop. Its execution role attaches AWS's own managed policy for this exact
scenario, `AWSBudgetsActions_RolePolicyForResourceAdministrationWithSSM`, rather than a hand-rolled
one: EC2/RDS start-stop conditioned on `aws:CalledVia = ssm.amazonaws.com`, plus
`ssm:StartAutomationExecution` scoped to the four AWS-owned `AWS-{Start,Stop}{EC2,Rds}Instance`
documents.

**GCP: detach billing at €40 actual.** `google_billing_budget.dev` (`detection.tf`) — the same budget
resource D's fractional thresholds already use, not a second one — gained a fourth `threshold_rules`
block at `threshold_percent = 1.0` and an `all_updates_rule { pubsub_topic = ... }`. Every budget
notification (several times a day, per Google's own docs, regardless of whether a threshold was
actually crossed) lands on `google_pubsub_topic.billing_killswitch`; the Cloud Function at
`terraform/functions/billing-killswitch/index.js` is what turns that stream into a one-shot action —
a no-op unless `costAmount > budgetAmount`, and only then calling
`cloudbilling.projects.updateBillingInfo` with an empty `billingAccountName`.

Three things that only showed up when this was actually applied, not just written:

* **`var.gcp_location` (`"global"`, for Vertex AI model routing) is not a real region.** GCS, Cloud
  Functions and Eventarc all rejected it outright. The function's resources use their own literal
  region (`europe-west1`, `local.l4_function_region` in `backstops-budget.tf`) — unrelated to Vertex's location
  choice despite the shared variable in spirit.
* **A GCP org-policy change means the default Compute Engine SA no longer auto-gets the role Cloud
  Build needs for gen2 function builds.** First apply failed with "missing permission on the build
  service account." Rather than widen the shared default compute SA, `build_config.service_account`
  points at the killswitch SA itself (granted `roles/cloudbuild.builds.builder`) — one identity for
  build, trigger and detach, nothing shared with unrelated deployments.
* **A gen2 Pub/Sub trigger on a non-default SA needs three separate IAM grants**, and skipping any one
  produces `run.routes.invoke` 401s that Terraform never surfaces as an error — the resources apply
  cleanly and just silently never deliver: `roles/eventarc.eventReceiver` (project) on the trigger SA,
  `roles/run.invoker` **on the function's own Cloud Run service specifically** (not project-wide) for
  the same SA, and `roles/iam.serviceAccountTokenCreator` **granted to the killswitch SA, held by the
  Pub/Sub service agent** (`service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com`) so
  Pub/Sub can mint the tokens push delivery needs.

**Verified without ever detaching real billing.** Two synthetic messages were published straight to
the topic after apply:

```sh
gcloud pubsub topics publish breadsheet-dev-billing-killswitch --project=breadsheet-496522 \
  --message='{"budgetDisplayName":"breadsheet-dev-gemini-budget","costAmount":1.23,"budgetAmount":40,"currencyCode":"EUR"}'
```

Function logs (`gcloud functions logs read breadsheet-dev-billing-killswitch --project=breadsheet-496522
--region=europe-west1 --gen2`) showed both received, parsed, and correctly resolved to "under budget,
no action" — confirming the full chain (Pub/Sub → Eventarc → Cloud Run → function logic) without ever
calling `updateBillingInfo`. The `roles/billing.admin` grant this layer depends on
(`google_billing_account_iam_member.killswitch_admin`, on the real billing account, scoped to the
account rather than the project — there is no narrower standard role for this API) was never exercised
in anger; there is no safe way to test the actual detach short of detaching real billing.

**This does not reverse itself, deliberately.** A real trip leaves the project with no billing account
attached — every Google service stops, Vertex/Gemini included — until someone manually reattaches one
(`gcloud billing projects link <project> --billing-account=<id>`, or the console). `terraform apply`
will not undo it. That is the point of a hard stop: a human has to consciously reverse it, not have
Terraform quietly smooth it over.

### Phase 2 — CloudFront over the API (ADR 0005)

`../../terraform/dev-geo-restriction.tf` fronts the API with a second CloudFront distribution (the account's second Free
plan slot; L5's images distribution used the first) for two things a plain HTTP API cannot provide:
per-IP rate limiting and geo-restriction, both enforced at the edge for \$0. Applied and largely
verified 2026-09-09 — see the caveat at the end of this section on what still needs a deploy.

**Domain layout changed.** `server.dev.bread-sheet.com` now aliases the CloudFront distribution, not
API Gateway directly. API Gateway's custom domain moved to `origin.dev.bread-sheet.com` — still
publicly resolvable (CloudFront needs a real hostname to reach as a custom origin, same reasoning as
OAC on the images bucket), but `disable_execute_api_endpoint = true` (`api-gateway.tf`) kills the raw
`*.execute-api...` URL, and `requireOriginSecret` (below) is what makes the origin domain's public
resolvability harmless.

**The WAF (`aws_wafv2_web_acl.api`, `us-east-1`) evaluates three rules in order, then a default
allow:**

1. `edge-bypass` (priority 0) — matches `X-Edge-Bypass` against a Terraform-generated secret and
   allows. For consumers that legitimately aren't in Germany: CI (GitHub-hosted Maestro runners) and
   the VPC-link keepalive Lambda, both of which now send it.
2. `geo-de-only` (priority 1) — blocks anything not geolocated to `DE`. **Country-level only, never
   `DE-BW`** — German mobile carriers route subscriber traffic through central egress points, so
   subdivision geolocation fails for real devices on real networks (see the ADR's "The accuracy
   problem"). Confirmed live: a raw request to `server.dev.bread-sheet.com` from a German vantage
   succeeds; the geo rule itself wasn't tested from a non-DE vantage (no easy way to do that safely
   from this environment) — trust the WAF's documented `geo_match_statement` behavior and the config
   review, not a live cross-border test.
3. `rate-limit` (priority 2) — blocks at `> 1000` requests / 5 min per IP, the exact threshold
   `detection.tf`'s API Gateway flood alarm already uses, deliberately, so "too many requests" means
   one thing across the stack.
4. Default action: allow. **No WAF rule inserts a header** — see below.

**The origin-secret header is sent by the distribution, not the WAF.** `custom_header` on the
`origin` block sets `X-Origin-Verify` on every request CloudFront forwards. It was originally a WAF
`insert_header` on the default action and on `edge-bypass`, which silently never worked: **AWS WAF
prefixes every header it inserts with `x-amzn-waf-`**, so Express received
`x-amzn-waf-x-origin-verify` while `requireOriginSecret` checked `x-origin-verify`. Three reasons the
distribution is the better home for it regardless of the prefix:

* It lands on **every** forwarded request, whichever rule allowed it. With WAF insertion, each
  terminating `allow` rule needs its own `custom_request_handling` block, and a future rule that
  forgets one silently 403s that traffic.
* The Terraform literal and the server literal are then identical and greppable from each other.
* It is the pattern AWS documents for this job ("Controlling access to content" in *Add custom headers
  to origin requests*). CloudFront **overwrites** a viewer-sent header of the same name before
  forwarding, so it cannot be spoofed through the distribution; a request straight to
  `origin.dev.bread-sheet.com` can send the name but not the 32-character value.

**Origin request policy: `Managed-AllViewerExceptHostHeader`, not `Managed-AllViewer`.** AWS's own
docs call out API Gateway origins by name here — they expect the `Host` header to carry the origin's
own domain, and forwarding the viewer's `Host` can break the origin. Excluding it doesn't touch
`Authorization` or any other header; CloudFront substitutes the origin's domain automatically. Caching
is fully disabled (`Managed-CachingDisabled`) — this is a dynamic API, not static assets like the
images distribution.

**`server/src/middlewares/requireOriginSecret.ts`** 403s any `/api/*` request lacking a correct
`X-Origin-Verify` header. It is mounted **below** `cors` in `app.ts` — deliberately, and see
`backend.md` § Middleware Stack for why: a 403 with no `Access-Control-Allow-Origin` is invisible to a
browser, which reports it as *offline* rather than as a 403. It is a no-op when `ORIGIN_VERIFY_SECRET` is unset — deliberately, unlike
this codebase's fail-fast convention for other config: local dev and any stage without a CloudFront
front end have nothing to check against, and that is a legitimate "off" state, not a misconfiguration.

**`app.set('trust proxy', 2)`**, up from `1`. Two proxy hops now sit in front of Express: CloudFront
(adds the viewer's IP to `X-Forwarded-For`) and API Gateway/the VPC link (the same "1" ADR 0003
already relied on — the VPC link itself adds no hop). Left at `1` here, every client behind one edge
location would share an `express-rate-limit` bucket as CloudFront's own edge IP.

**Three things found only by applying this, not by writing it:**

* **AWS WAF silently renames the headers it inserts**, so the origin-secret gate rejected 100% of
  `/api/*` traffic the moment the enforcing image reached `dev` (2026-09-12). `insert_header { name =
  "x-origin-verify" }` arrives at the origin as `x-amzn-waf-x-origin-verify` — documented behaviour,
  "to avoid confusion with the headers that are already in the request", and not suppressible. Fixed
  by moving the insertion to the distribution's `custom_header` (above), which sends the name
  verbatim. **The wider lesson:** the unit test for the gate set the header itself, so it asserted the
  same wrong name on both sides of the contract and passed — a test that stubs the producer of a
  cross-system contract cannot validate that contract. The symptom also arrived heavily disguised;
  see the CORS note in `backend.md`.

* **ACM certificate tags reject parentheses and commas** — same class of validation-regex surprise as
  the WAF ACL description in `backstops-budget.tf` (`docs/architecture-decision-records/0005-...md` § L4 has the
  exact regex), different resource. A `Name` tag reading `"... (CloudFront, us-east-1)"` failed
  `RequestCertificate` outright.
* **That failure landed mid-cutover and broke the live DNS record for several minutes.** The apply
  had already destroyed the old `aws_apigatewayv2_domain_name.server` (renamed to `.origin` via a
  `moved` block) before the cert error stopped it; `aws_route53_record.server`'s own update — which
  depends on the CloudFront distribution that never got created — never ran, so the live alias kept
  pointing at a custom-domain mapping that no longer existed. Fixed by correcting the tag and
  re-applying; the ADR's Phase 2 § implementation note has the full account. **The general lesson:** a
  `moved` rename that spans a resource the public DNS record depends on has a real outage window
  between "old thing destroyed" and "new thing created and DNS repointed" if anything in between
  fails — plan applies touching DNS-critical renames with that in mind.

**What's live.** All of it, as of 2026-09-12. The CloudFront/WAF layer — geo-restriction, rate
limiting, `disable_execute_api_endpoint` — has been live since 2026-09-09 and is what actually bounds
cost; that was the point of Phase 2. `requireOriginSecret` and the `trust proxy = 2` fix went live with
the first `dev` deploy after the Phase 2 merge, and that deploy is what exposed the `x-amzn-waf-` prefix
bug above: the gate enforced correctly and rejected everything, because nothing was sending the header
it checked for. The `custom_header` fix (no image rebuild needed) and the `cors` reordering are both
applied and deployed. Verified against the live edge: `/api/*` through the distribution reaches auth
(`401`) with CORS headers present, the preflight answers `204`, and the same path straight to
`origin.dev.bread-sheet.com` — with no header, or with a wrong value — still gets `403 forbidden`. The
ADR's Phase 2 § "State after the fix" has the full check table.

**One manual step remains.** `EDGE_BYPASS_SECRET` (the CI/keepalive header value) needs copying into
a GitHub Actions secret — no GitHub provider is configured here, so this isn't automatable from
Terraform:

```sh
terraform output -raw phase2_edge_bypass_secret | gh secret set EDGE_BYPASS_SECRET
```

`.github/workflows/test-native-e2e.yml` already reads it as `EXPO_PUBLIC_EDGE_BYPASS_SECRET` in the
Maestro job's env — set only there, never in `build-apk.yml`'s release build, so the value never ships
in a distributed APK (the header-attaching code in `lib/api.ts` ships everywhere; the secret value
that makes it fire does not).

### VPC link keepalive

`keepalive.tf` runs a 128 MB Lambda weekly (`rate(7 days)`) against `https://server.dev.bread-sheet.com/`.
A VPC link carrying no traffic for **60 days** goes `INACTIVE`; API Gateway then deletes its network
interfaces and every request fails for the minutes it takes to reprovision. The request must traverse
the custom domain — hitting the task directly does not reset the clock.

The ADR sketched an EventBridge *Scheduler* rule, which does not work: Scheduler's universal targets
invoke AWS API actions, not arbitrary HTTPS endpoints. Reaching a public URL needs either API
Destinations (which require a Connection with an auth scheme) or a function.

Test it without waiting a week — it throws on any non-2xx, so a broken ingress surfaces as a Lambda
error metric:

```sh
aws lambda invoke --function-name breadsheet-dev-vpclink-keepalive /dev/stdout
```

### RDS IAM bootstrap (required on any fresh instance)

The app authenticates with IAM tokens (`DB_AUTH=iam`, passwordless `DATABASE_URL`), so the master
credential is break-glass only — it is generated and rotated by RDS into Secrets Manager
(`manage_master_user_password = true`) and never enters Terraform state.

It has exactly one job. The `breadsheet_iam` role and its `rds_iam` grant live *inside* the
database, so a newly created instance does not have them and the task cannot connect:

```sh
SECRET=$(aws rds describe-db-instances --db-instance-identifier breadsheet-dev-database-1 \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
aws secretsmanager get-secret-value --secret-id "$SECRET" --query SecretString --output text
```

```sql
CREATE USER breadsheet_iam WITH LOGIN;
GRANT rds_iam TO breadsheet_iam;
GRANT ALL PRIVILEGES ON DATABASE breadsheet TO breadsheet_iam;
GRANT ALL ON SCHEMA public TO breadsheet_iam;
```

The schema grant is not redundant. Since PostgreSQL 15 the `public` schema is owned by
`pg_database_owner` and no longer grants `CREATE` to `PUBLIC`, so on this instance (18.3)
the database-level grant alone leaves `breadsheet_iam` unable to create tables and
`prisma migrate deploy` fails with `permission denied for schema public` — a second failure
that only appears once the authentication one is fixed.

The instance is private with an SG that admits only the task SG, so run this **through ECS Exec**
rather than from a workstation. Use the one-off psql task below, not the application service: the
bootstrap is most often needed precisely when the app task cannot start, and a task that crash-loops
on `db:deploy` never stays up long enough to exec into. The one-off task carries the same SG and
task role but runs `sleep`, so it is always available.

Restoring from a snapshot skips all of this — the role comes back with the data.

### Ad-hoc SQL access (one-off psql task)

There is no network path from a workstation to the database: it is `publicly_accessible = false`,
sits in the two private subnets, and the private route table has **no internet route at all** (no
NAT gateway), so making it public would not help — there is nowhere for the traffic to arrive from.
Its security group admits port 5432 from exactly one source, the task SG. Anything that connects has
to run inside the VPC wearing that SG.

The cheapest thing that satisfies that is a throwaway Fargate task running the stock `postgres`
image. It needs no Terraform: it reuses the existing execution and task roles (the task role already
carries the `ssmmessages` permissions ECS Exec needs, and `rds-db:connect` for `breadsheet_iam`).

**Prerequisite, once per workstation:** ECS Exec needs the Session Manager plugin, which the AWS CLI
does not bundle. On Arch/CachyOS it is the AUR package `aws-session-manager-plugin`; with no root,
AWS's Debian package can be unpacked into `~/.local/bin` instead:

```sh
curl -fsSL -o smp.deb https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb
ar x smp.deb && tar xzf data.tar.gz
install -Dm755 usr/local/sessionmanagerplugin/bin/session-manager-plugin ~/.local/bin/session-manager-plugin
```

**Register the task definition** (once per account — it survives, so this is skippable on later runs):

```sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws ecs register-task-definition --region eu-west-1 --cli-input-json "{
  \"family\": \"breadsheet-dev-psql\",
  \"requiresCompatibilities\": [\"FARGATE\"], \"networkMode\": \"awsvpc\",
  \"cpu\": \"256\", \"memory\": \"512\",
  \"executionRoleArn\": \"arn:aws:iam::${ACCOUNT}:role/breadsheet-dev-ecs-execution\",
  \"taskRoleArn\": \"arn:aws:iam::${ACCOUNT}:role/breadsheet-dev-ecs-task\",
  \"containerDefinitions\": [{
    \"name\": \"psql\", \"image\": \"postgres:18-alpine\", \"essential\": true,
    \"command\": [\"sleep\", \"3600\"]
  }]
}"
```

**Start it and exec in.** The SG and subnet are looked up rather than pinned, so this keeps working
across a rebuild:

```sh
SG=$(aws ec2 describe-security-groups --region eu-west-1 \
  --filters Name=group-name,Values="BreadSheet DEV SG Tasks" \
  --query 'SecurityGroups[0].GroupId' --output text)
SUBNET=$(aws ec2 describe-subnets --region eu-west-1 \
  --filters Name=tag:Name,Values="breadsheet-dev-subnet-az1-public" \
  --query 'Subnets[0].SubnetId' --output text)

TASK=$(aws ecs run-task --region eu-west-1 --cluster breadsheet-server-dev \
  --launch-type FARGATE --task-definition breadsheet-dev-psql --enable-execute-command \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)

# This waits for the task, not for the exec agent — that comes up a few seconds later, so a
# first `execute-command` may still fail with TargetNotConnectedException. Retry, or check:
#   aws ecs describe-tasks --region eu-west-1 --cluster breadsheet-server-dev --tasks "$TASK" \
#     --query 'tasks[0].containers[0].managedAgents'
aws ecs wait tasks-running --region eu-west-1 --cluster breadsheet-server-dev --tasks "$TASK"

aws ecs execute-command --region eu-west-1 --cluster breadsheet-server-dev \
  --task "$TASK" --container psql --interactive --command "/bin/sh"
```

`assignPublicIp=ENABLED` is required: with no NAT gateway, that public IP is the only way the task
can pull its image from Docker Hub. Note also that the id in `run-task` output under `attachments`
is the **ENI attachment** id, not the task id — passing it to `execute-command` yields a confusing
`InvalidParameterException`.

**Connect.** Mint an IAM token locally (valid 15 min) and paste it at the password prompt — the raw
form, not the URL-encoded one:

```sh
aws rds generate-db-auth-token --region eu-west-1 \
  --hostname breadsheet-dev-database-1.cna48wy46m01.eu-west-1.rds.amazonaws.com \
  --port 5432 --username breadsheet_iam
```

```sh
psql "host=breadsheet-dev-database-1.cna48wy46m01.eu-west-1.rds.amazonaws.com user=breadsheet_iam dbname=breadsheet sslmode=require"
```

Do not pass the token through a `run-task` env override: those are readable via `DescribeTasks`.
If the token is rejected with `Role "breadsheet_iam" does not exist`, the instance has not been
bootstrapped — connect as the break-glass master (`db_admin_1001`, password from Secrets Manager)
and run the bootstrap above.

**Clean up.** The container is a `sleep 3600`, so it exits on its own within the hour; stop it
sooner with `aws ecs stop-task --region eu-west-1 --cluster breadsheet-server-dev --task "$TASK"`.
Leave the task definition registered — it costs nothing and it is the fallback when the application
task is the thing that is broken.

For a GUI client instead (IntelliJ/DataGrip), the equivalent is an SSM-managed `t4g.nano` bastion
plus `aws ssm start-session --document-name AWS-StartPortForwardingSessionToRemoteHost`. That is
real Terraform and a standing ~\$4/mo, which is why the one-off task is the default.

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

Dev has no NAT gateway (~\$33/mo already avoided) and, since [ADR 0003](../architecture-decision-records/0003-always-on-production-cost-architecture.md),
no load balancer either. The remaining always-on costs are the Fargate task (~\$9/mo at
`256`/`512`), RDS `db.t4g.micro` + storage (~\$15/mo), one public IPv4 for task egress (~\$3.65/mo),
the two hosted zones (public + the Cloud Map private one, ~\$1/mo) and the RDS master credential in
Secrets Manager (~\$0.40/mo). **The API Gateway ingress costs nothing at
rest** — it is billed per request, so there is no longer an ingress tier to shed.

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
  the pause runs longer. For a pause of a month or more, use Tier 3 instead: there is no "stop for
  30 days" API, and a stopped instance still bills for its 20 GB of gp3.
- `aws_ecs_service.server` (`ecs.tf`) hardcodes `desired_count = 1`, and its
  `lifecycle.ignore_changes` only covers `task_definition`. Any `terraform apply` while paused —
  even for something unrelated — will see the drift and silently scale the service back to 1. Avoid
  `apply`ing while paused, or add `desired_count` to `ignore_changes` if pause/resume becomes
  routine.

**Tier 2 — retired.** This tier existed only to destroy the ALB, which no longer exists. Nothing in
the API Gateway ingress bills hourly, so there is nothing to tear down between sessions: an idle
HTTP API, VPC link and Cloud Map namespace cost approximately the private hosted zone's \$0.50/mo and
nothing else.

> One thing the ingress *does* need while idle: a VPC link that carries no traffic for **60 days**
> transitions to `INACTIVE`, and requests then fail for several minutes while API Gateway
> reprovisions its network interfaces. A weekly external uptime check against
> `https://server.dev.bread-sheet.com/` is enough to prevent that, and replaces the alerting the ALB
> health check used to provide. It must traverse the custom domain, not hit the task directly.

**Tier 3 — snapshot and delete RDS (long pauses; sheds DB storage too):**

For a pause of a month or more, stopping is the wrong tool: AWS force-restarts a stopped instance
after 7 days, and stopped or not you keep paying for the 20 GB gp3 volume and Performance Insights.
Deleting the instance leaves only manual-snapshot storage, billed on *used* data — cents for a dev
DB. With the ALB gone, RDS is now the largest single line item, so this tier is the main lever:

```sh
# ── Pause ─────────────────────────────────────────────────────────────────────
# 1. Manual snapshot. Manual (not automated) matters: automated backups are deleted with
#    the instance, manual snapshots outlive it and are not managed by Terraform.
aws rds create-db-snapshot --region eu-west-1 \
  --db-instance-identifier breadsheet-dev-database-1 \
  --db-snapshot-identifier breadsheet-dev-pause-$(date +%F)
aws rds wait db-snapshot-completed --region eu-west-1 \
  --db-snapshot-identifier breadsheet-dev-pause-$(date +%F)

# 2. Destroy the instance. `db_skip_final_snapshot = true` (the dev default) is fine — the
#    manual snapshot from step 1 is the copy that matters. Review the plan first.
terraform -chdir=terraform plan -destroy -var-file=environments/dev.tfvars -target=aws_db_instance.main
terraform -chdir=terraform destroy -var-file=environments/dev.tfvars -target=aws_db_instance.main

# ── Resume ────────────────────────────────────────────────────────────────────
# 3. Find the snapshot (the filter still works after the source instance is gone).
aws rds describe-db-snapshots --region eu-west-1 \
  --db-instance-identifier breadsheet-dev-database-1 --snapshot-type manual \
  --query 'sort_by(DBSnapshots,&SnapshotCreateTime)[-1].DBSnapshotIdentifier' --output text

# 4. BEFORE applying: check the image pin in ecs.tf against the revision that was live when
#    you paused. Terraform's task definition is created from ecs.tf, not from CI's latest
#    revision — see "the image pin drifts" below. Note the tag from the pre-pause service:
aws ecs describe-task-definition --region eu-west-1 --task-definition breadsheet-dev-server \
  --query 'taskDefinition.containerDefinitions[0].image' --output text

# 5. Recreate everything from the snapshot — one apply, no manual reconnection.
#    Restoring matters for more than the data: the `breadsheet_iam` role and its
#    `rds_iam` grant live INSIDE the database. A fresh (non-restored) instance has
#    neither, so the task will crash-loop on connect until they are recreated by
#    hand over the master credential (see § RDS IAM bootstrap).
terraform -chdir=terraform apply -var-file=environments/dev.tfvars \
  -var db_snapshot_identifier=breadsheet-dev-pause-YYYY-MM-DD

# 6. Verify, then delete the snapshot to stop paying for it.
aws rds describe-db-instances --region eu-west-1 --db-instance-identifier breadsheet-dev-database-1 \
  --query 'DBInstances[0].{status:DBInstanceStatus,endpoint:Endpoint.Address}' --output table
terraform -chdir=terraform plan -var-file=environments/dev.tfvars    # "No changes" once fully resumed
aws rds delete-db-snapshot --region eu-west-1 --db-snapshot-identifier breadsheet-dev-pause-YYYY-MM-DD
```

`db_snapshot_identifier` (`variables.tf`, default `""`) feeds `aws_db_instance.main.snapshot_identifier`.
Pass it **only on the resuming apply** — it is consumed at create time and is in the resource's
`lifecycle.ignore_changes`, so leaving it out of later applies is correct and will not plan a
replacement. Adding it to `dev.tfvars` instead would be a standing hazard: any future recreate would
silently restore month-old data.

What the destroy cascades to, and why that is the point:

| Resource | Why it's dragged in | On resume |
| --- | --- | --- |
| `aws_ecs_service.server` | depends on the task definition | recreated at `desired_count = 1` |
| `aws_ecs_task_definition.server` | `ecs.tf` interpolates `aws_db_instance.main.address` into `DB_HOST` / `DATABASE_URL` | re-rendered against the restored endpoint |
| `aws_iam_role_policy.ecs_task_rds_iam` | `iam.tf` scopes `rds-db:connect` to `aws_db_instance.main.resource_id` | re-scoped to the new resource ID |

**The image pin drifts — check it before every resume.** `aws_ecs_task_definition.server` has
`lifecycle.ignore_changes = [container_definitions]`, so the revisions CI push-deploys are never
reconciled into state: Terraform's copy stays frozen at whatever it last created, while the live
service moves on. That is harmless during normal operation (Terraform never touches the running
task definition) but decisive here, because the resume *creates* a task definition — from
`ecs.tf`, not from the live revision. Whatever `ecs.tf:42` pins is what the stack comes back on.
This was already wrong once: the pin was a SHA that is neither a commit in the repo nor a tag in
GHCR, so a resume would have failed on `CannotPullContainerError` and tripped the deployment
circuit breaker — *after* the DB restore, making a healthy snapshot look like the culprit. Confirm
the tag resolves before applying:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:fabelhaft-io/bread-sheet-server:pull&service=ghcr.io" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/fabelhaft-io/bread-sheet-server/manifests/<sha>   # want 200, not 404
```

A restored instance gets a **new `resource_id`** (`db-XXXX…`) even when the identifier and endpoint
hostname are unchanged. Since the IAM policy interpolates it, `apply` fixes it for free — but a
restore done by hand in the console would leave the old ID in place and IAM auth would fail with a
`PAM authentication` error that looks nothing like a permissions problem. Restore through Terraform.

Two more notes on the restore:
- Reusing the same `identifier` in the same account+region normally yields the **same endpoint
  hostname**, but nothing depends on that: `DB_HOST` is interpolated, not hardcoded. Confirm with the
  `describe-db-instances` query in step 5 rather than assuming.
- `db_name`, `username` and the master password come from the snapshot; RDS ignores those arguments
  on a restore. The `breadsheet_iam` user and its `rds_iam` grant live *inside* the database, so they
  come back with it — no re-grant needed. `aws_ecs_task_definition.server` has
  `ignore_changes = [container_definitions]`, which is irrelevant here: the task definition is
  destroyed and recreated, and ignore_changes does not apply to creation.

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
before `node dist/server.js`. When `DB_AUTH=iam`, the script mints an IAM token into a `DATABASE_URL`
scoped to that one command — so the migration engine authenticates with a short-lived token too, while
the server process keeps the passwordless URL and mints its own tokens. Prisma's migration lock
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

## Dependency Hygiene

Dependabot is configured in [`.github/dependabot.yml`](../../.github/dependabot.yml) with a weekly
schedule for **four** manifests: `/bread-sheet-app`, `/server`, `/agent-team` and `/terraform`.
`/agent-team` was added late — note that Dependabot *security* updates run against every manifest it
detects regardless of this file, but *version* updates only run for the directories listed here, so a
missing entry produces a directory that looks covered (security PRs arrive) while silently drifting
behind on routine releases.

Merging is gated by a repo **ruleset on `main` requiring 1 approving review**, so Dependabot PRs need
a human approval even when every check is green.

Routine remediation is a **two-pass** `npm audit fix --package-lock-only` in each of the three npm
projects. Two passes are required: the first leaves nested duplicate copies (e.g. `brace-expansion`
under `glob/`, `@expo/fingerprint/` and `@typescript-eslint/`) at the vulnerable version, and the
second collapses them.

### Accepted, un-remediable advisories

Two findings survive `npm audit fix` and are accepted rather than force-fixed. In both cases npm's
suggested "fix" is a **major downgrade**, which would cost more than the advisory does.

- **`mysql2` (high, `server/`).** `prisma` pins `mysql2` to an exact version, so npm's only offer was
  `prisma@6.19.3` — a major downgrade from 7.x. Resolved instead with an `overrides` entry in
  `server/package.json` pinning `mysql2` to a patched release. This is safe because the package is
  never loaded: BreadSheet is Postgres-only (`@prisma/adapter-pg`) and `mysql2` reaches the tree only
  as part of Prisma's multi-driver bundle. Verified after the override with `prisma validate`,
  `prisma generate` and the full server suite.
- **`deepmerge-ts` (high, `server/`).** Reaches the tree via `prisma → @prisma/config`. The patched
  release is a major (`8.x`) that `@prisma/config` does not declare support for, and the Prisma CLI
  runs on the deploy path (`scripts/start.sh` → `npm run db:deploy`), so an override here risks a
  deploy-time outage to fix a stack-exhaustion bug whose only input is our own `prisma.config.ts`.
  Left for Prisma to bump upstream.
- **`image-size` (high, `bread-sheet-app/`).** No patched release exists at all — the advisory range
  is `*`. Transitive via metro, i.e. build tooling; it is not in the shipped app bundle.

### `allowScripts` pins exact versions

`server/package.json` carries an `allowScripts` allowlist keyed by `name@exact-version`. **Bumping any
of those packages invalidates its entry**, and npm then silently blocks the install script rather than
failing. For `prisma`/`@prisma/engines` that means the engine postinstall stops running, which breaks
`prisma generate` and the Docker build. After any dependency bump, check `npm install` output for
`npm warn install-scripts` and refresh the pinned versions to match.
