# Cost Blast Radius and Emergency Stop

* Status: **Accepted — Phase 1 and Phase 2 implemented** (2026-09-09, same day; Phase 2's app-code piece — `requireOriginSecret`, `trust proxy = 2` — is on a feature branch pending merge to `main` and a `dev` image rebuild, see Phase 2's implementation note)
* Date: 2026-09-09

## Context and Problem Statement

BreadSheet is funded out of one private credit card. [ADR 0003](0003-always-on-production-cost-architecture.md)
optimised the stack for *flat* cost and, in doing so, deliberately traded a flat \$18.40/mo ALB for
**per-request** API Gateway pricing. Step 6 of that ADR named the mitigation — "an AWS Budget with
an alert at ~\$40/mo" — and `terraform/budget.tf` delivers it.

An alert is not a stop. The question this ADR answers is: **when the bill starts running, what
actually halts it, how fast, and who is holding the card when it does?**

The trigger is not hypothetical abuse research. It is the specific shape of this stack: a public,
unauthenticated-signup API in front of a paid multimodal model, with a world-readable S3 bucket
beside it, three separate vendors billing independently, and exactly one budget watching one of
them.

## The stack as it stands — why our options are what they are

Reading order for the rest of this ADR. Everything below follows from these three facts.

### 1. We run an HTTP API, not a REST API

`terraform/api-gateway.tf:2` creates `aws_apigatewayv2_api` with `protocol_type = "HTTP"`. That
choice came from ADR 0003 — HTTP APIs cost \$1.00/M against REST's \$3.50/M, and only HTTP APIs
support the Cloud Map private integration that let us delete the load balancer.

The bill for that saving is the entire per-client cost-control catalogue:

| Control | REST API (v1) | **HTTP API (v2) — what we run** |
|---|:---:|:---:|
| API keys | ✅ | ❌ |
| Usage plans — requests/day, requests/month quotas | ✅ | ❌ |
| Per-client rate limiting | ✅ | ❌ |
| AWS WAF (incl. geo match, IP sets, rate rules) | ✅ | ❌ |
| Resource policy (`aws:SourceIp` allowlist) | ✅ | ❌ |
| Mock integration (a free "return 429" sink) | ✅ | ❌ |
| Stage + per-route throttling (rate/burst) | ✅ | ✅ |
| JWT authorizer | ❌ | ✅ |

Every piece of generic "protect your API Gateway" advice — usage plans, API keys, WAF rules —
is written for the API type we do not have. **The only native control we own is stage and per-route
throttling**, and `aws_apigatewayv2_stage.default` currently sets none, so we sit at the account
default of 10,000 rps.

### 2. Throttling does not cap the API Gateway line item

API Gateway bills on **calls received**. A request throttled to a 429 *by the gateway itself* is
still a billable call. So the stage throttle bounds everything *behind* the gateway — Gemini, S3
writes, the resize Lambda, RDS — but it does not bound the gateway's own charge.

At the current account-default 10,000 rps, the theoretical ceiling is 864M requests/day ≈
**\$864/day** on the API Gateway line alone. Nothing in the stack prevents that today.

**There is exactly one escape from this, and it is not on API Gateway.** A **CloudFront flat-rate
pricing plan** carries *no overage charges regardless of traffic spikes or attacks* — exceeding the
allowance degrades delivery rather than billing. Requests blocked by the plan's included WAF never
reach the origin and never count against the allowance. So traffic filtered at a flat-rate
CloudFront edge costs nothing and never becomes an API Gateway call. This is the only true hard cap
available on the AWS side, and it is why L5 exists below. It caps CloudFront, **not** what sits
behind it.

### 3. Three vendors bill us; one budget watches one of them

| Surface | Billed by | What bounds it today | Worst case |
|---|---|---|---|
| API Gateway requests | **AWS** \$1.00/M | nothing (10,000 rps default) | ~\$864/day |
| S3 `GetObject` egress | **AWS** \$0.09/GB | nothing — `s3.tf:29` grants `Principal: "*"` read on `processed/*`, CORS `*` | ~\$92/TB, bypasses the API entirely |
| CloudWatch Logs ingestion | **AWS** ~\$0.57/GB | request volume (`retention_in_days = 1` caps storage, not ingest) | scales with the flood |
| Gemini / Vertex AI | **Google** ~\$0.0036–0.013/call | nothing — see below | **\$311–1,089/day, invisible to `budget.tf`** |
| Fargate task | AWS | `desired_count = 1`, no autoscaling | flat \$9.01/mo |
| RDS + gp3 storage | AWS | `rds.tf:21` hardcodes `max_allocated_storage = 100` (the `db_max_allocated_storage` variable, default 50, is **unused**) | flat, +~\$10.16 at ceiling (80 GiB × \$0.127) |
| Anonymous Supabase sessions | — | Supabase rate-limits anonymous sign-in per IP/hour; free tier pauses, Pro ships a spend cap **on** | not a cost event — but it is the *abuse* surface that makes the Gemini row reachable |

Three things fall out of this table.

**The two fears are independent, and that is the most important sentence here.** ADR 0003 traded a
flat \$18.40 ALB for a \$1.00/M gateway line — that added exactly *one* per-request cost, and it is
bounded by ten lines of HCL. The frightening tail is unbounded Gemini spend from a public upload
endpoint, which **existed before ADR 0003 and which the ALB never protected**. Keeping the ADR 0003
saving and closing the tail are not alternatives; there is nothing to choose between.

**The expensive incident is on the wrong card, and it is bigger than the AWS one.**
`POST /api/products/upload-image` (`server/src/routes/productRoutes.ts:57`) is `requireAuth` only —
anonymous sessions reach it — and every call runs the `PLAUSIBILITY_MODE=gemini` check before the
S3 write. `imagePlausibilityService.ts:7` pins `gemini-3.5-flash`, billed on Vertex at **\$1.50/M
input, \$9.00/M output**. A 1600 px image tiles to roughly 1,550 image tokens plus ~350 of prompt:

| | Per call | Per day at 1 rps |
|---|---:|---:|
| No thinking (~80 output tokens) | ~\$0.0036 | **~\$311** |
| Default thinking (~1,000 thinking tokens) | ~\$0.0126 | **~\$1,089** |

Gemini 3.x bills internal reasoning as output at the full rate, and **there is no `thinkingConfig`
anywhere in `server/src`** — so a four-field classification is paying for reasoning it does not need.
Setting a zero or minimal thinking budget is the single cheapest cost fix available, and it is
**implementation step 2** below because it decides what L2's cap can be.

**Confirmed 2026-09-09 (step 2).** Both call sites now set `thinkingConfig: { thinkingBudget: 0 }`
and log per-call token counts + cost via `services/geminiUsage.ts`. `npm run measure:gemini -- --n 10`
against a local server (`GEMINI_API_KEY`, real label photo, `thoughtsTokenCount: 0` on every call)
measured:

| Call site | n | avg input tokens | avg output tokens | avg \$/call |
|---|---:|---:|---:|---:|
| `imagePlausibilityService` (`plausibility`) | 10 | 1,410 | 45.5 | \$0.002524 |
| `labelExtractionLlmService` (`label-extraction`) | 10 | 1,832 | 207.1 | \$0.004612 |
| blended (equal mix) | 20 | — | — | **\$0.003568** |

This lands almost exactly on the \$0.0036 "no thinking" estimate above — the estimate was right, thinking
was the whole gap. It confirms L2's 300/day target: 300 × \$0.003568 × 30 ≈ **\$32.11/mo**, matching the
\$32.40/mo the sizing rule below was built against. `GEMINI_DAILY_CALL_CAP` can go to 300 once L2
(step 5) exists — this step only unblocks that number, it doesn't raise the cap itself (no cap
exists yet on `dev`).

**The bulkhead I wanted to claim is weaker than it looks.** `ecs.tf` runs one 256-CPU / 512 MB task
with no autoscaling, which does bound *CPU-bound* work. But a plausibility call is `await`-bound: at
~13 s measured latency (ADR 0003 step 0b) and 1 rps arrival, ~13 concurrent 4 MB buffers is ~52 MB
against a ~124 MB baseline in 512 MB. The task will sustain 1 rps comfortably. Concurrency here is
memory-bound, not CPU-bound, and memory is not the constraint. **Do not count the single task as a
Gemini guardrail.**

**And `express-rate-limit` saves nothing at the gateway.** `apiLimiter` (100 req/15 min per IP)
runs *after* API Gateway has received, routed and billed the request. It protects the task; it does
not protect the bill. It is also per-IP, which a distributed flood defeats by construction.

> Aside, worth a separate fix: `server/src/app.ts:19` sets `trust proxy: 1` with a comment reading
> "Behind the Fargate ALB". The ALB has been gone since ADR 0003. Whether `req.ip` still resolves to
> the real client behind the VPC link should be verified rather than assumed, since every IP-keyed
> limiter depends on it.

