# P9-009 Implementation Plan — Scheduled Tier 3 Teardown of the Dev Stack

**Date:** 2026-11-07
**Branch:** `infra/dev-auto-teardown` (target: `main`)
**Ticket:** [TICKET-P9-009] Scheduled Tier 3 Teardown of the Dev Stack

---

## Background

`docs/architecture/infrastructure.md` § *Pausing / Resuming the Dev Stack* documents Tier 3:
take a manual RDS snapshot, then `terraform destroy -target=aws_db_instance.main`. The
destroy brings down the four resources that depend on the DB. Once the ALB was gone, RDS
became the largest line item (~\$15/mo), and the Fargate task (~\$9/mo) goes with it. Tier 3
is the main cost lever.

It is a manual procedure, so it only runs when someone remembers to run it. A resumed stack
that is forgotten keeps billing until the next human teardown. This ticket runs Tier 3
automatically, so the most a resumed stack can cost is three days of uptime.

The first manual run was on 2026-11-07, with the steps run by hand exactly as documented. Three
findings from that run shape this plan:

1. **The cascade is five resources, not four.** `aws_budgets_budget_action.stop_rds`
   (`backstops-budget.tf:31`) interpolates `aws_db_instance.main.identifier`, so it is also
   destroyed. The runbook's cascade table omits it. An unattended run must assert the exact
   destroy set, so the table has to be correct.
2. **The image pin had drifted again.** `ecs.tf:56` pinned `04c6a55…`, but the live revision
   (47) ran `aaf9297…`. With a teardown every three days, every resume hits this, so it has to
   be fixed structurally, not by remembering.
3. **Stale snapshots pile up.** `breadsheet-dev-pause-2026-08-04` was still billing three
   months after its resume. Automation that creates a snapshot every cycle also has to prune.

---

## Key Decisions

### Run Terraform from GitHub Actions, not AWS APIs from a Lambda

| Option | Verdict |
|---|---|
| **Scheduled GitHub Actions workflow that runs the runbook's Terraform steps** | **Chosen.** Terraform stays the only thing that creates and destroys these resources, and state matches reality afterwards. The resume stays the documented single apply. The repo already has keyless AWS OIDC (`iam.tf:3`) and a remote S3 state with native locking (`backend.tf`) |
| EventBridge Scheduler → Lambda / Step Functions calling `CreateDBSnapshot` / `DeleteDBInstance` / `DeleteService` | Rejected. It is more reliable on schedule (GitHub can delay or drop cron runs under load), but it deletes resources Terraform still has in state. State would no longer match reality until the next refresh. It also duplicates the cascade in a second place that nothing keeps in sync with the HCL, which breaks *"All cloud resources defined in `terraform/`"* |

Missing a run is harmless: the next daily run catches up (see the cadence decision below).
GitHub's unreliable scheduling therefore costs at most one more day of uptime.

### "Every 3 days" = a daily check with a 72 h uptime gate, not a `*/3` cron

The `*/3` day-of-month field in cron counts from the start of each month. It fires on the 1st,
4th, …, 28th and 31st, then again on the 1st. That makes some gaps one day long and others
three, depending on the month. A fixed cadence would also tear down a stack resumed an hour
earlier.

Instead, the workflow runs **daily** (`17 2 * * *`, avoiding the top of the hour, when GitHub
runners are busiest) and tears down only when the stack has been **up for at least
`MAX_UPTIME_HOURS = 72`**. Uptime is read from `InstanceCreateTime` on
`breadsheet-dev-database-1`. Every Tier 3 resume creates the instance again from a snapshot, so
that timestamp *is* the time of the last resume. No extra state is needed.

| Stack state | Daily run does |
|---|---|
| RDS not found (already paused) | No-op, green, one summary line |
| Up for < 72 h | No-op, green, logs the time left until teardown |
| Up for ≥ 72 h | Tier 3 teardown |
| Keep-alive date set and today ≤ that date | No-op, green, logs the date |

`workflow_dispatch` takes `force: true` (skip the uptime gate) and `dry_run: true` (stop after
the plan assertion).

### Opt-out lives in a repo variable, not a resource tag

