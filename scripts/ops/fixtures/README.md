# `terraform show -json` fixtures for `assertPlan`

`tier3-plan.ok.json` has the shape of `terraform show -json tier3.tfplan` for
`plan -destroy -target=aws_db_instance.main` against the dev state: exactly the five Tier 3 deletes.
The other three are single mutations of it:

| File | Mutation | `assertPlan` must |
|---|---|---|
| `tier3-plan.extra-address.json` | a sixth resource is deleted | fail: not in the cascade |
| `tier3-plan.replace.json` | `aws_db_instance.main` is `[delete, create]` | fail: not a plain delete |
| `tier3-plan.missing-address.json` | `aws_budgets_budget_action.stop_rds` is gone | fail: missing from the plan |

`before` blocks are trimmed to a few attributes. `assertPlan` reads only `address`, `deposed`,
`change.actions` and `errored`.

**Refresh from real state.** Implementation step 3 of `docs/P9-009-implementation-plan.md`: once
the teardown role exists, capture the real output from a dry run and replace `tier3-plan.ok.json`
with it. Then rebuild the three mutations from that file:

```sh
terraform -chdir=terraform plan -destroy -target=aws_db_instance.main \
  -var-file=environments/dev.tfvars -var server_image=<live image> -out=tier3.tfplan
terraform -chdir=terraform show -json tier3.tfplan > scripts/ops/fixtures/tier3-plan.ok.json
```

The JSON includes `prior_state`, so redact it before committing. It holds the RDS endpoint, the
task definition's environment, and so on. Delete `prior_state`, `planned_values` and
`configuration` with `jq 'del(.prior_state, .planned_values, .configuration)'`, and keep
`resource_changes`.