### Who legitimately talks to `dev` — the traffic the caps must not break

Every cap below is sized against real consumers, and the list is longer than "a handful of phones":

| Consumer | Shape | Gemini calls |
|---|---|---|
| Dev team devices | bursty: the Home tab fires several requests in parallel on launch and on pull-to-refresh | 2 per product added (photo + label) |
| **CI — `test-native-e2e.yml`** | runs on **every pull request to `main`** (and on dispatch); the repo variable `EXPO_PUBLIC_API_URL` points the Maestro emulator at `https://server.dev.bread-sheet.com`. The two flows (`barcode-scan.yaml`, `manual-entry.yaml`) scan and look up barcodes only | none today — but a future flow through Add Product would spend them on every PR |
| `npm run measure:gemini` (ADR 0003 step 0b) | 30 serial requests to each of the two Gemini endpoints | **60 per run** |
| `vpclink-keepalive` Lambda | one `GET /` a week | none |
| Playwright E2E (`test.yml`) | runs against a local Expo web build, **not** `dev` | none |

"An E2E suite left pointed at `dev`" was listed as a hypothetical source of a surprise bill in the
first draft of this ADR. It is not hypothetical; it is the current configuration. It is harmless
today because the flows never touch the Gemini paths, but it is legitimate traffic that the throttle
burst must absorb and that any future Add Product flow would turn into a per-PR Gemini spend.

## Decision Drivers

* **Speed of stop.** The gap between "something is wrong" and "spending has stopped" is the whole
  problem. Hours is not acceptable when the ceiling is \$864/day.
* **Coverage of all three bills.** An AWS-only control leaves the largest per-unit cost unguarded.
* **Do not reopen ADR 0003.** Returning to REST API or adding a load balancer would undo the
  saving this stack was rebuilt to capture.
* **Cheap at rest.** A guardrail that costs \$15/mo to protect a \$45/mo budget is self-defeating.
* **Reversible by one person on a phone.** The stop must be triggerable and undoable without a
  laptop and without a Terraform apply if possible.
* **A false positive must not be expensive.** Locking out the actual dev team — or CI — is a real
  cost.
* **Caps are sized for detection, not for a month of nobody looking.** A cap tight enough to hold
  the bill under budget through thirty undetected days is too tight to develop against. The
  operative worst case is the daily burn multiplied by the time it takes someone to notice, and
  detection is cheap to buy — so buy it, and size the caps against it.

## Considered Options

### E-A — AWS Budget Actions only

Extend `budget.tf` with `aws_budgets_budget_action`. **Rejected as the primary mechanism.**
Budget actions can apply an IAM/SCP deny, stop EC2 instances, or stop RDS instances. They *cannot*
scale an ECS service or touch API Gateway — so under attack, the deny policy would stop **us**
deploying a fix while the flood continued. Budgets also re-evaluate roughly three times a day,
putting worst-case latency near 8 hours.

Retained as a **slow-lane backstop only**: an action that stops the RDS instance is a meaningful
last resort for a runaway that nothing else caught.

### E-B — CloudWatch alarm → SNS → panic Lambda

An alarm on the `AWS/ApiGateway` `Count` metric for our `ApiId` publishes to the existing
`aws_sns_topic.billing_alerts`, which invokes a Lambda that takes the actions Budget Actions cannot.
Latency is one alarm period (minutes). **The alarm is chosen (it is the core of the detection
layer D); the Lambda is documented, not built** — see proportionality.

### E-C — Return to REST API for usage plans and WAF

Buys quotas, per-client throttling and WAF in one move. **Rejected:** 3.5× per-request price,
loses the Cloud Map private integration, and directly reverses ADR 0003's ingress decision. We would
be paying more per request for the privilege of limiting requests.

### E-D — CloudFront in front, on a flat-rate pricing plan

Two distinct propositions that this ADR initially conflated.

**Pay-as-you-go CloudFront: rejected.** Edge egress is 5.5% cheaper per GB than S3 (\$0.085 vs
\$0.09) but requests are 3× dearer than S3 GETs (\$1.20/M vs \$0.40/M) and 20% dearer than API Gateway
(\$1.20/M vs \$1.00/M). At our object sizes it is a wash on S3 and a loss on the API. It moves the
bill; it does not cap it.

**Flat-rate plan CloudFront: chosen.** The **Free** tier is \$0/mo for 1M requests and 100 GB, and
carries **no overage charges** — verbatim from the plan documentation: *"you will not incur overage
charges, regardless of how much you exceed your allowance."* Over the allowance AWS adjusts delivery
(fewer or more distant edge locations, proportional to the excess, first spike to 3× accommodated),
it does not bill. The plan also absorbs the WAF web ACL and its request fees, the distribution's
CloudWatch Logs ingestion, the TLS certificate, and (optionally) a Route 53 hosted zone.
**WAF-blocked and DDoS-blocked requests never count against the allowance.**

Three plan facts that the first draft left open, now settled from the same documentation:

* **A WAF web ACL is mandatory** for as long as the plan is active; it cannot be detached without
  reverting the distribution to pay-as-you-go.
* **Quotas: 3 Free plans per account, 100 plans total, 1 apex domain per plan.** Each plan covers
  one distribution. L5 spends one Free plan, the Phase 2 API distribution spends a second, and one
  is spare. The question that gated the API distribution in the first draft is closed.
* **The one leak in "no overage": an attached Route 53 zone.** If DNS queries exceed the plan's
  allowance, AWS may automatically transition the *hosted zone* back to pay-as-you-go. That does not
  affect the distribution, but it is a meter re-entering a design whose point is to have none.
  **Decision: do not attach the hosted zone to either plan.** It costs \$0.50/mo on pay-as-you-go
  and ALIAS queries to CloudFront are free anyway; the saving is not worth the exception.

That converts CloudFront from a cost-shifting exercise into the only structural cost ceiling
available on AWS. It is the mirror of E-F on the Google side: L4 hard-stops Google, L5 hard-stops
anything served through CloudFront.

### E-E — Application-level spend counter on the Gemini paths

A persisted per-day count of model calls; past the cap, return 503 without calling Gemini.
**Chosen.** It is the only control an attacker cannot route around by distributing source IPs or
cycling anonymous accounts, and it is the only one that defends the Google bill from inside.

### E-F — GCP billing kill switch

A Google Cloud budget → Pub/Sub → Cloud Function calling
`cloudbilling.projects.updateBillingInfo` with an empty `billingAccountName`, plus a Vertex AI
per-project quota override on Gemini requests-per-minute. **Chosen.** This is the only true hard cap
available anywhere in the stack: it detaches the billing account and the project stops serving. AWS
sells no equivalent.

### E-G — A detection layer, so the caps can be sized in days rather than months

Three free signals, all fanning into the existing `aws_sns_topic.billing_alerts`:

* **AWS Cost Anomaly Detection** — an account-level monitor with a subscription to the topic. Free.
  Daily granularity; catches a step change in any AWS line item, including ones this ADR did not
  think of.
* **CloudWatch alarms** — on `AWS/ApiGateway` `Count` for our `ApiId` (minutes), and on a
  **metric filter over the server log group** counting `request:finish` lines for the Gemini paths
  (minutes, and **no application code**: the log line already carries `path`). The filter is what
  turns "how many Gemini calls in the last hour" into an alarm.
* **A GCP budget alert** on project `breadsheet-496522` at a low absolute threshold — the same
  budget resource L4 needs, with email thresholds added.

**Chosen.** None of these stops anything; together they bound the *time* a runaway goes unnoticed,
which is the multiplier on every daily worst case below. The existing budget's `ACTUAL >= 80%`
alert fires at \$36 against a \$34 baseline — a month-end catch, not a warning: a \$1/day runaway
starting on day 3 trips it around day 17. With D, the same runaway is a notification within the
hour.

## Decision Outcome

**Adopt a layered stop, ordered by how fast it fires. No single layer is sufficient; the layering
is the decision.**

| Layer | Mechanism | Latency | Caps |
|---|---|---|---|
| **L-1** Gate | `requireRegistered` on `POST /api/products/upload-image` | synchronous | who can spend Google money at all |
| **L0** Quota | Vertex AI per-project requests-per-minute override | synchronous | Google spend per *minute* — a burst damper, not a day cap |
| **L1** Throttle | `default_route_settings` on the stage; tighter `route_settings` on the upload route | synchronous | everything behind the gateway |
| **L2** App cap | daily Gemini call counter → 503 | synchronous | Google spend as a **chosen daily number** |
| **D** Detect | Cost Anomaly Detection + CloudWatch alarms + GCP budget alert → SNS | minutes to a day | nothing — it bounds *how long* the numbers above run |
| **L3** Panic | the D alarm → Lambda | minutes | AWS gateway + all downstream (documented, not built) |
| **L4** Backstop | GCP budget → disable billing; AWS Budget Action → stop RDS | hours | Google, hard — last resort |
| **L5** Structural | CloudFront **flat-rate Free plan** + OAC over the image bucket | by construction | **AWS image egress, hard — no overage exists** |

