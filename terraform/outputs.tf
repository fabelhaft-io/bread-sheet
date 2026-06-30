output "rds_endpoint" {
  description = "RDS endpoint (host:port) for assembling DATABASE_URL."
  value       = aws_db_instance.main.endpoint
}

output "images_bucket" {
  description = "S3 bucket name for product images."
  value       = aws_s3_bucket.images.bucket
}

output "alb_dns_name" {
  description = "ALB DNS name."
  value       = aws_lb.main.dns_name
}

output "server_url" {
  description = "Public URL of the server."
  value       = "https://${aws_route53_record.server.fqdn}"
}

output "ecs_cluster_name" {
  description = "ECS cluster name (used by CI deploy)."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name (used by CI deploy)."
  value       = aws_ecs_service.server.name
}

output "task_execution_role_arn" {
  description = "ECS task execution role ARN."
  value       = aws_iam_role.ecs_execution.arn
}

output "task_role_arn" {
  description = "ECS task role ARN."
  value       = aws_iam_role.ecs_task.arn
}

output "deployer_role_arn" {
  description = "CI deployer role ARN (GitHub Actions assumes this)."
  value       = aws_iam_role.deployer.arn
}

output "route53_zone_id" {
  description = "Route 53 hosted zone ID for dev.bread-sheet.com."
  value       = aws_route53_zone.dev.zone_id
}

output "route53_nameservers" {
  description = "NS records to delegate from the parent zone."
  value       = aws_route53_zone.dev.name_servers
}
