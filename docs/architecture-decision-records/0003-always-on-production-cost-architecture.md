# Always-On Production Cost Architecture

* Status: Proposed
* Date: 2026-08-04

## Context and Problem Statement

BreadSheet is a private project funded out of pocket. The `dev` stage is a full Fargate stack
(ALB + Fargate + RDS + S3) and there is **no `prod` stage yet** — promotion is explicitly deferred
(see [infrastructure.md](../architecture/infrastructure.md) § Deployment Pipeline). We are therefore
choosing the production shape *before* paying for it, which is the cheapest moment to choose.

`dev` can be paused (three documented tiers, from `desired-count 0` to a snapshot-and-delete).
**Production cannot.** That inverts which costs matter: for an always-on stage, only the *flat*
standing charges count, and no amount of scheduling touches them. The question is what the minimum
credible always-on production stack costs, and how much of the current architecture survives the
answer.

### Measured baseline

Cost Explorer, account `493942067033`, `eu-west-1`, July 2026 — actual, not estimated:

| Usage type | July | Quantity |
|---|---:|---|
| `EU-LoadBalancerUsage` | $15.00 | 595 hr |
| `EU-InstanceUsage:db.t4g.micro` | $10.09 | 593 hr |
| `EU-PublicIPv4:InUseAddress` | $8.91 | 1,783 addr-hr (≈ 2.4 addresses) |
| `EU-Fargate-vCPU-Hours:perCPU` | $6.01 | 148 vCPU-hr |
| `EU-RDS:GP3-Storage` | $2.54 | 20 GiB |
| `EU-Fargate-GB-Hours` | $1.32 | 297 GB-hr |
| `HostedZone` | $0.50 | 1 |
| `EU-LCUUsage` | $0.01 | 0.80 LCU-hr |
| Tax (19%) | $8.43 | |
| **Total** | **$52.80** | |

The ~595 hr readings across ALB/RDS/Fargate show `dev` already ran only ~80% of the month. The
decisive figure is **`EU-LCUUsage` = $0.01**: the load balancer did one cent of actual work and
charged $15.00 for existing.

Normalised to a single 24/7 stage (730 hr), cloning this shape into production would cost:

| | $/mo |
|---|---:|
| ALB (hourly, flat) | 18.40 |
| RDS `db.t4g.micro` | 12.41 |
| Fargate 0.25 vCPU / 0.5 GB × 1 | 9.01 |
| RDS gp3 20 GiB (billed even when stopped) | 2.54 |
| Public IPv4 × 1 (task egress) | 3.65 |
| Route 53 hosted zone | 0.50 |
| **Subtotal** | **46.51** |
| **+ 19% tax** | **55.35** |

Every line is flat. **$22.05/mo of it (ALB + its two per-AZ public IPv4 addresses) buys TLS
termination and health checking for a service handling hobby-scale traffic.**

## Decision Drivers

* **Always-on is non-negotiable for prod.** Pause/resume tooling — the main `dev` cost lever — is
  inapplicable. Only flat cost reduction counts.
* **Private-project budget.** ~$55/mo per stage is not sustainable; ~$25–35/mo total is.
* **Learning value is an explicit goal, not a side effect.** The stack exists partly to teach cloud
  architecture. An option that saves money by hiding the architecture (managed PaaS) scores worse
  than one that saves money by exposing a new layer.
* **Latency at low traffic.** A private prod has trickle traffic. Any architecture whose cost model
  rewards idleness must be checked against what idleness does to the *first* request.
* **Preserve sunk work.** RDS IAM auth (ADR 0002), GCP WIF, the task/execution role split, and the
  push-based CD pipeline are built, documented and working. An option that discards them pays a real
  cost beyond dollars.
* **Registry stays external and free.** The server image lives on GHCR, deliberately not ECR.

## Considered Options

Three independent axes. They compose — the ingress choice does not constrain the database choice.

### Axis 1 — Ingress (the largest flat cost)

* **I-A — Keep the ALB.** Zero change. $18.40/mo + $7.30/mo for its two per-AZ public IPv4
  addresses. Buys layer-7 routing, TLS termination and target health checking we do not currently
  need at this scale.
