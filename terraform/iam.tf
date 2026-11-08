# ──────────── GitHub OIDC Provider ────────────────────────────────────────────

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["22ff89586561fc2d52f77491e9f1eff1b80be33e"]

  tags = merge(local.tags, { Name = "github-actions-oidc" })
}

# ──────────── ECS Execution Role ─────────────────────────────────────────────

resource "aws_iam_role" "ecs_execution" {
  name = "breadsheet-dev-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(local.tags, { Name = "breadsheet-dev-ecs-execution" })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_ssm" {
  name = "GetDevEnvVariablesFromSystemsManagerParameterStore"
  role = aws_iam_role.ecs_execution.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "GetDevEnvVariables"
      Effect   = "Allow"
      Action   = ["ssm:GetParameters"]
      Resource = "arn:aws:ssm:eu-west-1:493942067033:parameter/breadsheet/dev/*"
    }]
  })
}

# ──────────── ECS Task Role ──────────────────────────────────────────────────

resource "aws_iam_role" "ecs_task" {
  name = "breadsheet-dev-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(local.tags, { Name = "breadsheet-dev-ecs-task" })
}

resource "aws_iam_role_policy" "ecs_task_s3" {
  name = "PutRawImagesInS3"
  role = aws_iam_role.ecs_task.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "PutRawUploads"
      Effect   = "Allow"
      Action   = "s3:PutObject"
      Resource = "arn:aws:s3:::${var.s3_bucket_name}/raw/*"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_rds_iam" {
  name = "RdsIamConnect"
  role = aws_iam_role.ecs_task.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "RdsIamAuth"
      Effect   = "Allow"
      Action   = "rds-db:connect"
      Resource = "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.main.resource_id}/${var.db_iam_user}"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_exec" {
  name = "ECSExec"
  role = aws_iam_role.ecs_task.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      Resource = "*"
    }]
  })
}


# ──────────── CI Deployer Role ───────────────────────────────────────────────

resource "aws_iam_role" "deployer" {
  name = "breadsheet-dev-deployer"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:fabelhaft-io/bread-sheet:ref:refs/heads/main"
        }
      }
    }]
  })

  tags = merge(local.tags, { Name = "breadsheet-dev-deployer" })
}

resource "aws_iam_role_policy" "deployer" {
  name = "BreadsheetServerDeployment_DEV"
  role = aws_iam_role.deployer.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RegisterTaskDefs"
        Effect = "Allow"
        Action = [
          "ecs:RegisterTaskDefinition",
          "ecs:DescribeTaskDefinition",
        ]
        Resource = "*"
      },
      {
        Sid    = "DeployToService"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices",
        ]
        Resource = "arn:aws:ecs:eu-west-1:493942067033:service/breadsheet-server-dev/breadsheet-dev-server-service"
      },
      {
        Sid      = "PassTaskAndExecRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = [
          aws_iam_role.ecs_execution.arn,
          aws_iam_role.ecs_task.arn,
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
    ]
  })
}

# ──────────── CI Teardown Role (TICKET-P9-009) ───────────────────────────────
#
# Assumed by .github/workflows/dev-auto-teardown.yml to run Tier 3 on a schedule: snapshot
# RDS, then apply a saved `plan -destroy -target=aws_db_instance.main`. This is a separate role
# so that `breadsheet-dev-deployer` (which every CD run assumes) never gains
# rds:DeleteDBInstance. It has the same trust shape as the deployer. Scheduled runs always run
# on the default branch, so `ref:refs/heads/main` covers them, and a dispatch from any other
# branch is refused.
#
# Write access is scoped to the five resources of the asserted cascade
# (scripts/ops/dev-teardown.mjs EXPECTED_DESTROY_SET) and to the state object. Read access is
# what Terraform's refresh of the targeted subgraph needs, plus what the workflow reads itself.
#
# SPIKE (implementation step 1): the read set below is a first estimate. The pre-destroy refresh
# covers aws_db_instance.main and its dependencies (subnet group, private subnets, VPC, RDS
# security group). The apply waits on the deleted resources. Replace this comment with the
# final list once a dry run passes with no AccessDenied. Still open: whether DeleteDBInstance
# on a `manage_master_user_password` instance also needs secretsmanager:DeleteSecret from the
# caller. Settle it from a CloudTrail AccessDenied on the first real destroy, not by guessing.

