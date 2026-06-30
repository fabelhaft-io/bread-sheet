# ──────────── DB Subnet Group ─────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name        = "breadsheet-dev-db-subnets"
  description = "The subnet group for private databases."
  subnet_ids  = [aws_subnet.private["az1"].id, aws_subnet.private["az2"].id]

  tags = merge(local.tags, { Name = "breadsheet-dev-db-subnets" })
}

# ──────────── RDS Instance ────────────────────────────────────────────────────

resource "aws_db_instance" "main" {
  identifier = "breadsheet-dev-database-1"

  engine         = "postgres"
  engine_version = "18.3"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "breadsheet"
  username = "db_admin_1001"
  port     = 5432

  multi_az            = var.db_multi_az
  publicly_accessible = false

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  iam_database_authentication_enabled = true

  skip_final_snapshot    = var.db_skip_final_snapshot
  deletion_protection    = var.db_deletion_protection
  copy_tags_to_snapshot  = true

  performance_insights_enabled = true
  backup_retention_period      = 1

  enabled_cloudwatch_logs_exports = ["iam-db-auth-error", "postgresql", "upgrade"]

  manage_master_user_password = false

  tags = merge(local.tags, { Name = "breadsheet-dev-database-1" })

  lifecycle {
    ignore_changes = [password]
  }
}