* **I-B — API Gateway HTTP API → VPC Link v2 → Cloud Map, no load balancer.** ECS Service Discovery
  registers tasks into Cloud Map; the HTTP API integrates directly with the Cloud Map service via a
  VPC link. Verified supported: private integrations connect to "an Application Load Balancer,
  Network Load Balancer, **or resources registered with an AWS Cloud Map service**". No hourly
  charge — HTTP APIs bill ~$1.00 per million requests, custom domains and TLS are included. Keeps
  Fargate, and with it every piece of existing IAM/WIF/CD work.
* **I-C — Lambda container image + Function URL.** Same Docker image via `aws-lambda-web-adapter`.
  Kills ALB *and* Fargate *and* the task's public IP. Effectively $0 at free-tier traffic.
* **I-D — AWS App Runner.** Managed container service with TLS, custom domain and a free VPC
  connector; roughly $3–10/mo depending on instance size, mostly provisioned-memory charge.
* **I-E — Cloudflare Tunnel sidecar, no AWS ingress at all.** A `cloudflared` container in the same
  task definition establishes an outbound-only tunnel; Cloudflare terminates TLS at its edge and
  routes to the task. Kills the ALB with no AWS replacement — $0/mo, no per-request charge, and no
  API Gateway payload or timeout ceiling. Keeps Fargate and everything attached to it.

### Axis 2 — Database

* **D-A — RDS `db.t4g.micro` on demand.** $12.41 + $2.54 storage. Status quo; ADR 0002 IAM auth
  applies unchanged.
* **D-B — RDS with a 1-year no-upfront Reserved Instance.** Same instance, ~30% off the instance
  hour (~$8.40). No architectural change; a 12-month commitment.
* **D-C — Aurora Serverless v2, min 0 ACU (auto-pause).** Scales to zero, billing storage only when
  paused.
* **D-D — Supabase Postgres (free tier).** Supabase is already a dependency for auth. The free tier
  includes a Postgres database at $0.

### Axis 3 — The `dev` stage itself

* **S-A — Keep `dev` permanent**, paused nights/weekends via EventBridge Scheduler.
* **S-B — Make `dev` ephemeral.** `terraform apply` when actively learning something LocalStack
  cannot teach (real IAM, WIF federation, RDS TLS, cutover rehearsals); `terraform destroy`
  afterwards. Day-to-day development stays on the existing docker-compose + LocalStack environment,
  which already mirrors prod closely.

## Decision Outcome

**Chosen: I-B (API Gateway HTTP API + Cloud Map) + D-A now with D-B once stable + S-B (ephemeral
`dev`) — conditional on the step 0 gate below.**

The ingress half of this decision rests on an assumption that has not yet been measured: that the
synchronous Gemini paths complete inside API Gateway's **non-increasable 30 s** integration timeout,
down from the ALB's adjustable 60 s. Implementation step 0 settles it before anything is built, and
names **I-E** as the fallback if it fails. The database and `dev`-stage decisions are independent of
that gate and stand regardless.

Production target, 730 hr:

| | $/mo |
|---|---:|
| Fargate 0.25 / 0.5 × 1 task | 9.01 |
| RDS `db.t4g.micro` + 20 GiB gp3 | 14.95 |
| Public IPv4 × 1 (task egress to GHCR / Supabase / GCP) | 3.65 |
| Route 53 public hosted zone | 0.50 |
| API Gateway requests | ~0.10 |
| Cloud Map (1 registered resource + `DiscoverInstances`) + the namespace's Route 53 **private** hosted zone | ~0.61 |
| **Subtotal** | **28.82** |
| **+ 19% tax** | **~34.30** |

**≈ 38% below cloning the current shape**, and with S-B the `dev` stage contributes ~$0 at rest
instead of a second standing charge.

> The Cloud Map line is the one estimate in this table rather than a measured or list-price figure —
> a private DNS namespace creates a Route 53 hosted zone that bills like any other, plus a
> per-registered-resource charge and per-million discovery calls. Confirm it against the first
> month's Cost Explorer breakdown. The API Gateway pricing page lists **no hourly charge for VPC
> links on HTTP APIs**, which is why the VPC link itself has no line here; that too is worth
> confirming on the first bill, since VPC links V2 were only recently extended to REST APIs and the
> pricing page does not name them explicitly.

### Why not the cheaper options

