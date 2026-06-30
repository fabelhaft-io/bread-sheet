output "cluster_name" {
  description = "EKS cluster name (configure kubectl: aws eks update-kubeconfig --name <this>)."
  value       = one(module.eks[*].cluster_name)
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = one(module.eks[*].cluster_endpoint)
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

output "gcp_wif_provider" {
  description = "Full WIF provider resource name — pass to `gcloud iam workload-identity-pools create-cred-config` to generate the pod credential config."
  value       = one(google_iam_workload_identity_pool_provider.eks_oidc[*].name)
}

output "gcp_service_account_email" {
  description = "GCP service account the pod impersonates (Vision/Vertex). Used by create-cred-config --service-account."
  value       = one(google_service_account.server[*].email)
}