L4 and L5 are the pair that matter most and they are symmetric: **L4 is the hard stop on the Google
card, L5 is the hard stop on the AWS card.** Everything else on this list bounds a bill by choosing
a number; those two bound it by removing the meter. D is what makes the chosen numbers honest.

### Sizing rule — how the caps and the budget are chosen together

Two bounds, both against `budget_limit_usd = 45` with the ~\$34/mo flat baseline inside it:

1. **Detected worst case ≤ budget.** Every cap runs flat out for a **2-day detection window**
   (D fires within the hour; two days is the allowance for a weekend nobody reads email), on top of
   the baseline, and the total stays under \$45. This is the operative bound.
2. **Undetected worst case ≤ 2 × budget.** Every alarm ignored for thirty days must still land
   under \$90 — annoying, not ruinous. This is the bound that stops the caps drifting upward "because
   D will catch it".

A cap that fails bound 2 is too loose whatever D does; a cap that satisfies bound 2 without D is so
tight it fails the team. The second draft of this ADR sized against bound 2 alone and arrived at
2 rps and 30 calls/day — numbers that would have broken the ADR 0003 latency harness (60 calls a
run) and allowed 15 products a day for the whole team.

### Proportionality — what is actually worth building

Ranked by risk removed per hour spent, **against both cards**:

| Layer | Effort | Residual after it | Verdict |
|---|---|---|---|
| **L-1** registered-only upload | **one line** | removes anonymous access to the most expensive path | **Do it first.** Free. |
| **L1** stage throttle @ 5 rps | ~10 lines of HCL, one apply | AWS: \$35,552/mo → **\$17.78/mo** (gateway + logs) | **Do it.** Twenty minutes. |
| **L2** daily counter @ 300/day | few hours + tests | Google: \$9,331/mo → **\$32.40/mo** undetected, **\$2.16** detected | **Do it.** Ranks with L1, not below it. |
| **D** detection | ~1 hour of Terraform + a GCP console step | turns the two rows above into 2-day numbers | **Do it.** It is what makes 5 rps / 300 per day affordable. |
| **L5** CloudFront Free plan over the bucket | ~2 hours (OAC, distribution, `ASSET_BASE_URL`) | AWS: S3 egress **unbounded → \$0, structurally** | **Do it.** \$0/mo, and it is a *cap*, not a discount. |
| **L4** GCP billing detach | ~1 hour | the Google-side hard stop; the belt behind L2's braces | Do it. |
| **L0** Vertex RPM quota | one console setting | per-*minute* only — 5 RPM is still 7,200 calls/day (~\$26–91) | Five-minute extra, not a day cap. |
| **L3** panic Lambda | half a day, destructive, false-positive risk | guards an AWS residual L1 already bounds; its alarm now exists anyway (D) | **Documented, not planned.** Cheaper later than it was. |
| **Phase 2 — CloudFront over the API** | a day: second Free plan, `us-east-1` cert, `disable_execute_api_endpoint`, DNS change | per-IP rate limiting and geo at the edge for \$0; blocked traffic never becomes an API Gateway call | **Decided, sequenced after Phase 1.** Unblocked — see the quota facts above. |

**Scope — Phase 1: L-1, L1, L2, D, L5, L4 — about a day and a half.** After it the
sustained-attack worst case is **\$37.34/mo detected, \$84.18/mo undetected**, both including the
\$34 baseline and both inside the sizing rule. **Phase 2: the API distribution**, once Phase 1 has
landed and the first Free plan has been exercised. L3 stays documented and unbuilt.

The threat model still argues for restraint: this is a hobby project's dev subdomain with no
traffic and no payoff for an attacker. The likeliest source of a surprise bill is **our own code** —
a retry loop in the rating outbox, a CI flow that grows into Add Product, an agent-team run in a
loop, a latency harness run twice. L1, L2 and D all catch that case, and it is the case that will
actually happen.

### Consequence budget — what each layer buys, and what the bill becomes

Effort rankings say what to build first. They do not say where the bill lands, which is the only
question the credit card cares about. This is that table.

Baseline for all of it: the stack's **flat** cost is ~\$34/mo (`variables.tf` § `budget_limit_usd` —
Fargate ~\$9, RDS + storage ~\$15, one public IPv4 \$3.65, hosted zones ~\$1, SSM ~\$0.40). Everything
below is *attack-driven spend on top of that*. Gemini figures assume thinking disabled
(\$0.0036/call) — see point 4 below for what happens if it is not.

**Per option — what each layer limits, on its own:**