**I-C (Lambda) is rejected despite being the cheapest — the cost model and the latency model point
in opposite directions.** Lambda is cheap precisely because it does not run when idle, and a private
production stage is idle nearly all the time. At trickle traffic essentially *every* user request
pays a cold start: container-image init + Prisma client construction + `pg` connection establishment
+ an RDS IAM token mint (ADR 0002), on top of an already-slow path when the Gemini plausibility gate
(`PLAUSIBILITY_MODE=gemini`) is involved. Barcode scanning is the app's primary interaction and is
latency-sensitive. Provisioned concurrency removes the cold start and also removes the saving.
**The $9.01/mo Fargate task is not a compute cost, it is the price of being warm** — and it is the
one flat charge in the stack that is clearly worth paying. (I-C remains a reasonable fit for a
*non*-latency-sensitive stage, which is the opposite of the intuition that cheap-at-idle suits a
quiet prod.)

**I-D (App Runner) is rejected on a hard blocker, not a preference.** The App Runner API's
`ImageRepository.ImageRepositoryType` accepts only `ECR | ECR_PUBLIC`, and `ImageIdentifier` is
regex-constrained to ECR hostnames. GHCR cannot be a source. Adopting it would mean adding an ECR
push to CD and abandoning the deliberate "registry is external and free" property, for a saving of
roughly $6/mo over the chosen option and materially less to learn.

**I-E (Cloudflare Tunnel) is rejected on the learning-value driver alone, and it is the closest
call in this ADR.** On cost it is a wash with I-B — $0 against ~$0.71/mo — and on simplicity it wins
outright: no Cloud Map, no SRV records, no VPC link, no stage-path mapping, no ACM certificate, and
critically **none of the API Gateway payload or integration-timeout ceilings** that make step 0
below a blocking gate. It loses on exactly one axis: it saves money by *removing* an architectural
layer rather than exposing one, which is the stated inverse of what this stack is for. It also
introduces a non-AWS runtime dependency in the request path of the only production stage.

That reasoning is honest but thin, so record the consequence plainly: **if step 0 shows the Gemini
paths cannot fit under 30 s and the asynchronous rework is judged too large, I-E is the fallback,
not the ALB.** It reaches the same cost target without the timeout constraint.

**D-C (Aurora Serverless v2) is rejected as a trap for this workload.** Auto-pause requires sustained
inactivity; any trickle of real production traffic keeps the cluster awake, and awake costs a 0.5 ACU
floor — several times a `db.t4g.micro` on a 24/7 basis. It optimises for bursty-then-silent, and a
low-but-nonzero-traffic prod is the one shape where it reliably loses. It would be a good fit for an
ephemeral `dev`, where genuine multi-day silence is the norm.

**D-D (Supabase Postgres) is deferred, not rejected.** It is the cheapest credible database at $0 and
consolidates on an existing dependency. It is not chosen now because it would discard the working RDS
IAM auth from ADR 0002, concentrate both auth and primary data in one free-tier vendor, and free-tier
projects pause after sustained inactivity.

RDS is ~52% of the target bill the moment the ingress change lands, so "revisit when it becomes
dominant" is a prediction, not a trigger — and deferrals with no trigger become permanent by
default. **The trigger is therefore D-B, not D-D:** the Reserved Instance is the intended answer for
the RDS line (~$12.41 → ~$8.40, no architectural change, no vendor concentration). D-D is reopened
only if the RI is declined *and* the RDS line still needs to fall — i.e. it is the answer to a
budget problem, not to an architecture problem.

**S-A vs S-B:** scheduling `dev` saves ~$13/mo of compute but cannot touch its $22/mo of ALB + IPv4.
Destroying it saves all of it. The stack is fully Terraform-owned with a documented snapshot/restore
path, so recreation is a known quantity — and repeated create/destroy cycles surface hidden
dependencies (cert validation, IAM resource IDs, image pin drift) far better than an idling stack
does. `dev` keeps its ALB; it simply stops existing between sessions.

### Positive Consequences

* Removes the largest flat cost in the architecture without touching compute, the database, the CD
  pipeline, the task/execution role split, RDS IAM auth (ADR 0002), or GCP WIF.
* Production stays permanently warm — no cold-start regression on the app's primary interaction.
* Exposes three layers the ALB was hiding: Cloud Map service discovery, VPC links, and API Gateway
  request/stage mapping. Net *increase* in architectural surface learned, while cutting cost.
* `dev` and `prod` diverge in ingress only, which is a useful comparison to have running.
* Prod is greenfield, so this is a build decision rather than a migration — no cutover risk.

### Negative Consequences

