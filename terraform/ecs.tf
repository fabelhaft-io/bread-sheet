# ──────────── CloudWatch Log Group ────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "server" {
  name              = "/ecs/breadsheet-dev-server"
  retention_in_days = 1

  tags = merge(local.tags, { Name = "breadsheet-dev-ecs-log-group" })
}

# ──────────── ECS Cluster ─────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "breadsheet-server-dev"

  configuration {
    execute_command_configuration {
      logging = "DEFAULT"
    }
  }

  tags = merge(local.tags, { Name = "breadsheet-server-dev" })
}

# ──────────── ECS Task Definition ─────────────────────────────────────────────

resource "aws_ecs_task_definition" "server" {
  family                   = "breadsheet-dev-server"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "server"
    image     = "ghcr.io/fabelhaft-io/bread-sheet-server:c58810518c3b2e91fa3e5ab2f19a4b95260dc8c1"
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    command = ["sh", "-c", "npm run db:deploy && node dist/server.js"]

    environment = [
      { name = "PORT", value = "3000" },
      { name = "NODE_ENV", value = "production" },
      { name = "LOG_LEVEL", value = "info" },
      { name = "DB_SSL", value = "verify-full" },
      { name = "AWS_REGION", value = "eu-west-1" },
      { name = "S3_MODE", value = "aws" },
      { name = "S3_BUCKET_NAME", value = var.s3_bucket_name },
      { name = "ASSET_BASE_URL", value = "https://${var.s3_bucket_name}.s3.eu-west-1.amazonaws.com" },
      { name = "VISION_MODE", value = "llm" },
      { name = "PLAUSIBILITY_MODE", value = "gemini" },
      { name = "APP_DEEP_LINK_SCHEME", value = "breadsheet" },
      { name = "GOOGLE_GENAI_USE_VERTEXAI", value = "true" },
      { name = "GOOGLE_CLOUD_PROJECT", value = var.gcp_project },
      { name = "GOOGLE_CLOUD_LOCATION", value = var.gcp_location },
      { name = "GCP_WORKLOAD_IDENTITY_AUDIENCE", value = "//iam.googleapis.com/projects/1054240616692/locations/global/workloadIdentityPools/breadsheet-dev/providers/aws-ecs" },
      { name = "GCP_SERVICE_ACCOUNT_EMAIL", value = "breadsheet-dev-vision@breadsheet-496522.iam.gserviceaccount.com" },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "SUPABASE_URL", valueFrom = aws_ssm_parameter.supabase_url.arn },
      { name = "SUPABASE_PUBLISHABLE_DEFAULT_KEY", valueFrom = aws_ssm_parameter.supabase_key.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.server.name
        "awslogs-region"        = "eu-west-1"
        "awslogs-stream-prefix" = "breadsheet-server"
      }
    }
  }])

  tags = merge(local.tags, { Name = "breadsheet-dev-server" })

  lifecycle {
    ignore_changes = [container_definitions]
  }
}

# ──────────── ECS Service ─────────────────────────────────────────────────────

resource "aws_ecs_service" "server" {
  name            = "breadsheet-dev-server-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.server.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  enable_ecs_managed_tags = true
  enable_execute_command  = true

  network_configuration {
    subnets          = [aws_subnet.public["az1"].id, aws_subnet.public["az2"].id]
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.server.arn
    container_name   = "server"
    container_port   = 3000
  }

  health_check_grace_period_seconds = 120

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = merge(local.tags, { Name = "breadsheet-dev-server-service" })

  lifecycle {
    ignore_changes = [task_definition]
  }
}