A tag added by hand to the RDS instance shows up as drift on the next apply, and the apply would
remove it. The opt-out is the repo variable **`DEV_KEEP_ALIVE_UNTIL`** (ISO date), set with
`gh variable set DEV_KEEP_ALIVE_UNTIL --body 2026-11-20`. It needs no AWS permission and no
Terraform, and it expires by itself.

The master switch is **`DEV_AUTO_TEARDOWN`** = `off | dry-run | on`. This follows the repo's
fail-fast convention: **an unset or unknown value fails the job** with a message telling you to
set it, rather than defaulting to either `off` (silently not saving money) or `on` (silently
destroying things).

### A dedicated teardown role, not more permissions on the deployer

`breadsheet-dev-deployer` can register task definitions and roll one service. Adding
`rds:DeleteDBInstance` to it would let every CD run delete the database. The plan adds a new
role, **`breadsheet-dev-teardown`**, with the same OIDC trust shape
(`sub = repo:fabelhaft-io/bread-sheet:ref:refs/heads/main`; scheduled runs always run on the
default branch). Its permissions are scoped to the five resources and the state object:

| Purpose | Actions | Scope |
|---|---|---|
| State | `s3:ListBucket`; `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` | `breadsheet-tfstate`, keys `dev/terraform.tfstate` and `dev/terraform.tfstate.tflock` only |
| Refresh of the targeted subgraph | `Describe*` / `Get*` / `List*` as found by the spike (step 1) | `*` where the service doesn't support resource scoping |
| Snapshot | `rds:CreateDBSnapshot`, `rds:AddTagsToResource` | the instance + `snapshot:breadsheet-dev-auto-*` |
| Prune | `rds:DeleteDBSnapshot` | `snapshot:breadsheet-dev-auto-*`, with `rds:snapshot-tag/created-by = dev-auto-teardown` |
| Destroy | `rds:DeleteDBInstance` | `db:breadsheet-dev-database-1` |
| | `ecs:UpdateService`, `ecs:DeleteService` | the one service ARN (the provider drains to 0 before deleting) |
| | `ecs:DeregisterTaskDefinition` | `*` (no resource-level support) |
| | `iam:DeleteRolePolicy` | `aws_iam_role.ecs_task` |
| | `budgets:DeleteBudgetAction`, `budgets:DescribeBudgetAction` | the monthly budget |

The prune statement deliberately can't touch manual `breadsheet-dev-pause-*` snapshots: the
resource pattern and the tag condition each exclude them on their own.

**Open question for the spike:** whether `DeleteDBInstance` on an instance with
`manage_master_user_password = true` also needs `secretsmanager:DeleteSecret` from the caller,
or whether RDS deletes the secret through its service-linked role. Find out from a CloudTrail
`AccessDenied`, don't guess.

### The plan is asserted before anything is destroyed

Nobody reads an unattended destroy plan, so the workflow checks it in code. It saves the plan
(`-out`), renders it with `terraform show -json`, and fails unless **every** resource change is a
`delete` and the set of addresses is **exactly**:

```
aws_db_instance.main
aws_ecs_service.server
aws_ecs_task_definition.server
aws_iam_role_policy.ecs_task_rds_iam
aws_budgets_budget_action.stop_rds
```

Anything missing, extra, or not a `delete` fails the job before the snapshot is taken.
Examples are a new resource that interpolates the DB, a provider upgrade that turns a delete
into a replace, or someone's half-applied change. When the cascade grows legitimately, this
list and the runbook table change in the same PR. The workflow then applies **that exact saved
plan file**, never a fresh `destroy`.

### Snapshots carry the image they were taken under

The snapshot is created with tags:

| Tag | Value |
|---|---|
| `created-by` | `dev-auto-teardown` |
| `image` | live `containerDefinitions[0].image` of the service's current revision |
| `task-def-revision` | that revision number |
| `git-sha` | `${{ github.sha }}` of the workflow run |

The image is not recorded in the snapshot id: snapshot ids allow only letters, digits and
hyphens, and image references contain `:` and `/`. The id is
`breadsheet-dev-auto-YYYYMMDD-HHMM` (UTC, so a forced second run on the same day doesn't
collide).