* **The integration timeout drops from 60 s (adjustable to 4000 s) to 30 s (not increasable).** The
  ALB's `idle_timeout` is unset in `alb.tf`, so prod inherits the AWS default of 60 s today and could
  be raised at will. HTTP APIs cap the integration timeout at 30 seconds with `Can be increased: No`.
  Two paths are exposed: `uploadImage` runs the Gemini plausibility gate **synchronously, before the
  S3 write** (deliberately — that is what prevents orphans), and `VISION_MODE=llm` does
  image → `ExtractedLabel` JSON in a single Gemini multimodal call on `POST /api/products/extract-label`.
  Both are image-sized LLM round-trips on the app's primary contribution flow, and a breach is a 504
  with the user's upload lost. This is the same class of hard, documented ceiling used to reject I-D
  above, so it gets the same treatment: **step 0 is a blocking gate on the whole decision.**
  Payload size is *not* at risk — `MAX_IMAGE_BYTES` in `features/products/constants.ts` caps client
  uploads at 2 MB against API Gateway's 10 MB limit.
* **The ingress can go cold even though compute stays warm.** A VPC link that carries no traffic for
  60 days transitions to `INACTIVE`; API Gateway deletes its network interfaces and dependent
  requests **fail** until it reprovisions, which takes minutes. This is a weaker form of the very
  argument used to reject I-C — rarer (60 days, not seconds) but worse when it fires (failures, not
  latency). It also qualifies the claim that $9.01/mo buys being warm: it buys a warm *task* behind
  an ingress that can still go cold. Mitigated by the keepalive in Implementation step 4, which is
  required rather than optional.
* API Gateway's request-based pricing is unbounded in principle. At hobby traffic it is cents, but
  unlike the ALB's flat rate there is no ceiling. A billing alarm is required, not optional.
* Losing the ALB means losing target-group health checking; container-level health checks must
  replace it or a wedged task stays registered in Cloud Map indefinitely. This is a correctness
  requirement, not a nicety — see Implementation step 2.
* **Deployments lose connection draining.** The ALB target group provides a deregistration delay;
  Cloud Map does not. During a rolling deploy, API Gateway can still resolve a draining task through
  a TTL-15 SRV record, so a small number of in-flight requests may fail per deploy. Acceptable at
  hobby traffic and with the deployment circuit breaker still active, but it is a real property
  given up, not merely a control surface moved.
* `dev` and `prod` no longer share an ingress shape, so the rehearsal value of `dev` drops for that
  one layer unless `dev` is periodically brought up in the prod configuration.
* Ephemeral `dev` adds friction: nothing is reachable without an `apply` first, and the image pin in
  `ecs.tf` must be checked before each recreate (a known hazard already documented).
* An RDS Reserved Instance (D-B) is a 12-month financial commitment on a private project.

## Implementation

Prod does not exist yet, so **there is no cutover** — the new ingress shape is built directly into
the new stage. Step 0 gates the decision itself; steps 1–2 are prerequisites that apply to any
ingress; steps 3–5 are the prod build; step 6 is partly required and partly deferred.

### 0. Measure the Gemini paths against the 30 s cap (**blocking gate**)

Before building anything, measure p99 latency of the two endpoints that make synchronous Gemini
calls, against the **current** `dev` ALB with `PLAUSIBILITY_MODE=gemini` and `VISION_MODE=llm`:

* `POST /api/products/extract-label` — image → `ExtractedLabel` JSON, one multimodal call.
* the image upload path through `uploadImage` — plausibility gate, synchronous, pre-S3-write.

Use realistic worst-case inputs: a 2 MB image at `MAX_LABEL_IMAGE_LONGEST_EDGE` (1600 px), on a cold
Vertex connection, not a warmed-up local fixture. The `request:finish` log line already carries
`durationMs`, so the data is available from CloudWatch without new instrumentation.

* **p99 comfortably under ~20 s** — proceed with steps 1–6 as written.
* **p99 near or above 30 s** — do not proceed directly. Either make the plausibility gate
  asynchronous (upload → `202` → poll or push), which also decouples the no-orphans guarantee from
  request duration and is the better design independently; or fall back to **I-E (Cloudflare
  Tunnel)**, which hits the same cost target with no timeout ceiling.

Retaining the ALB is *not* a fallback: it reinstates $18.40/mo and erases the entire saving this
ADR exists to capture.

