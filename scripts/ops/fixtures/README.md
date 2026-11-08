# `terraform show -json` fixtures for `assertPlan`

`tier3-plan.ok.json` is a real, redacted `terraform show -json` of
`plan -destroy -target=aws_db_instance.main` against the dev state, captured 2026-11-08 (task
definition revision 48): exactly the five Tier 3 deletes. Note `complete: false`. Terraform
reports that for every targeted plan, so `assertPlan` must not require `complete`. The other
three are single mutations of it:

| File | Mutation | `assertPlan` must |
|---|---|---|
| `tier3-plan.extra-address.json` | a sixth resource is deleted | fail: not in the cascade |
| `tier3-plan.replace.json` | `aws_db_instance.main` is `[delete, create]` | fail: not a plain delete |
| `tier3-plan.missing-address.json` | `aws_budgets_budget_action.stop_rds` is gone | fail: missing from the plan |

`assertPlan` reads only `address`, `deposed`, `change.actions` and `errored`.

**Refreshing it.** Re-capture when the cascade changes (a new resource that interpolates
`aws_db_instance.main`). The plan file and its raw JSON hold secrets (the RDS endpoint, the task
definition's environment, every variable), so keep both outside the repo and delete them
afterwards:

```sh
scripts/dev-stack.sh plan -- -destroy -target=aws_db_instance.main -out=/tmp/tier3.tfplan
terraform -chdir=terraform show -json /tmp/tier3.tfplan > /tmp/tier3.raw.json
jq '
  def keep: {
    "aws_budgets_budget_action": ["action_type","budget_name"],
    "aws_db_instance": ["identifier","engine","engine_version","instance_class","skip_final_snapshot"],
    "aws_ecs_service": ["name","desired_count","launch_type"],
    "aws_ecs_task_definition": ["family","revision"],
    "aws_iam_role_policy": ["name","role"]
  };
  del(.prior_state, .planned_values, .configuration, .checks, .relevant_attributes)
  | .variables |= {server_image}
  | .resource_changes |= map(
      .type as $t
      | .change.before |= with_entries(select(.key as $k | keep[$t] | index($k)))
      | .change.before_sensitive = {} | .change.after_unknown = {})
' /tmp/tier3.raw.json > scripts/ops/fixtures/tier3-plan.ok.json
rm /tmp/tier3.tfplan /tmp/tier3.raw.json
```

`resource_changes[].change.before` holds every attribute of the resource, the full container
environment included, so it is reduced to an allowlist. `before_identity` (account ID, region,
names) is kept: the account ID is already committed in `terraform/environments/dev.tfvars`. A
new resource type in the cascade needs a `keep` entry, or its `before` comes out empty.

Then rebuild the three mutations from that file, each with a one-line `jq` (add a sixth
resource, set `aws_db_instance.main` to `["delete","create"]`, drop
`aws_budgets_budget_action.stop_rds`).
