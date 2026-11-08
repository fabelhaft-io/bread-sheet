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
  # 512 MB, measured rather than assumed. This was briefly raised to 1024 on the
  # theory that sharp/libvips over a 4 MB upload buffer needed the headroom, but
  # ADR 0003 step 0b measured MemoryUtilization peaking at 12.1% of 1024 MB
  # (~124 MB) across 60 serial image uploads plus two multimodal calls each —
  # about 24% of this 512. The headroom was not being used, so the ~$1.62/mo is
  # not being spent. 256 CPU permits only 512 / 1024 / 2048 MB.
  #
  # Revisit if uploads grow: the sample used 521 KB images against a 4 MB multer
  # cap, and CloudWatch's 1-minute Maximum can miss a sub-minute spike.
  memory             = "512"
  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name = "server"
    # Consumed at CREATE only: `ignore_changes = [container_definitions]` below hides CI's
    # push-deployed revisions from Terraform, so a different value on a later apply plans no
    # change. It matters on a Tier 3 resume, which creates this resource again.
    # scripts/dev-stack.sh supplies it (the snapshot's `image` tag on `resume`, the live
    # service's image on `plan` / `apply`). That way no hardcoded pin can drift behind the
    # running revision. See infrastructure.md § Pausing / Resuming the Dev Stack.
    image     = var.server_image
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    command = ["sh", "scripts/start.sh"]

    healthCheck = {
      command  = ["CMD-SHELL", "wget -q -O- http://localhost:3000/ || exit 1"]
      interval = 30
      timeout  = 5
      retries  = 3
      # Replaces health_check_grace_period_seconds (ALB-only, now removed).
      # Must cover scripts/start.sh running `npm run db:deploy` before the
      # server listens — that is why it is 150 and not the ALB's 120.
      startPeriod = 150
    }

    environment = [
      { name = "PORT", value = "3000" },
      { name = "NODE_ENV", value = "production" },
      { name = "LOG_LEVEL", value = "info" },
      { name = "DB_SSL", value = "verify-full" },
      { name = "DB_AUTH", value = "iam" },
      { name = "DB_HOST", value = aws_db_instance.main.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
      { name = "DB_USER", value = var.db_iam_user },
      { name = "DB_NAME", value = "breadsheet" },
      { name = "DATABASE_URL", value = "postgresql://${var.db_iam_user}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/breadsheet" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "S3_MODE", value = "aws" },
      { name = "S3_BUCKET_NAME", value = var.s3_bucket_name },
      { name = "ASSET_BASE_URL", value = "https://${aws_cloudfront_distribution.images.domain_name}" },
      { name = "VISION_MODE", value = "llm" },
      { name = "PLAUSIBILITY_MODE", value = "gemini" },
      { name = "GEMINI_DAILY_CALL_CAP", value = "300" },
      { name = "APP_DEEP_LINK_SCHEME", value = "breadsheet" },
      { name = "GOOGLE_GENAI_USE_VERTEXAI", value = "true" },
      { name = "GOOGLE_CLOUD_PROJECT", value = var.gcp_project },
      { name = "GOOGLE_CLOUD_LOCATION", value = var.gcp_location },
      { name = "GCP_WORKLOAD_IDENTITY_AUDIENCE", value = "//iam.googleapis.com/projects/1054240616692/locations/global/workloadIdentityPools/breadsheet-dev/providers/aws-ecs" },
      { name = "GCP_SERVICE_ACCOUNT_EMAIL", value = "breadsheet-dev-vision@breadsheet-496522.iam.gserviceaccount.com" },
    ]

    secrets = [
      { name = "SUPABASE_URL", valueFrom = aws_ssm_parameter.supabase_url.arn },
      { name = "SUPABASE_PUBLISHABLE_DEFAULT_KEY", valueFrom = aws_ssm_parameter.supabase_key.arn },
      { name = "ORIGIN_VERIFY_SECRET", valueFrom = aws_ssm_parameter.origin_verify_secret.arn },
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

  service_registries {
    registry_arn   = aws_service_discovery_service.server.arn
    container_name = "server"
    container_port = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = merge(local.tags, { Name = "breadsheet-dev-server-service" })

  lifecycle {
    ignore_changes = [task_definition]
  }
}