### 1. Make `dev` ephemeral (do first — it funds the rest)

Document the destroy/recreate cycle in `infrastructure.md` alongside the existing Tier 1–3 pause
runbooks, as a fourth "Tier 4 — destroy". Before each recreate, verify the `ecs.tf` image pin
resolves in GHCR (the runbook's existing `ghcr.io/token` check) — it has already been wrong once.

Retain the manual RDS snapshot workflow from Tier 3 as the data-preservation mechanism.

The only Terraform change is the DNS carve-out below; everything else is runbook.

> **Exclude the hosted zone and its certificate from the destroy cycle.** `aws_route53_zone.dev` is
> delegated from the parent `bread-sheet.com` zone, which is **not** managed by this Terraform root.
> Destroying and recreating it mints a new NS set every cycle, requiring a manual delegation update
> at the parent before anything resolves — and `aws_acm_certificate.server` validates *through* that
> zone, so the certificate re-issue blocks behind the same manual step. Protect both with
> `lifecycle { prevent_destroy = true }` (or move them to a separate long-lived root). This keeps
> $0.50/mo standing, which is the correct trade against a manual DNS step on every recreate.

### 2. Add a container health check (**blocking prerequisite**)

`ecs.tf`'s `container_definitions` currently has **no `healthCheck` block** — today the ALB target
group is the only thing that detects and replaces a wedged task. Without a load balancer, ECS has no
liveness signal at all.

```hcl
healthCheck = {
  command     = ["CMD-SHELL", "curl -fsS http://localhost:3000/ || exit 1"]
  interval    = 30
  timeout     = 5
  retries     = 3
  startPeriod = 150   # migrations run before serving; ALB grace was 120s
}
```

`GET /` is the existing ALB health-check target, so the endpoint is already proven. `startPeriod`
must cover `scripts/start.sh` running `npm run db:deploy` before `node dist/server.js`. Confirm
`curl` exists in the runtime image; if not, use a `node -e` one-liner instead.

Removing the `load_balancer` block also removes the service's `health_check_grace_period_seconds`
(it is ALB-only) — `startPeriod` is its replacement, hence the 150 s.

### 3. ECS Service Discovery → Cloud Map, with **SRV records**

Create a private DNS namespace and a service, and attach it to the ECS service via
`service_registries`.

> **Constraint, easy to get wrong:** AWS documents that "if you use Amazon ECS to populate entries in
> AWS Cloud Map, you must configure your Amazon ECS task to use **SRV records** with Amazon ECS
> Service Discovery or turn on Amazon ECS Service Connect." API Gateway resolves instances via
> `DiscoverInstances` and requires the registered attributes to include **both IP address and port**.
> Plain `A` records carry no port and will not work. With `awsvpc` networking, an SRV registration
> requires `container_name` and `container_port` on the `service_registries` block.

```hcl
resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "breadsheet-prod.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "server" {
  name = "server"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    dns_records { type = "SRV", ttl = 15 }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config { failure_threshold = 1 }
}

# on aws_ecs_service.server:
service_registries {
  registry_arn   = aws_service_discovery_service.server.arn
  container_name = "server"
  container_port = 3000
}
```

> **If this is ever retrofitted to `dev`:** `service_registries` is `ForceNew` in the AWS provider —
> adding it to an existing ECS service **replaces the service**. Irrelevant for greenfield prod;
> decisive if the change is backported.

### 4. VPC Link v2 + HTTP API + custom domain

```hcl
resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "breadsheet-prod-vpclink"
  subnet_ids         = [for s in aws_subnet.public : s.id]
  security_group_ids = [aws_security_group.vpclink.id]
}

resource "aws_apigatewayv2_api" "main" {
  name          = "breadsheet-prod-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "server" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id
  integration_uri    = aws_service_discovery_service.server.arn
}

resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.server.id}"
}
```

> **VPC links V2 are immutable:** subnets and security groups cannot be changed after creation.
> Getting `aws_security_group.vpclink` (step 5) wrong means *replacing* the link, which is an
> ingress outage, not an in-place update. Same genre of hazard as the `service_registries` ForceNew
> note above — settle the security group before the first apply. Confirm also that the chosen
> subnets sit in VPC-link-supported AZs; `eu-west-1` supports `euw1-az1/az2/az3`, so the existing
> `az1`/`az2` AZ-ID pinning in `variables.tf` is safe.

> **Keepalive (required).** A VPC link carrying no traffic for **60 days** goes `INACTIVE`: API
> Gateway deletes its network interfaces and dependent requests **fail** until it reprovisions,
> which takes minutes. A private prod can plausibly be silent that long. Add an EventBridge
> Scheduler rule hitting `GET /` through the public custom domain — weekly is ample against a 60-day
> window, and it must traverse the VPC link (not the task directly) to count. A free external uptime
> monitor satisfies this too, and is worth having anyway now that the ALB health check is gone.

Two path/stage details:

* **Use the `$default` stage with `auto_deploy = true`.** Private integrations prepend the stage name
  to the backend path (`/test/{route-path}`), which would break every route. `$default` emits no stage
  prefix. If a named stage is ever needed, add a parameter mapping overwriting the path to
  `$request.path`.
* Private integration traffic is **HTTP by default**, which is correct here — TLS terminates at API
  Gateway and the hop to the task stays inside the VPC, exactly as it did with the ALB.

Custom domain: `aws_apigatewayv2_domain_name` (regional) + `aws_apigatewayv2_api_mapping`, with an
ACM certificate in `eu-west-1` — the same region requirement the ALB had, so the existing
certificate pattern in `alb.tf` carries over unchanged. Route 53 becomes an A-alias to the API
Gateway regional domain's `target_domain_name` / `hosted_zone_id` instead of the ALB's.

### 5. Security groups

The chain becomes `internet → API Gateway (managed) → VPC link ENI → task(:3000) → RDS(:5432)`.
Mirror the existing pattern in `security.tf` — each hop references the previous group's id, no CIDRs:

* new `aws_security_group.vpclink` — egress to the task SG on 3000.
* task SG ingress on 3000 sources from the **VPC link SG** rather than the ALB SG.
* task SG keeps `assign_public_ip = true` and its egress: it still pulls from GHCR and reaches
  Supabase, GCP (WIF/Vertex) and SSM through the IGW. This is why the one remaining $3.65/mo public
  IPv4 address stays — removing it would require NAT at ~$33/mo, which is strictly worse.
* RDS SG unchanged.

### 6. Guardrail (required) and RDS Reserved Instance (later)

* **Billing alarm** — an AWS Budget with an alert at ~$40/mo. This is the mitigation for trading a
  flat ALB charge for per-request pricing and should land with step 4, not after.
* **RDS RI** — once prod has run stably for a month or two, buy a 1-year no-upfront Reserved
  Instance for the `db.t4g.micro` (~$12.41 → ~$8.40). Purely financial; no resource change. Defer
  until the instance class is settled, since an RI is locked to it — and specifically **do not buy
  until step 0 has resolved.** If the Gemini paths force the asynchronous-upload rework, the write
  pattern against the database changes shape, and a 12-month commitment to an instance class should
  not be made ahead of that.

### Not in scope

Retrofitting `dev` to the API Gateway ingress. `dev` keeps its ALB and simply stops existing between
sessions (step 1), which is cheaper than rebuilding it. Revisit only if `dev` needs to rehearse the
prod ingress specifically.

## References

* [Create private integrations for HTTP APIs in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-private.html)
  — supported targets (ALB / NLB / Cloud Map), the ECS **SRV record** requirement, and the stage-in-path behaviour.
* [Quotas for configuring and running an HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html)
  — **maximum integration timeout 30 s, `Can be increased: No`**, and payload size 10 MB. The basis for step 0.
* [API Gateway integration timeout limit increase beyond 29 seconds](https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/)
  — the 2024 increase applies to **REST** Regional and private APIs, *not* HTTP APIs. Confirms the 30 s cap is not negotiable here.
* [Set up VPC links V2 in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-vpc-links-v2.html)
  — the **60-day `INACTIVE`** transition and ENI deletion, V2 immutability, and supported AZs per Region.
* [App Runner `ImageRepository` API reference](https://docs.aws.amazon.com/apprunner/latest/api/API_ImageRepository.html)
  — `ImageRepositoryType` valid values `ECR | ECR_PUBLIC`, the basis for rejecting I-D.
* [ADR 0002 — RDS Database Credential Strategy](0002-rds-database-credentials.md) — the IAM auth this
  decision preserves.
* [infrastructure.md](../architecture/infrastructure.md) — current dev stack, the Tier 1–3 pause
  runbooks, and the Terraform ↔ CD ownership split.
