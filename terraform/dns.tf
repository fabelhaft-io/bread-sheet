# ──────────── Route 53 Hosted Zone ────────────────────────────────────────────

resource "aws_route53_zone" "dev" {
  name    = "dev.bread-sheet.com"
  comment = "Host the dev stage of breadsheet"

  tags = merge(local.tags, { Name = "dev.bread-sheet.com" })
}

# ──────────── ACM DNS Validation Record ───────────────────────────────────────

resource "aws_route53_record" "acm_validation" {
  zone_id = aws_route53_zone.dev.zone_id
  name    = tolist(aws_acm_certificate.server.domain_validation_options)[0].resource_record_name
  type    = "CNAME"
  ttl     = 300
  records = [tolist(aws_acm_certificate.server.domain_validation_options)[0].resource_record_value]
}

resource "aws_acm_certificate_validation" "server" {
  certificate_arn         = aws_acm_certificate.server.arn
  validation_record_fqdns = [aws_route53_record.acm_validation.fqdn]
}

# ──────────── A Record → ALB ──────────────────────────────────────────────────

resource "aws_route53_record" "server" {
  zone_id = aws_route53_zone.dev.zone_id
  name    = "server.dev.bread-sheet.com"
  type    = "A"

  alias {
    name                   = "dualstack.${aws_lb.main.dns_name}"
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
