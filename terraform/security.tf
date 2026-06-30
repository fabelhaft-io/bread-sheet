# ──────────── ALB Security Group ──────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "BreadSheet DEV SG Load Balancer"
  description = "Exposed to internet for routing via Load Balancer in BreadSheet DEV stage"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = merge(local.tags, {
    Name     = "breadsheet-dev-sg-load-balancer"
    Public   = "true"
    Resource = "ALB"
  })
}

# ──────────── Task Security Group ─────────────────────────────────────────────

resource "aws_security_group" "task" {
  name        = "BreadSheet DEV SG Tasks"
  description = "Security Group for task ressources - necessary to respond to requests, e.g., Fargate"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = merge(local.tags, {
    Name     = "breadsheet-dev-sg-tasks"
    Resource = "Fargate"
  })
}

# ──────────── RDS Security Group ──────────────────────────────────────────────

resource "aws_security_group" "rds" {
  name        = "BreadSheet DEV SG Database"
  description = "Strict Security Group for connection to the databases"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.task.id]
  }

  tags = merge(local.tags, {
    Name     = "breadsheet-dev-sg-execution"
    Resource = "database"
  })
}