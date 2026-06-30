# Managed PostgreSQL (RDS) for the API. Real-AWS only.
#
# Lives in the private subnets; reachable only from the ECS taks security group.

resource "aws_security_group" "rds" {
  count = local.cloud_count

  name        = "${local.name_prefix}-rds"
  description = "Allow Postgres from the EKS nodes"
  vpc_id      = module.vpc[0].vpc_id

  ingress {
    description     = "Postgres from EKS nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks[0].node_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 7.0"

  count = local.cloud_count

  identifier = "${local.name_prefix}-db"

  engine               = "postgres"
  engine_version       = var.db_engine_version
  family               = "postgres${split(".", var.db_engine_version)[0]}"
  major_engine_version = var.db_engine_version
  instance_class       = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage

  db_name  = "breadsheet"
  username = "breadsheet"
  port     = 5432

  # RDS-managed master credential stored in Secrets Manager (no password in state).
  manage_master_user_password = true

  multi_az               = var.db_multi_az
  create_db_subnet_group = true
  subnet_ids             = module.vpc[0].private_subnets
  vpc_security_group_ids = [aws_security_group.rds[0].id]

  # Dev convenience: skip the final snapshot so destroy is clean. Override in
  # production.tfvars.
  skip_final_snapshot = var.db_skip_final_snapshot
  deletion_protection = var.db_deletion_protection

  tags = local.tags
}