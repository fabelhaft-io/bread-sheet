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