locals {
  teardown_account     = data.aws_caller_identity.current.account_id
  teardown_rds_arn     = "arn:aws:rds:${var.aws_region}:${local.teardown_account}"
  teardown_db_arn      = "${local.teardown_rds_arn}:db:breadsheet-dev-database-1"
  teardown_snap_prefix = "${local.teardown_rds_arn}:snapshot:breadsheet-dev-auto-"
}

resource "aws_iam_role" "teardown" {
  name = "breadsheet-dev-teardown"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:fabelhaft-io/bread-sheet:ref:refs/heads/main"
        }
      }
    }]
  })

  # A teardown that hangs on a slow RDS delete must not lose its credentials mid-apply.
  max_session_duration = 7200

  tags = merge(local.tags, { Name = "breadsheet-dev-teardown" })
}

resource "aws_iam_role_policy" "teardown" {
  name = "BreadsheetTier3Teardown_DEV"
  role = aws_iam_role.teardown.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # ── Terraform state: the dev key and its S3-native lockfile only ──────────
      {
        Sid      = "StateList"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = "arn:aws:s3:::breadsheet-tfstate"
      },
      {
        Sid    = "StateReadWrite"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "arn:aws:s3:::breadsheet-tfstate/dev/terraform.tfstate",
          "arn:aws:s3:::breadsheet-tfstate/dev/terraform.tfstate.tflock",
        ]
      },

      # ── Refresh + waiters + the workflow's own reads (read-only) ──────────────
      # None of these support resource-level scoping in a way that helps here.
      {
        Sid    = "ReadTargetedSubgraph"
        Effect = "Allow"
        Action = [
          "rds:DescribeDBInstances",
          "rds:DescribeDBSnapshots",
          "rds:DescribeDBSubnetGroups",
          "rds:ListTagsForResource",
          "ec2:DescribeVpcs",
          "ec2:DescribeVpcAttribute",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSecurityGroupRules",
          "ec2:DescribeRouteTables",
          "ec2:DescribeNetworkAcls",
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:ListTagsForResource",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "budgets:ViewBudget",
          "budgets:DescribeBudgetAction",
          "budgets:DescribeBudgetActionsForBudget",
        ]
        Resource = "*"
      },

      # ── Snapshot before destroy (step 8) ───────────────────────────────────────
      {
        Sid    = "CreateAutoSnapshot"
        Effect = "Allow"
        Action = ["rds:CreateDBSnapshot", "rds:AddTagsToResource"]
        Resource = [
          local.teardown_db_arn,
          "${local.teardown_snap_prefix}*",
        ]
      },

      # ── Prune (step 11): auto snapshots this workflow tagged, nothing else ─────
      # Both the resource pattern and the tag condition exclude a manual
      # breadsheet-dev-pause-* snapshot. Either one alone would be enough.
      {
        Sid      = "PruneAutoSnapshots"
        Effect   = "Allow"
        Action   = "rds:DeleteDBSnapshot"
        Resource = "${local.teardown_snap_prefix}*"
        Condition = {
          StringEquals = { "rds:snapshot-tag/created-by" = "dev-auto-teardown" }
        }
      },

      # ── Destroy the five-resource cascade (step 9) ─────────────────────────────
      {
        Sid      = "DeleteDatabase"
        Effect   = "Allow"
        Action   = "rds:DeleteDBInstance"
        Resource = local.teardown_db_arn
      },
      {
        # The provider scales the service to 0 and drains it before deleting.
        Sid      = "DeleteService"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DeleteService"]
        Resource = "arn:aws:ecs:${var.aws_region}:${local.teardown_account}:service/${aws_ecs_cluster.main.name}/breadsheet-dev-server-service"
      },
      {
        Sid      = "DeregisterTaskDefinition"
        Effect   = "Allow"
        Action   = "ecs:DeregisterTaskDefinition"
        Resource = "*" # no resource-level support
      },
      {
        Sid      = "DeleteRdsIamConnectPolicy"
        Effect   = "Allow"
        Action   = "iam:DeleteRolePolicy"
        Resource = aws_iam_role.ecs_task.arn
      },
      {
        Sid      = "DeleteStopRdsBudgetAction"
        Effect   = "Allow"
        Action   = "budgets:DeleteBudgetAction"
        Resource = "arn:aws:budgets::${local.teardown_account}:budget/${aws_budgets_budget.monthly.name}/action/*"
      },
    ]
  })
}