### Fixing the image pin: `var.server_image` + a resume script

Resumes now happen every few days, so finding #2 above can't keep being a manual check:

- `ecs.tf:56` reads **`image = var.server_image`**, with no default (fail fast).
  `container_definitions` is already in `ignore_changes`, so the variable is consumed only
  when the task definition is created. A different value in later applies plans no changes.
  `dev.tfvars` gets no value either, so it can't drift.
- **`scripts/dev-stack.sh resume`** (run locally with the human's own credentials) finds the
  newest snapshot, both `auto` and `pause`. It reads that snapshot's `image` tag and checks the
  manifest returns `200` from GHCR (the runbook's curl check, now automated). It then runs
  `terraform apply -var db_snapshot_identifier=<id> -var server_image=<image>`.
  `--image <ref>` overrides the image, for example to come back on the latest `main` image.
  Migrations are forward-only and run on start, so a newer image on an older snapshot is fine.
- Resume stays a **human, local** action. Automating it would give a CI role create
  permissions across RDS, ECS and IAM, and nothing needs a hands-free resume.
- Every other `terraform plan` / `apply` now needs `-var server_image=…` too. The script's
  `plan` subcommand reads the image from the live service. That way an operator never types
  the image, and never accidentally sets it to the one from a three-month-old snapshot.

### Snapshot retention: keep the newest two automatic ones

The workflow prunes only after the new snapshot is `available` **and** the destroy succeeded.
It deletes `created-by = dev-auto-teardown` snapshots beyond the newest two. One is the copy
that matters; the second covers a resume that turns out to be bad. It never prunes manual
`pause` snapshots; it lists them in the job summary so they stay visible.

---

## Knock-on effects that ship in this ticket

A stack that is down most of the time breaks three things that assume it is up:

| Affected | What breaks | Fix in this ticket |
|---|---|---|
| `build-image.yml` → `deploy-dev` | Every `server/**` push to `main` while paused fails at `UpdateService` (`ServiceNotActiveException`). This red ✗ means nothing. The image is still pushed | A first step that checks `describeServices` status. If it is `INACTIVE`, write a notice in the job summary (*"dev paused — image pushed, not rolled out; resume with `scripts/dev-stack.sh resume --image …:<sha>`"*) and skip the remaining steps. Skipped, not failed |
| `test-native-e2e.yml` (Maestro) | Points `EXPO_PUBLIC_API_URL` at dev. While paused, the scan flows fail in ways that look like regressions | A preflight `curl` against the API before the emulator boots. If dev is paused, **fail** with *"dev stack is paused — resume it or this run proves nothing"*. A fail, not a skip: a skipped E2E suite on a PR reads as a pass |
| `keepalive.tf` weekly Lambda | Throws on non-2xx, so it errors every week while paused. With no task registered in Cloud Map, its request doesn't reach the VPC link either, so the link goes `INACTIVE` after 60 days paused | Docs only: note that the first requests after a resume following more than 60 days paused fail for a few minutes. Nothing alarms on that Lambda's errors today, so there's no false alert to suppress |

**Concurrency with CD.** The teardown job joins the existing `deploy-dev` concurrency group, so
it never runs during a rollout. If a teardown is pending when a deploy arrives, GitHub cancels
the pending teardown and keeps only the newest pending run in the group. That is acceptable:
tomorrow's run catches up. Terraform's S3 lockfile covers a human apply that runs at the same
time (`-lock-timeout=5m`, then fail).

---

## Workflow outline — `.github/workflows/dev-auto-teardown.yml`

```
on:
  schedule: [cron: '17 2 * * *']
  workflow_dispatch: { inputs: { force: bool, dry_run: bool } }
concurrency: { group: deploy-dev, cancel-in-progress: false }
permissions: { contents: read, id-token: write }

1. Mode gate         DEV_AUTO_TEARDOWN ∈ {off,dry-run,on} else fail; off → exit 0
2. Keep-alive gate   today ≤ DEV_KEEP_ALIVE_UNTIL → exit 0
3. OIDC              assume breadsheet-dev-teardown
4. Uptime gate       DescribeDBInstances: NotFound → exit 0; < 72 h and !force → exit 0
5. Terraform init    exact version from setup-terraform, -lockfile=readonly
6. Plan              plan -destroy -target=aws_db_instance.main -out=tier3.tfplan
                     -var server_image=<live image> (required var; unused by a destroy)
7. Assert plan       exactly the 5 addresses, all delete — else fail
   dry-run → stop here, write plan to summary
8. Snapshot          create-db-snapshot with tags; wait db-snapshot-completed; assert available
9. Destroy           terraform apply tier3.tfplan
10. Verify           DBInstanceNotFound; service INACTIVE
11. Prune            created-by=dev-auto-teardown beyond newest 2
12. Summary          snapshot id, image, pruned ids, lingering manual snapshots, resume command
```

Failure notification: a failed scheduled run emails whoever last edited the cron in the
workflow file (GitHub default). There is one developer, so that's enough. Publishing to
`aws_sns_topic.billing_alerts` is a later option if the email gets filtered.

**Logic placement.** Steps 1, 2, 4, 7 and 11 are decisions, not plumbing. They live in one
dependency-free Node ESM module, **`scripts/ops/dev-teardown.mjs`**, with each decision a pure
function (`gate(mode, keepAliveUntil, createTime, now, force)`,
`assertPlan(planJson)`, `snapshotsToPrune(snapshots, keep)`) and a small CLI the workflow
calls. Tests use `node --test` in `scripts/ops/dev-teardown.test.mjs`, with no new dependency.
The plan assertion is tested against real `terraform show -json` fixtures, including one with
an extra address and one with a replace.

---

## Implementation steps

1. **Spike: can a targeted plan run in CI at all?** Two unknowns that would change the design:
   - **Google provider configuration.** `main.tf:43` configures `google` for
     `gcp-wif.tf` / `detection.tf`. Run `plan -destroy -target=aws_db_instance.main` with GCP
     credentials hidden (`CLOUDSDK_CONFIG=$(mktemp -d)`, no `GOOGLE_APPLICATION_CREDENTIALS`).
     Targeting should prune the provider out of the graph. If it doesn't, the options are a
     GitHub → GCP WIF binding with a no-permissions SA, or a `-refresh=false` design that has
     to be justified separately. Decide before writing the workflow.
   - **The refresh permission set.** Build the role with only state access plus the destroy
     statements, run the plan, and add `Describe*`/`Get*` actions until `AccessDenied` stops.
     Record the final list in the HCL comment.
   - Also settle the open `secretsmanager:DeleteSecret` question (needs one real destroy, so
     do it on a cycle that is due anyway).
2. **Terraform:** `var.server_image` (no default) wired into `ecs.tf`; `aws_iam_role.teardown`
   + `aws_iam_role_policy.teardown` in `iam.tf` (standalone policy resource, like the
   deployer's). Apply locally.
3. **`scripts/ops/dev-teardown.mjs`** + `node --test` suite, with fixtures captured from a real
   `terraform show -json tier3.tfplan`.
4. **`scripts/dev-stack.sh`** with `resume`, `plan` and `status` subcommands (status: uptime,
   time left until auto-teardown, keep-alive date, snapshots).
5. **`.github/workflows/dev-auto-teardown.yml`**, then `gh variable set DEV_AUTO_TEARDOWN
   --body dry-run`.
6. **`build-image.yml` and `test-native-e2e.yml`** preflights from the knock-on table.
7. **Roll out:** about a week of `dry-run` to confirm the gate decisions and the plan assertion
   pass on real state. Then one `force` run with `on` while watching, then let the schedule run.
8. **Docs**, in the same PR:
   - `infrastructure.md` § Pausing / Resuming: a **"Tier 3, automated"** subsection (cadence,
     switches, keep-alive, resume via script). Fix the cascade table (add
     `aws_budgets_budget_action.stop_rds`). Replace the manual image-pin warning with
     `var.server_image`. Move the hand-run commands to *"manual fallback"*.
   - `infrastructure.md` § VPC link keepalive: the 60-day-paused caveat.
   - `infrastructure.md` § Terraform ↔ CD Ownership Split: `deploy-dev` skips while paused.
   - `CLAUDE.md` Infrastructure section: one paragraph (teardown role, switches, `server_image`
     is required on every plan/apply).
   - No ADR. This automates an existing documented procedure under ADR 0005's cost goals. It
     doesn't make a new architectural choice.

---

## Amendment (2026-11-08): nightly, not 72 h

After review, the cadence changed: **every nightly run tears down a running stack**, with no
minimum uptime. The 72 h gate and the `force` dispatch input are gone, and a dispatch now means
"tear down now, if running". `DEV_KEEP_ALIVE_UNTIL` is the way to keep the stack up overnight.
The rest of the design is unchanged. Where the decision above and the acceptance criteria below say
"≥ 72 h" / "< 72 h", read "running" / (no such case).

## Implementation status (2026-11-08)

The code is done on this branch: steps 2 (HCL only), 3, 4, 5 (workflow file), 6 and 8. The steps
that need AWS haven't run yet. The local AWS session had expired, and they are live changes.

| Step | State |
|---|---|
| 1. Spike | **Open.** The read set in `aws_iam_role_policy.teardown` is a first estimate. It assumes the pre-destroy refresh covers only `aws_db_instance.main` and its dependencies. The Google provider pruning and `secretsmanager:DeleteSecret` are still unverified |
| 2. Terraform | HCL written and `validate`d. **Not applied.** While paused, apply only through `scripts/dev-stack.sh resume` (it creates the role along with the rest). A plain apply would create an empty DB |
| 3. Decision module | Done, 34 `node --test` cases, in CI as the `ops` job. Fixtures are hand-built in the `terraform show -json` shape. Replace `tier3-plan.ok.json` with a real capture from the first dry run (`scripts/ops/fixtures/README.md`) |
| 4. `scripts/dev-stack.sh` | Done (`status`, `resume`, `plan`, `apply`). The GHCR manifest check was verified live (200 for `aaf9297…`, 404 for a bogus tag). The AWS paths haven't run yet |
| 5. Workflow | File done. `gh variable set DEV_AUTO_TEARDOWN --body dry-run` not yet set (until it is, the scheduled run fails by design) |
| 6. CD / Maestro preflights | Done |
| 7. Rollout | Open: about a week on `dry-run`, then one `force` + `on` run while watching |
| 8. Docs | Done (`infrastructure.md`, `CLAUDE.md`) |

The 2026-11-07 manual snapshot has no `image` tag, so the first resume needs
`scripts/dev-stack.sh resume --image ghcr.io/fabelhaft-io/bread-sheet-server:aaf9297fc0e94eb49aefcb7e15d83f04c5a80959`.

## Acceptance criteria

- [ ] A daily scheduled run is a no-op (green) when the stack is paused, up for < 72 h, kept
      alive, or `DEV_AUTO_TEARDOWN=off`; it fails when the variable is unset or unknown.
- [ ] Up for ≥ 72 h with `on`: snapshot created with `created-by`/`image`/`task-def-revision`
      tags and `available` **before** any destroy; exactly the five asserted resources
      destroyed; RDS `NotFound`, service `INACTIVE`.
- [ ] A plan with any extra, missing or non-`delete` change fails before the snapshot step
      (unit-tested on fixtures).
- [ ] Only `created-by=dev-auto-teardown` snapshots beyond the newest two are pruned; the
      role is denied deleting a `breadsheet-dev-pause-*` snapshot (tested with the CLI).
- [ ] `scripts/dev-stack.sh resume` brings the stack back on the snapshot's image in one apply,
      and the follow-up `scripts/dev-stack.sh plan` reports no changes.
- [ ] `deploy-dev` is skipped (not failed) while paused; Maestro fails with the "dev is paused"
      message while paused.
- [ ] `breadsheet-dev-deployer`'s permissions are unchanged.
- [ ] Docs updated as listed in step 8.

## Out of scope

- Automated **resume**: see the decision above.
- Tearing down anything beyond Tier 3 (VPC, API Gateway, S3, CloudFront, DNS). These cost about
  \$1/mo at rest together and are slow or fragile to recreate (ACM validation, CloudFront
  propagation).
- Prod. Prod is meant to be always on (ADR 0003).