| Layer | Limits | Worst case → | Leaves unbounded |
|---|---|---|---|
| **L-1** registered-only upload | *who* can spend | no change to the ceiling; raises cost of entry to a confirmed email | everything (it is friction, not a bound) |
| **L1** stage throttle @ 5 rps | API Gateway + CloudWatch + all downstream *volume* | **\$35,552/mo → \$17.78/mo** (\$0.59/day) | Gemini (the upload route's own 1 rps is still 86,400 calls/day), S3 egress |
| **L2** daily Gemini counter @ 300/day | Gemini calls per day | **\$9,331/mo → \$32.40/mo** (\$1.08/day) | AWS request volume, S3 egress |
| **D** detection | the number of days any of the above runs | 30 days → **~2 days** | nothing by itself |
| **L5** CloudFront Free plan + OAC | S3/image egress, **structurally** | **\$2,816/mo → \$0**, no overage exists | API Gateway, Gemini |
| **L4** GCP billing detach | Gemini, per *month*, as a hard stop | Google bill → \$0 once tripped (hours of latency) | AWS entirely |
| **L0** Vertex RPM quota | Gemini per *minute* | 5 RPM = 7,200 calls/day = **\$777–2,745/mo** — not a useful ceiling on its own | a day's worth of spend |
| L3 panic Lambda | AWS, reactively | an AWS residual L1 already bounds | — |
| Phase 2 API distribution (flat-rate) | reachability **and** cost | WAF-blocked traffic: **\$0**, and never becomes an API Gateway call | what passes the filter (bounded by L1) |

**Combined — cumulative, in-scope layers only. Two right-hand columns, because the detection window
is the variable that matters:**

| Applied | \$/day | **30 days undetected (+\$34)** | **2 days detected (+\$34)** |
|---|---:|---:|---:|
| Nothing (today) | ≥\$1,590 | ≥\$47,733 | ≥\$3,214 |
| + L-1 registered-only | ≥\$1,590 | ≥\$47,733 | ≥\$3,214 |
| + L1 @ 5 rps | \$405 | \$12,199 | \$845 |
| + L2 @ 300/day | \$95.55 | \$2,900 | \$225 |
| + L5 CloudFront Free plan | **\$1.67** | **\$84.18** ✅ ≤ \$90 | **\$37.34** ✅ ≤ \$45 |
| *interim: L2 @ 100/day, thinking unmeasured (\$0.0126/call)* | \$1.85 | \$89.58 ✅ (at the ceiling) | \$37.70 ✅ |
| *second draft: L1 @ 2 rps, L2 @ 30/day* | \$0.35 | \$44.35 | \$34.69 |

Four things this table says that the prose did not.

**1. The second-draft caps were sized for the wrong column.** 2 rps / 30 per day holds the
*undetected* month under budget — and is unusable: one latency-harness run is two days of quota, a
product is two calls, and 2 rps with a burst of 10 is marginal for an emulator launching the Home
tab while a developer pulls to refresh. **5 rps / 300 per day** fits both bounds of the sizing rule
once D exists, and D costs an hour.

**2. L1 alone leaves 99.8% of the exposure standing.** Row 3 is the argument for L2 in one line:
after the throttle, the bill is still \$405/day, essentially all of it Gemini. This is what the first
draft's effort ranking hid by measuring only the AWS column.

**3. L5 is the only row that reaches zero.** Every other layer converts an unbounded number into a
smaller number that someone chose and that drifts as prices change. L5 removes the meter: there is no
overage charge to incur. That is a different *kind* of guarantee, and it is worth more than its
position in the effort ranking suggests.

**4. `thinkingConfig` moves the affordable cap by 3.5×.** At the default (\$0.0126/call), 300/day is
\$3.78/day and the undetected month is \$147 — bound 2 fails. **So L2 ships at 100/day until thinking
is measured and set** (the interim row: \$89.58 undetected, exactly at the ceiling, acceptable only
because it is interim and because the measurement is step 2 of the implementation), and moves to
300/day once a call is confirmed at ~\$0.0036. The cap is an environment variable so this is a
config change, not a release.

### L-1 — make the upload endpoint registered-only

`POST /api/products/upload-image` is the only Gemini path still open to anonymous sessions
(`extract-label` is already `requireRegistered`). It is pure exposure: `add-product.tsx:154` turns
guests away client-side, and `POST /api/products` is `requireRegistered`, **so an anonymous upload
can never become a product.** Adding the guard costs one line, breaks nothing, and deletes
"anonymous accounts are free to mint" from the most expensive endpoint in the system. Registration
requires a confirmed email, which is real friction.

It is friction, not a bound — one registered attacker at 1 rps still spends \$311/day — which is why
it does not replace L2.

### L1 — stage and per-route throttling

Add to `aws_apigatewayv2_stage.default`:

```hcl
default_route_settings {
  throttling_rate_limit  = 5
  throttling_burst_limit = 25
}
```

Five requests per second is **432,000 requests a day** — no constraint on one dev team — and it
bounds the *unstoppable* gateway charge at ~\$12.96/mo rather than ~\$25,920. **The burst is 25, not
10, for CI:** the Maestro emulator and a developer's phone can both open the Home tab in the same
second, and each launch is several parallel requests. A 429 on a CI flow is a red PR that has nothing
to do with the PR.

**The residual is not only the gateway line.** Both log groups (API Gateway access-log JSON plus the
server's `request:finish` line, ~700 B/request together) ingest at ~\$0.57/GB — at 10 rps another
~\$9.6k/mo of the worst case, at 5 rps ~\$4.82/mo. Logs are roughly 27% of L1's residual and were
missing from this ADR's first draft.

The rate is 5 and not the 10 originally proposed because 10 rps fails bound 2 on its own
(\$35.55/mo of gateway + logs, before Gemini); it is 5 and not the 2 of the second draft because 2
was sized for the undetected month and D makes that the wrong column.

The Gemini path deserves a tighter number, but `route_settings` can only key a route that exists
and we run a single `$default` catch-all. **Add an explicit `POST /api/products/upload-image` route
pointing at the same integration, purely so it can carry its own throttle** (`rate 1, burst 5`).
That is the whole trick — the route exists to be throttled, not to route.

**But note what it does not buy.** Even at 1 rps that route permits 86,400 plausibility calls a day
(\$311/day, \$9,331/mo). A rate throttle cannot express "per day", which is the shape the Gemini
bill actually has. The per-route throttle is worth adding as a burst damper; **L2 is what bounds the
spend.**

### L2 — daily Gemini cap (co-equal with L1, not a follow-up)

**Cap: `GEMINI_DAILY_CALL_CAP`, an environment variable per stage with no default** (the
fail-fast convention in `CLAUDE.md`): **100 on `dev` at launch, 300 once `thinkingConfig` is set and
the per-call cost is confirmed**; `mock` modes never consult it. Sized against the consumers above:
300 is 150 products, or five latency-harness runs, a day.

**Persistence: a Postgres row, decided.** The second draft left this open on the grounds that a
database-backed counter couples a cost guardrail to database availability. That coupling is moot —
the API does not serve without Postgres — and the alternative, an in-memory counter, resets on every
deploy, which is exactly when a retry-loop bug is most likely to have just shipped. One table,
`GeminiDailyUsage(day DATE PRIMARY KEY, calls INT)`, and one statement:

```sql
INSERT INTO "GeminiDailyUsage" (day, calls) VALUES (CURRENT_DATE, 1)
ON CONFLICT (day) DO UPDATE SET calls = "GeminiDailyUsage".calls + 1
  WHERE "GeminiDailyUsage".calls < $cap
RETURNING calls;
```

No row returned means the cap is reached. Three rules matter more than the storage choice:

1. **Reserve before calling, never count after.** The increment happens before the model call, so
   concurrent requests cannot overshoot the cap by the width of the in-flight window.
2. **Timeouts and failures count.** Google bills input tokens it has processed; an aborted call is
   not a free call. The reservation is never rolled back.
3. **Fail closed.** If the counter cannot be read or written, the answer is `503`, not a model call.

Over the cap → `503 { code: 'daily_quota_exhausted' }`, no upstream call. Chosen deliberately over a
per-user limit: anonymous accounts are free to mint, so per-user caps bound nothing in aggregate.
Both Gemini call sites (`imagePlausibilityService.ts`, `labelExtractionService.ts`) reserve through
the same function, next to `services/geminiDeadline.ts`.

**Implemented (2026-09-09) as `services/geminiQuota.ts` (`reserveGeminiCall`, `GeminiDailyQuotaExhaustedError`).**
The call site is `labelExtractionLlmService.ts` specifically (the Gemini path of label extraction;
the text and OCR paths never call Gemini and never reserve). `dev` shipped with the interim
`GEMINI_DAILY_CALL_CAP=100`, then step 8 (2026-09-09, same day) raised it to **300** once step 2's
measurement confirmed the thinking-disabled cost — 300 × \$0.003568 × 30 ≈ \$32.11/mo, matching the
sizing rule's \$32.40/mo target. Verified directly against the local Postgres: two reservations at
`cap=2` return `calls` 1 and 2, a third returns zero rows and inserts nothing extra — the
`WHERE calls < cap` guard on the `ON CONFLICT DO UPDATE` branch is one atomic statement, not a
read-then-write, so the race the sizing rule worries about doesn't exist at the SQL level.

### D — detection

* **`aws_ce_anomaly_monitor` (account-level, `AWS_SERVICES`) + `aws_ce_anomaly_subscription`**
  publishing to `aws_sns_topic.billing_alerts` with a low absolute threshold (\$5). Free.
* **`aws_cloudwatch_metric_alarm` on `AWS/ApiGateway` `Count`**, dimension `ApiId`, `> 1,000` in
  5 minutes (~3.3 rps sustained — an order of magnitude above real traffic including a CI run, far
  below anything that costs money). Note `Count` includes requests the stage throttled, which is the
  point: the alarm sees the flood, not just what got through.
* **`aws_cloudwatch_log_metric_filter` on `/ecs/breadsheet-dev-server`** matching `request:finish`
  lines whose `path` is a Gemini endpoint, feeding a `GeminiCalls` metric; alarm at `> 50` in one
  hour. No application change: the structured log line already exists.
* **GCP budget** on `breadsheet-496522` with email thresholds at \$2 / \$5 / \$10 actual — the same
  budget resource L4's Pub/Sub trigger hangs off.

**Precondition, step 0 of the implementation:** every one of these is silent unless
`aws_sns_topic.billing_alerts` has a *confirmed* subscriber. `budget.tf` deliberately leaves the
email subscription out of Terraform (it needs a confirmation click). Verify with
`aws sns list-subscriptions-by-topic` before trusting anything in this section; an unsubscribed
topic is a detection layer that detects nothing.

**As implemented (2026-09-09), three corrections the plan above didn't anticipate:**

* **The AWS account already had a `DIMENSIONAL`/`SERVICE` monitor** — `Default-Services-Monitor`,
  auto-created the first time Cost Anomaly Detection was opened in the console, years before this
  stack existed. AWS allows exactly one such monitor per account, so `aws_ce_anomaly_monitor` is
  imported rather than created (`terraform.tf` § detection.tf carries the exact command). It already
  had its own `Default-Services-Subscription` — a personal \$100-absolute-**and**-40%-relative email
  alert — left untouched; the ADR's \$5 SNS subscription is a second, additional subscription on the
  same monitor.
* **`aws_ce_anomaly_subscription` cannot use `DAILY`/`WEEKLY` frequency with an SNS subscriber** — AWS
  rejects that combination outright (`ValidationException`); only `EMAIL` subscribers support those
  frequencies. The SNS subscription is `IMMEDIATE`, which is a better fit for this layer's "minutes"
  latency budget anyway.
* **The GCP billing account bills in EUR, not USD** — `gcloud billing accounts describe` shows
  `currencyCode: EUR`. A `specified_amount` with `currency_code = "USD"` is rejected by the Budgets
  API as a bare `400 invalid argument` with no field-level detail (confirmed by reproducing the same
  call directly with `gcloud billing budgets create`). The budget is €40 with thresholds at €2/€5/€10,
  standing in for the ADR's \$40/\$2/\$5/\$10 figures rather than a currency-converted equivalent.

### L3 — the panic Lambda (documented, not built)

Would attach to the D alarm on `AWS/ApiGateway` `Count`, and be invocable by hand:

```sh
aws lambda invoke --function-name breadsheet-dev-panic-stop /dev/stdout
```

It would perform, in order:

1. `ecs update-service --desired-count 0` — stops Gemini calls, RDS load and task egress. The
   biggest lever, and the fastest.
2. `apigatewayv2 delete-api-mapping` **and** `update-api --disable-execute-api-endpoint` — the
   mapping alone is not enough. The `*.execute-api` URL stays public (it is exported as the
   `api_endpoint` output), so detaching the custom domain leaves the API fully reachable. There is
   no cheaper sink than removing both: HTTP APIs have no Mock integration, and throttled 429s are
   billed.

   > **Unverified:** whether a request to a custom domain with no mapping is itself billed as an API
   > call is not documented either way. Until someone checks, do not claim this step stops the meter
   > — treat step 1 (`desired_count 0`) as the load-bearing one.
3. Removes the `PublicReadAllowProcessed` statement from the bucket policy — moot once L5 has
   removed that statement permanently.
4. Publishes to `aws_sns_topic.billing_alerts` so the stop is not silent.

**Resume would be `terraform apply`.** `aws_ecs_service.server` ignores `task_definition` but *not*
`desired_count`, and the api mapping is Terraform-managed, so a plain apply restores both. This is
why the Lambda would mutate live state rather than write anything durable.

Not built because a false positive takes `dev` down until someone runs `terraform apply`, and the
residual it guards is one L1 already bounds at \$0.59/day. With D in place the manual equivalent —
read the alert, run `aws ecs update-service --desired-count 0` from a phone — is the "I am on
holiday" button, at zero false-positive risk.

### L4 — backstops

GCP budget → Pub/Sub → billing-detach function on project `breadsheet-496522`, tripping at **\$40
actual for the month** — deliberately *above* L2's \$32.40 undetected ceiling, because this tier is
for "L2 has been bypassed or misconfigured", not for normal L2 operation. On the AWS side, one
`aws_budgets_budget_action` stopping the RDS instance at 150% of `budget_limit_usd`. Both are the
"everything else failed and nobody was looking" tier.

**Implemented (2026-09-09) as `../../terraform/backstops-budget.tf` (+ the Cloud Function source at
`terraform/functions/billing-killswitch/`).**

*AWS side.* `aws_budgets_budget_action.stop_rds` — `RUN_SSM_DOCUMENTS` / `STOP_RDS_INSTANCES` against
`aws_db_instance.main`, `AUTOMATIC` approval, threshold 150% of `budget_limit_usd`. The execution
role attaches AWS's own managed policy for exactly this
(`AWSBudgetsActions_RolePolicyForResourceAdministrationWithSSM` — EC2/RDS start-stop conditioned on
`aws:CalledVia = ssm.amazonaws.com`, plus `ssm:StartAutomationExecution` scoped to the four AWS-owned
`AWS-{Start,Stop}{EC2,Rds}Instance` documents) rather than a hand-written policy — AWS documents the
exact JSON at `docs.aws.amazon.com/cost-management/.../billing-permissions-ref.html#budget-managedIAM-SSM`,
which is worth trusting over a guess here.

*GCP side.* `google_billing_budget.dev` (detection.tf) gained a fourth `threshold_rules` block at
`threshold_percent = 1.0` and an `all_updates_rule { pubsub_topic = ... }` — the same budget resource
D already uses, extended rather than duplicated, so there is exactly one €40 number to reason about.
Every notification (D's fractional thresholds too, several times a day per Google's own docs) lands
on the same Pub/Sub topic; `index.js` is what turns that stream into a single one-shot action — it
no-ops unless `costAmount > budgetAmount`, then calls `cloudbilling.projects.updateBillingInfo` with
an empty `billingAccountName`.

Three corrections the plan above didn't anticipate, all found by actually applying this rather than
just writing it:

* **Terraform has no `google_pricingplanmanager`-style gap here, but the deploy region does bite.**
  `var.gcp_location` is `"global"` in `dev.tfvars` — correct for Vertex AI model routing (see the
  `GOOGLE_CLOUD_LOCATION` fix in `infrastructure.md`), but not a real region for GCS, Cloud Functions,
  or Eventarc, all of which rejected it outright (`may not create storageClass STANDARD buckets with
  locationConstraint GLOBAL`). The function's resources use their own region (`europe-west1`),
  independent of Vertex's location choice — the two are unrelated despite sharing a variable name in
  spirit.
* **A recently-changed GCP org policy no longer auto-grants the default Compute Engine SA the role
  Cloud Build needs for gen2 function builds.** The first deploy attempt failed with "missing
  permission on the build service account." Rather than widening the shared default compute SA (used
  project-wide for unrelated things), `build_config.service_account` points at the killswitch SA
  itself, granted `roles/cloudbuild.builds.builder` — one purpose-built identity for build, trigger,
  and (once billing.admin is exercised for real) the detach call.
* **A gen2 Pub/Sub trigger on a non-default service account needs three IAM grants, not one**, or it
  deploys cleanly and silently never delivers: `roles/eventarc.eventReceiver` (project) so the trigger
  identity can receive events, `roles/run.invoker` on the function's own underlying Cloud Run service
  (not project-wide) so the Pub/Sub push subscription can actually invoke it, and
  `roles/iam.serviceAccountTokenCreator` granted **to the killswitch SA, held by the Pub/Sub service
  agent** (`service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com`) so Pub/Sub can mint the
  identity tokens push delivery needs. Missing any one of these produces `run.routes.invoke` 401s that
  never surface as a Terraform error — the resources all apply cleanly regardless.

**Verified without ever exercising the real detach path.** Two synthetic Pub/Sub messages
(`costAmount` 1.23 and 2.5 against `budgetAmount` 40) were published directly to the topic after
apply; function logs show both received, parsed, and correctly resolved to "under budget, no action"
— confirming the whole chain (Pub/Sub → Eventarc → Cloud Run → function logic) end-to-end without
ever calling `updateBillingInfo`. The one grant this whole layer turns on —
`google_billing_account_iam_member.killswitch_admin`, `roles/billing.admin` for the killswitch SA on
the real billing account — was never invoked in anger, deliberately: there is no safe way to test the
actual detach without detaching real billing.

**What this does *not* do: reverse itself.** A real trip leaves the project with no billing account
attached — every Google service stops, including Vertex/Gemini — until someone manually re-attaches
one (`gcloud billing projects link <project> --billing-account=<id>`, or the console). `terraform
apply` does not undo this: `google_project_service` resources for a de-billed project would fail to
reconcile, and nothing in this stack automates re-attachment. That is intentional — the entire point
of L4 is to be a hard stop a human has to consciously reverse, not a soft one Terraform quietly
smooths over.

---

### L5 — CloudFront flat-rate Free plan over the image bucket

`s3.tf:29` grants `Principal: "*"` on `processed/*`, so image egress bypasses the gateway, the task
and every limiter above at \$0.09/GB — ~\$92 per TB pulled, no ceiling. An earlier draft of this ADR
accepted that as an unsolvable residual and floated plain CloudFront as a "cheap mitigation". Both
were wrong.

**Plain CloudFront is not a mitigation.** Edge egress is 5.5% cheaper per GB, but CloudFront requests
cost 3× an S3 GET (\$1.20/M vs \$0.40/M), and it nets out at our object sizes (1200 px q85 JPEG,
~250 KB — `imageResizer/src/index.ts:9`):

| avg object | requests/GB | S3 \$/GB | CloudFront \$/GB | CF vs S3 |
|---:|---:|---:|---:|---:|
| 50 KB | 20,972 | 0.0984 | 0.1102 | **+12.0%** |
| 150 KB | 6,991 | 0.0928 | 0.0934 | +0.6% |
| 250 KB | 4,194 | 0.0917 | 0.0900 | −1.8% |
| 500 KB | 2,097 | 0.0908 | 0.0875 | −3.7% |

A sustained 1 TB/day pull costs **\$93.88/day direct from S3 and \$92.19/day through CloudFront**. A
1.8% saving is not a control. Caching does not rescue it: caching collapses *origin* fetches,
origin-to-CloudFront transfer is already free, so edge egress is the whole bill at any hit ratio.

**The flat-rate plan is the control.** The same distribution, subscribed to the **Free** tier:

| | Free plan |
|---|---|
| Price | **\$0/mo** |
| Allowance | 1M requests, 100 GB/month |
| Over the allowance | **no overage charges, ever** — AWS adjusts delivery (fewer/more distant edges, proportional to the excess), first spike to 3× accommodated |
| Included | CDN + caching, **WAF (5 rules) + always-on DDoS + IP-based rate limiting + header insertion**, TLS certificate, the distribution's CloudWatch Logs ingestion, 5 GB of S3 storage credit |
| Not counted against the allowance | **WAF-blocked and DDoS-blocked requests** |
| Quota | 3 Free plans per account; this uses the first |

Two pieces, both required:

1. **Origin Access Control, and drop the public bucket policy.** Without it the S3 URL stays directly
   reachable and the distribution is decorative — the same lesson as `disable_execute_api_endpoint`
   on the API side. `ASSET_BASE_URL` moves to the distribution's default `*.cloudfront.net` domain
   (no custom domain, so no certificate at all); `resolveImageUrl()` (`imageService.ts:32`) is the
   single chokepoint every serializer already goes through, so this is a config change rather than
   a code change. **It is, however, a task environment variable**, which ADR 0003 recorded as
   invisible to both Terraform and the CD pipeline — see `infrastructure.md` § Changing a task
   environment variable for the forced-replacement dance.
2. **Subscribe the distribution to the Free plan with a WAF web ACL attached.** The ACL is a
   condition of the plan and cannot be detached without reverting to pay-as-you-go. It may carry an
   empty rule set; it must exist.

Result: **image egress becomes structurally \$0.** Not alarmed, not throttled — there is no meter to
run. The only residual is S3 GETs on cache misses, and because `processed/{uuid}.jpg` is
content-addressed and never mutated, a long TTL collapses those to roughly one per object per edge.

**Implemented (2026-09-09) as `terraform/cloudfront.tf`.** OAC + a rewritten `s3.tf` bucket policy
(scoped to the distribution's `AWS:SourceArn`, no `Principal: "*"` statement left at all) + an empty
`aws_wafv2_web_acl` (scope `CLOUDFRONT`, so it has to be created via the `aws.use1` alias — the same
us-east-1-only constraint D's Cost Anomaly monitor hits) + `ASSET_BASE_URL` repointed at the
distribution's `*.cloudfront.net` domain. **One correction the plan above didn't anticipate: the Free
plan subscription itself is not Terraform-expressible.** Checked against both the installed `aws`
provider's schema (no `pricing_plan` argument on `aws_cloudfront_distribution`, no
`aws_pricingplanmanager_*` resource in `~> 6.39`) and AWS's own docs, which say plan management is
console / AWS CLI / **PricingPlanManager API** only — a surface this provider version doesn't wrap.
Terraform builds and wires everything the plan *requires* (OAC, the mandatory attached WAF ACL); the
subscription itself is a one-time manual console step (`infrastructure.md` § CloudFront images
distribution has the exact path).

**Applied (2026-09-09), two corrections the plan above didn't anticipate:**

* **`aws_wafv2_web_acl.description` rejects em dashes and parentheses.** AWS's validation regex for
  the field is `^[\w+=:#@/\-,\.][\w+=:#@/\-,\.\s]+[\w+=:#@/\-,\.]$` — word characters, `+=:#@/,.-` and
  whitespace only. The first two apply attempts failed with a `ValidationException` from plain prose
  in the description; fixed by writing it in that character set.
* **`-replace`ing the task definition silently reverts the container image to the stale pin in
  `ecs.tf`.** The comment already on that line warned about exactly this ("this pin drifts behind the
  live service") and it was missed anyway: the first `-replace` + force-new-deployment rolled the live
  image from CI's latest (`04c6a55d…`, the one actually running) back to the hardcoded `25f6411c…`
  pin — an older commit predating some part of the current DB connection path. Every task launched
  from it crashed inside `scripts/start.sh`'s `prisma migrate deploy` with `P1013: invalid port number
  in database URL` (the RDS IAM token, malformed) and ECS's deployment circuit breaker correctly
  auto-rolled back to the previous revision each time — the service never went down, but the new
  `ASSET_BASE_URL` never landed either, so images stayed 403'd (the bucket policy had already
  switched to OAC-only) until the pin was corrected to the live image tag and `-replace` re-run.
  **Takeaway: update the image pin to the currently-running tag before any `-replace` of this
  resource**, not just when resuming from a Tier-3 pause as the existing comment says.

Both are now live: distribution `E2Z86B0PMDNJX7` at `d2gnt4hslkw044.cloudfront.net`, verified
end-to-end (a real `processed/*.jpg` key returns `200 image/jpeg` through CloudFront, the old direct
S3 URL returns `403`). **The Free plan subscription itself is also done** (manual console step,
2026-09-09) — `dev`'s image egress is now the structural \$0 this layer is for, not just
pay-as-you-go-but-cheap.

**Caveats, honestly.** The Free plan's 100 GB / 1M requests is far smaller than the pay-as-you-go
always-free tier (1 TB / 10M): normal `dev` traffic sits well inside it, but an attack exhausts it in
minutes and the consequence is *degraded delivery, not a bill*. For a dev stage that is the right
trade — for `prod` (ADR 0003 step 7) it needs re-deciding, since degraded delivery is a real user
harm. Plan eligibility depends on historical CloudFront usage; this account has none, so a fresh
distribution qualifies.

**Step for the `prod` cutover (ADR 0003 step 7, not yet reached — no `environments/prod.tfvars`
exists).** `cloudfront.tf`'s resources are environment-agnostic (`local.name_prefix`-keyed, no
hardcoded `dev`), so `prod` gets its own OAC + distribution + WAF ACL for free the moment `prod` is
stamped from this same Terraform root. Two things do **not** carry over automatically and need doing
again by hand, once, for `prod` specifically:

1. **The Free plan subscription is per-distribution, not account-wide.** `prod`'s distribution needs
   its own console visit (`AWS Console → CloudFront → Distributions → <prod distribution> → Manage
   Plan → Free`) — this spends the account's **second** Free plan (of 3; `dev` used the first).
2. **Re-decide the degraded-delivery trade before subscribing `prod`.** The caveat above is not
   theoretical for `prod`: an exhausted 100 GB/1M-request allowance degrades delivery rather than
   billing, which is fine for a hobby dev stage and a real user-facing harm for `prod`. Either accept
   that trade explicitly for `prod` too, or subscribe `prod`'s distribution to a paid tier (Pro/Business,
   larger allowance, still flat-rate/no-overage) instead of Free — decide this as part of ADR 0003
   step 7, not by silently reusing the `dev` choice.

## Phase 2 — CloudFront over the API: geo-restriction and per-client rate limiting

The `dev` stage serves one development team in Baden-Württemberg plus CI. Fronting the API with a
second Free-plan distribution buys two things Fact 1 says the HTTP API cannot provide:

* **Per-IP rate limiting**, at the edge, for \$0. The Free plan's WAF includes *"automatically block
  IP addresses that exceed a configurable number of requests over a 5-minute period"*. That is the
  per-client control the HTTP API lost, restored in front of it — and blocked requests are exempt
  from the allowance and never become an API Gateway call. This, not geo, is the stronger reason to
  take Phase 2.
* **Geo-restriction**, which shrinks the reachable surface by orders of magnitude and — on a
  flat-rate plan — stops traffic *before* it becomes a billable API Gateway call.

**Neither is a cost cap on its own** — a botnet with German exit nodes defeats geo, and a
distributed flood defeats per-IP — so they belong alongside L1/L2/L5, never instead of them.

### Why this needs CloudFront

Fact 1 above forecloses the obvious routes. Our HTTP API supports **neither WAF** (where geo-match
and rate rules live) **nor resource policies** (where an `aws:SourceIp` allowlist would live). The
filter has to sit in front of it, and CloudFront is the only in-front option that does not
reintroduce a load balancer.

**Which pricing model the distribution is on decides whether this helps or hurts.**

*Pay-as-you-go* — the version this ADR first costed, and rejected. CloudFront charges \$0.0120 per
10,000 HTTPS requests in Europe (\$1.20/M) against API Gateway's \$1.00/M, and a request rejected at
the edge by a geo rule is billed exactly like one that passes. Beyond the 10M/month allowance
(3.86 rps sustained), geo-blocking costs 20% *more* per request than letting the request through,
and anything that passes pays both meters:

| Monthly requests | API Gateway alone | + pay-as-you-go CloudFront geo-block |
|---|---:|---:|
| 1M (real `dev` traffic) | \$1.00 | **\$0** (free tier) |
| 100M | \$100 | \$208 |
| 3,000M (100M/day flood) | \$3,000 | \$6,588 |

*Flat-rate Free plan* — the version that works. There is no per-request charge to pay and no overage
to incur, and **WAF-blocked requests never reach the origin and never count against the allowance**.
A foreign flood is therefore stopped at the edge for **\$0**, and never becomes an API Gateway call
either. The same table collapses to a single row: blocked traffic is free at every volume, and what
passes the filter hits API Gateway bounded by L1.

### Three ways to draw the boundary

| Option | Granularity | Cost | Notes |
|---|---|---|---|
| **G-A** CloudFront built-in `geo_restriction` | Country (`DE`) only | \$0 | Four lines of Terraform. No functions, no WAF. |
| **G-B** CloudFront Function on viewer-request | Country **+ region** (`DE` + `BW`) | \$0 within free tier | Reads `CloudFront-Viewer-Country` / `CloudFront-Viewer-Country-Region`. Both must be added via a **cache policy** to be visible at the viewer-request stage — an origin request policy is applied too late. Use a custom policy with TTL 0. |
| **G-C** AWS WAF on the distribution | Country **+ region**, plus IP sets and rate rules | **\$0 on a flat-rate plan** (pay-as-you-go: ~\$7/mo) | Geo-match emits the label `awswaf:clientip:geo:region:DE-BW`; a label-match rule blocks everything else. Most capable — and on a flat-rate plan the web ACL is both included and *mandatory*. |

### The accuracy problem, which decides the granularity

ISO 3166-2 subdivision geolocation is materially less reliable than country geolocation, and German
mobile networks are close to a worst case: Telekom, Vodafone and O2 route subscriber traffic through
a small number of central egress points, so a phone physically in Stuttgart routinely geolocates to
Hesse or Bavaria. Both AWS geo databases return `XX` when a lookup fails, and `DE-XX` fails a
`DE-BW` match.

A `BW`-only rule would therefore lock the dev team out of the dev stage intermittently, from real
devices, with a 403 that looks nothing like a bug in the app. That is exactly the "false positive
must not be expensive" driver.

**Decision: G-C, at country granularity (`DE`), plus a rate-based rule.** On a flat-rate plan the
web ACL is included and mandatory, so a rule in it costs nothing; G-B's CloudFront Function then
earns nothing. The plan exempts **WAF-blocked** requests from the usage allowance; a 403 from
CloudFront's own `geo_restriction` (G-A) is not obviously in that set — *inference, not established
fact* — which is a second reason to put the rule in WAF.

**CI is a consumer.** GitHub-hosted runners are not in Germany. Either the geo rule carries an
allow for the runner's egress (fragile — the ranges rotate) or, simpler, the Maestro job sends a
shared-secret header that a higher-priority WAF allow rule matches before the geo rule runs. Decide
at implementation; the ADR's requirement is only that Phase 2 must not turn every PR red.

**Granularity stays country-level.** Keep the region label documented as an opt-in tightening, gated
on a break-glass path (a Route 53 weighted record, or the same header the CI job sends).

### What CloudFront in front actually requires

Putting a distribution in front does nothing for cost unless API Gateway becomes unreachable
directly. Three things, all mandatory together:

1. **`disable_execute_api_endpoint = true`** on `aws_apigatewayv2_api.main` — kills the
   `*.execute-api.eu-west-1.amazonaws.com` URL, which is currently public and published as the
   `api_endpoint` output.
2. **A secret origin header.** The API Gateway *custom domain* stays publicly resolvable and answers
   to anyone sending the right `Host`. The **distribution** adds the shared secret as an origin
   `custom_header` on every request it forwards; Express (`requireOriginSecret`) rejects requests
   without it. Without this the filter is decorative. (First built on the WAF's **header insertion**
   feature instead, which does not work for this — WAF renames what it inserts. See the third
   correction below.)
3. **A certificate in `us-east-1`.** CloudFront will not use the regional `eu-west-1` certificate
   in `dns.tf`. The plan includes a TLS certificate; if it does not cover a custom domain on the
   distribution, a second public ACM certificate is \$0 anyway. `aws_route53_record.server` then
   aliases the distribution (an **ALIAS** record, and the zone stays *unattached* from the plan — see
   E-D), and the API Gateway custom domain moves to an internal name.

**Plan budget:** L5 uses Free plan 1 of 3, this uses 2 of 3. Each covers one distribution with one
apex domain; both sit under `bread-sheet.com`, one apex per plan, which the quota permits.

**Implemented (2026-09-09) as `../../terraform/dev-geo-restriction.tf` (+ `dns.tf`, `api-gateway.tf`, `keepalive.tf`
edits; `server/src/middlewares/requireOriginSecret.ts`; `bread-sheet-app/lib/api.ts`;
`.github/workflows/test-native-e2e.yml`).**

`server.dev.bread-sheet.com` now aliases the new CloudFront distribution; API Gateway's custom
domain moved to `origin.dev.bread-sheet.com` (own regional cert) and `disable_execute_api_endpoint`
kills the raw execute-api URL — confirmed live, it now returns API Gateway's own
`{"message":"Not Found"}` 404 regardless of path. The WAF (`edge-bypass` → `geo-de-only` →
`rate-limit`, then default-allow) deploys and evaluates correctly — verified end to
end: the site works over the new domain, the edge-bypass header matches its rule, and
`disable_execute_api_endpoint` is confirmed by direct request.

**Two corrections found by applying it:**

* **AWS's ACM tag-value regex doesn't allow parentheses or commas** — the same character-set lesson
  as the WAF ACL description in `backstops-budget.tf`'s "Applied" note, different resource, different regex
  (`([\p{L}\p{Z}\p{N}_.:/=+\-@]*)`). A descriptive `Name` tag with `(CloudFront, us-east-1)` in it
  failed `RequestCertificate` outright.
* **That failure landed mid-cutover and broke the live DNS record.** The apply had already destroyed
  the old `aws_apigatewayv2_domain_name.server` (renamed to `.origin`) before the tag error stopped
  it — `aws_route53_record.server` never got to its own update (it depends on the CloudFront
  distribution, which never got created), so the live alias kept pointing at a custom-domain mapping
  that had just been deleted. `server.dev.bread-sheet.com` was genuinely down for the several minutes
  between that first failed apply and the fixed one. **Takeaway for any future rename that spans a
  `moved` block and a resource the public DNS record depends on: the window between "old resource
  destroyed" and "new resource created and DNS repointed" is a real outage window if anything in
  between fails, not just a Terraform bookkeeping detail.**

**Two more found by *deploying* it (2026-09-12).** The apply-time verification above could not catch
these: the gate only starts enforcing once a container image containing it reaches `dev`, and when it
did, it rejected everything.

* **AWS WAF prefixes every header it inserts with `x-amzn-waf-`, so the origin-secret gate rejected
  100% of API traffic** once the enforcing image reached `dev`. The WAF was configured with
  `insert_header { name = "x-origin-verify" }`; Express received `x-amzn-waf-x-origin-verify` and
  `requireOriginSecret` — checking `x-origin-verify` — 403'd every `/api/*` request from every
  platform. This is documented behaviour ("to avoid confusion with the headers that are already in the
  request") and is not suppressible, so the fix moves the insertion to the distribution's origin
  `custom_header`, which sends the name verbatim, covers every forwarded request regardless of which
  WAF rule allowed it, and is what AWS documents for origin verification. Discovered 2026-09-12, three
  days after the apply, by a user reporting the app as broken — **not** by the test suite, and that is
  the more useful half of this finding: the gate's unit test sets the header itself, so it asserted the
  same wrong name on both sides of a cross-system contract and passed. *A test that stubs the producer
  of a contract cannot validate the contract.* The only thing that could have caught this is an
  assertion against the real edge, or against the Terraform literal.
* **The failure was disguised as an offline app, which cost most of the diagnosis time.**
  `requireOriginSecret` was mounted *above* `cors`, so its 403 carried no `Access-Control-Allow-Origin`
  and the browser could not see the status at all: `fetch` rejected with a bare `TypeError`,
  `lib/api.ts` mapped it to `NetworkError`, and the app rendered "you appear to be offline" on every
  screen — while native, with no CORS to satisfy, showed the real 403. The `OPTIONS` preflight was
  403'd too, since browsers never send `X-Origin-Verify` on one. `cors` now sits ahead of every gate
  (it only adds response headers, so it grants nothing on its own) and `src/app.test.ts` pins the
  order. **Generalised:** a rejection emitted before CORS headers is, to a browser, indistinguishable
  from an unreachable server — put every middleware that can reject *below* `cors`, or accept that its
  rejections will be reported to users as connectivity failures.

**State after the fix — applied and verified 2026-09-12.** The CloudFront/WAF layer (geo, rate limit,
`disable_execute_api_endpoint`) had been live and bounding cost since 2026-09-09 and was never affected
by either bug: only the origin-secret defence-in-depth check was broken, and it was broken *closed*, so
the residual it covers ("someone finds `origin.dev.bread-sheet.com`") was never open. The
`custom_header` move needed no image rebuild — the running container already checked the correct name —
and the `cors` reorder shipped with the following `dev` deploy. Verified against the live edge:

| Check | Result |
|---|---|
| `GET /api/products/:barcode` via `server.dev.bread-sheet.com` | `401 Authorization header missing` — past the gate, and carrying `Access-Control-Allow-Origin` |
| `OPTIONS` preflight, same path | `204` with `Allow-Origin` / `-Methods` / `-Headers` |
| `GET /api/...` straight to `origin.dev.bread-sheet.com` | `403 forbidden` — no `Via: CloudFront`, so genuinely bypassed the distribution and was refused |
| Same, with `X-Origin-Verify` set to a wrong value | `403 forbidden` |
| Raw `*.execute-api` URL | API Gateway's own `{"message":"Not Found"}` — still disabled |
| `GET /` via the distribution | `200` |

The gate now discriminates in the intended direction: traffic through CloudFront passes, traffic around
it does not.

## Implementation

Phase 1 is in progress in parallel with this ADR. Order matters where noted.

| # | Step | Where | Status |
|---|---|---|---|
| 0 | Confirm `aws_sns_topic.billing_alerts` has a confirmed email subscriber (`aws sns list-subscriptions-by-topic`) | console/CLI | ✅ (confirmed `breadsheet@pm.me`) |
| 1 | **L-1** — `requireRegistered` on `POST /api/products/upload-image`; update the route test and `backend.md` § endpoints | `server/` | ✅ |
| 2 | **Measure and set `thinkingConfig`** on both Gemini call sites; re-run `npm run measure:gemini` locally (ADR 0003 showed local predicts `dev`) and record \$/call. Decides L2's final cap | `server/` | ✅ (\$0.003568/call blended, confirms 300/day ≈ \$32/mo) |
| 3 | **L1** — `default_route_settings` 5 rps / burst 25; explicit upload route at 1 rps / burst 5, with the "exists to be throttled" comment | `terraform/api-gateway.tf` | ✅ |
| 4 | **D** — Cost Anomaly monitor + subscription, API Gateway `Count` alarm, log metric filter + `GeminiCalls` alarm, all → `billing_alerts`; GCP budget with email thresholds | `terraform/`, GCP console | ✅ |
| 5 | **L2** — `GeminiDailyUsage` Prisma model + migration, reservation function beside `geminiDeadline.ts`, `GEMINI_DAILY_CALL_CAP` in `config.ts` (fail-fast, validated integer), `503 daily_quota_exhausted`, tests incl. concurrency and fail-closed; `CLAUDE.md` env-var block, `backend.md`, Bruno docs for the new 503 | `server/` | ✅ |
| 6 | **L5** — distribution + OAC + WAF ACL + Free plan subscription; remove `PublicReadAllowProcessed`; `ASSET_BASE_URL` → distribution domain (task env var: forced replacement); fix `rds.tf` to use `var.db_max_allocated_storage` while in the file | `terraform/`, `infrastructure.md` | ✅ applied (distribution live, verified end-to-end); ✅ Free plan console step |
| 7 | **L4** — GCP budget → Pub/Sub → billing-detach function at \$40; `aws_budgets_budget_action` stopping RDS at 150% | GCP, `../../terraform/backstops-budget.tf` | ✅ applied; wiring verified with synthetic under-budget messages (real detach path deliberately never exercised) |
| 8 | Raise `GEMINI_DAILY_CALL_CAP` on `dev` to 300 once step 2 confirms ~\$0.0036/call | task env | ✅ |
| P2 | **Phase 2** — API distribution on Free plan 2: WAF geo `DE` + rate rule + origin-secret header, `disable_execute_api_endpoint`, `us-east-1` cert, DNS alias; CI allow path | `terraform/`, `server/app.ts`, `.github/workflows/test-native-e2e.yml` | ✅ infra applied and verified; ☐ Free plan console step; ☐ `EDGE_BYPASS_SECRET` copied to GitHub |
| P2a | **Phase 2 fix** — origin-secret header moves from WAF `insert_header` (arrives prefixed `x-amzn-waf-`, matched nothing, 403'd all API traffic) to the distribution's origin `custom_header`; `cors` reordered above the gates so such a rejection reads as 403 rather than as offline; regression test on the ordering | `terraform/dev-geo-restriction.tf`, `server/src/app.ts`, `server/src/app.test.ts` | ✅ applied and deployed 2026-09-12, verified end to end (see § Phase 2 verification) |

Steps 1, 3, 4 and 6 are independent of each other and can land in any order; 5 depends on 2 only
for its *number*, not its code; 8 depends on 2 and 5.

### Positive Consequences

* L-1, L0, L1 and L2 are synchronous and L5 is structural — none of them can be outrun, unlike a
  budget. D bounds how long anything else runs.
* L1 turns an unbounded gateway charge into arithmetic: 5 rps is ~\$17.78/mo of gateway + logs, and
  that number is a dial in `api-gateway.tf` rather than a hope.
* The Google bill, currently unguarded by anything, gets an in-process daily cap (L2), an hourly
  alarm (D), a per-minute damper (L0) and a hard stop (L4).
* Caps are sized against a 2-day detection window rather than an undetected month, which is what
  lets them be loose enough to develop against (150 products a day, five harness runs) while the
  ignored-for-a-month case still lands under \$90.
* **L5 removes a meter rather than choosing a number.** Image egress goes from unbounded to \$0 by
  construction, at \$0/mo, and it is the only Phase 1 layer with that property.
* The flat-rate plan also absorbs the WAF web ACL, the distribution's CloudWatch Logs ingestion and
  the TLS certificate — small line items the stack would otherwise pay.
* Phase 2 restores per-client rate limiting — the control Fact 1's table says the HTTP API cannot
  have — at the edge for \$0, and makes geo-restriction a genuine cost control because WAF-blocked
  requests on a flat-rate plan cost nothing and never reach API Gateway.
* None of this reopens ADR 0003: no load balancer, no REST API, no change to the Cloud Map
  integration.

### Negative Consequences

* Seven layers plus detection is more surface than a single guardrail, and each needs to be
  understood to be operated. The layering is justified only because no single layer covers all
  three vendors.
* Bound 2 of the sizing rule accepts that a month of ignored alarms can cost up to 2× the budget.
  That is a deliberate trade against caps that would make the stage useless; the alternative was
  30 calls a day.
* L2 at 100/day (the interim value) sits *at* bound 2's ceiling if thinking turns out to be on by
  default. It is tolerable only because step 2 is the next thing that happens.
* L1's per-route throttle requires adding a route that exists purely to be throttled — a mild
  wart in `api-gateway.tf` that needs its comment to survive future edits.
* L5 changes `ASSET_BASE_URL`, which is a task environment variable — the one kind of change ADR 0003
  found neither Terraform nor CD propagates without a forced replacement.
* **A flat-rate plan trades billing risk for delivery risk.** Over the allowance AWS may serve from
  fewer or more distant edge locations. That is the right trade for `dev` image delivery and an open
  question for `prod` (ADR 0003 step 7), where degraded delivery is a user-visible harm rather than
  an inconvenience.
* The Free plan's allowance (100 GB / 1M requests) is an order of magnitude below the pay-as-you-go
  always-free tier it replaces. Normal traffic is far inside it; the plan is chosen for its ceiling,
  not its allowance.
* Phase 2 adds an edge hop, a certificate in another region, a shared-secret header, a DNS change and
  a CI allow path — real complexity against an architecture ADR 0003 worked to simplify. This is why
  it is sequenced after Phase 1, `dev`-scoped and country-level.
* Subdivision-level geo is documented but not adopted; if someone enables it later without the
  break-glass, they will lock themselves out from a mobile network and it will not look like a
  geo problem.
* L4's RDS stop is only useful if the database is genuinely the runaway, which is unlikely given
  its flat pricing. It is cheap insurance, not a real defence.
* `budget.tf` remains AWS-only. The GCP budget is a separate Terraform provider / console artefact
  and will drift from this repo unless someone owns it.
* **The `FORECASTED >= 100%` notification is not yet live in practice.** AWS needs several weeks of
  billing history before it will emit a forecast, so on a young account the threshold ADR 0003
  called "the one that matters" is silent. D exists partly because of this.
* D is only as good as the SNS subscription nobody can put in Terraform. Step 0 is a manual check
  that will need repeating whenever the topic is recreated.

## References

* [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)
  — the feature matrix behind Fact 1.
* [Throttle requests to your HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)
  — stage and route settings; the only native control we own.
* [API Gateway pricing: throttled requests are billed](https://repost.aws/questions/QU5y4fo-e3RWyU5r4VmyPIzA/pricing-clarification-for-api-gateway)
  — Fact 2.
* [CloudFront flat-rate pricing plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)
  — the Free tier's 1M requests / 100 GB allowance, the no-overage guarantee and what replaces it
  (delivery adjustment), the mandatory WAF web ACL, the WAF/DDoS allowance exemption, the Route 53
  auto-transition on DNS overage, and the quota table (**3 Free plans per account, 100 plans, 1 apex
  domain per plan**) that closes the two-plans question.
* [Add CloudFront request headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html)
  — `CloudFront-Viewer-Country-Region` is the ISO 3166-2 first-level subdivision.
* [AWS WAF geographic match rule statement](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-geo-match.html)
  — the `awswaf:clientip:geo:region:<ISO>` label, and the `XX` fallback when a lookup fails.
* [AWS Cost Anomaly Detection](https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html)
  — the free account-level monitor behind D.
* [Disable billing to stop usage (Google Cloud)](https://cloud.google.com/billing/docs/how-to/notify)
  — the budget → Pub/Sub → detach-billing pattern behind L4, and the email thresholds behind D.
* [Vertex AI Gemini pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) — the
  \$1.50/M input, \$9.00/M output rates for `gemini-3.5-flash` used in the per-call table, and the
  rule that Gemini 3.x bills thinking tokens as output at the full rate.
* [ADR 0003](0003-always-on-production-cost-architecture.md) § step 6 — the billing alarm this ADR
  extends, and the ingress decision that constrains every option here.
