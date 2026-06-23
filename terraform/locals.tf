# Shared locals for the cloud (real-AWS) resources.
#
# Everything VPC/EKS/RDS/ECR/IRSA is gated on `cloud_count`: it is 1 on real AWS
# and 0 for the LocalStack ("local") environment, which only needs the S3 bucket
# and image-resizer Lambda (see s3.tf / lambda.tf). `local.is_local` is defined
# in main.tf as `var.localstack_endpoint != ""`.
locals {
  cloud_count = local.is_local ? 0 : 1

  name_prefix  = "breadsheet-${var.environment}"
  cluster_name = "breadsheet-${var.environment}"

  tags = {
    Project     = "bread-sheet"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Availability zones — only resolved for real AWS (the data source would try to
# reach AWS during plan, which we never do for the local environment).
data "aws_availability_zones" "available" {
  count = local.cloud_count
  state = "available"
}