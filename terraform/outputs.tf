# Outputs for the cloud environment. All null when running the local (LocalStack)
# environment, since the cloud resources are not created there. `one()` collapses
# the count-gated (0-or-1 element) resource lists to a single value or null.

output "cluster_name" {
  description = "EKS cluster name (configure kubectl: aws eks update-kubeconfig --name <this>)."
  value       = one(module.eks[*].cluster_name)
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = one(module.eks[*].cluster_endpoint)
}

output "ecr_repository_url" {
  description = "ECR repo to push the server image to (CI: docker push <this>:<git-sha>)."
  value       = one(aws_ecr_repository.server[*].repository_url)
}

output "rds_endpoint" {
  description = "RDS endpoint host:port for assembling DATABASE_URL."
  value       = one(module.rds[*].db_instance_endpoint)
}

output "rds_master_secret_arn" {
  description = "Secrets Manager ARN holding the RDS master credential (username/password)."
  value       = one(module.rds[*].db_instance_master_user_secret_arn)
}

output "server_irsa_role_arn" {
  description = "IAM role ARN to annotate onto the bread-sheet-server ServiceAccount (eks.amazonaws.com/role-arn)."
  value       = one(aws_iam_role.server_irsa[*].arn)
}

output "images_bucket" {
  description = "S3 bucket for product images."
  value       = aws_s3_bucket.images.bucket
}