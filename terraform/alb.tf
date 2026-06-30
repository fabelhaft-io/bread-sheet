# ──────────── Application Load Balancer ────────────────────────────────────────

resource "aws_lb" "main" {
  name               = "breadsheet-dev-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public["az1"].id, aws_subnet.public["az2"].id]
  ip_address_type    = "ipv4"

  tags = merge(local.tags, { Name = "breadsheet-dev-alb" })
}

# ──────────── Target Group ────────────────────────────────────────────────────

resource "aws_lb_target_group" "server" {
  name        = "breadsheet-dev-alb-target-group"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/"
    matcher             = "200"
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 3
    unhealthy_threshold = 2
  }

  tags = merge(local.tags, { Name = "breadsheet-dev-alb-target-group" })
}

# ──────────── ACM Certificate ─────────────────────────────────────────────────

resource "aws_acm_certificate" "server" {
  domain_name       = "server.dev.bread-sheet.com"
  validation_method = "DNS"

  tags = merge(local.tags, { Name = "server.dev.bread-sheet.com" })

  lifecycle {
    create_before_destroy = true
  }
}

# ──────────── HTTPS Listener (443) ────────────────────────────────────────────

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09"
  certificate_arn   = aws_acm_certificate.server.arn

  default_action {
    type = "forward"

    forward {
      target_group {
        arn = aws_lb_target_group.server.arn
      }
    }
  }

  tags = merge(local.tags, { Name = "breadsheet-dev-https-listener" })
}

# ──────────── HTTP Listener (80 → redirect to HTTPS) ─────────────────────────

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = merge(local.tags, { Name = "breadsheet-dev-http-redirect" })
}