variable "environment" {
  type        = string
  description = "Deployment environment."
  validation {
    condition     = contains(["local", "dev", "production"], var.environment)
    error_message = "environment must be 'local', 'dev', or 'production'."
  }
}

variable "aws_region" {
  type        = string
  description = "AWS region for all resources."
}

variable "localstack_endpoint" {
  type        = string
  default     = ""
  description = "Override all AWS service endpoints. Set to http://localhost:4566 for LocalStack; leave empty for real AWS."
}

variable "s3_bucket_name" {
  type        = string
  description = "Name of the S3 bucket for image storage."
}

# ── Cloud (VPC / EKS / RDS) — only used when localstack_endpoint == "" ─────────
# Defaults are sized for a cheap dev environment; override in production.tfvars.

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC."
  default     = "10.20.0.0/16"
}

variable "single_nat_gateway" {
  type        = string
  description = "Use a single shared NAT gateway (cheaper) instead of one per AZ."
  default     = true
}

variable "cluster_version" {
  type        = string
  description = "EKS Kubernetes version."
  default     = "1.31"
}

variable "node_instance_types" {
  type        = list(string)
  description = "Instance types for the EKS managed node group."
  default     = ["t3.small"]
}

variable "node_desired_size" {
  type        = number
  description = "Desired number of EKS worker nodes."
  default     = 2
}

variable "node_min_size" {
  type        = number
  description = "Minimum number of EKS worker nodes."
  default     = 1
}

variable "node_max_size" {
  type        = number
  description = "Maximum number of EKS worker nodes."
  default     = 3
}

variable "db_engine_version" {
  type        = string
  description = "RDS Postgres major engine version."
  default     = "16"
}

variable "db_instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type        = number
  description = "RDS allocated storage (GiB)."
  default     = 20
}

variable "db_max_allocated_storage" {
  type        = number
  description = "RDS storage autoscaling ceiling (GiB)."
  default     = 50
}

variable "db_multi_az" {
  type        = bool
  description = "Run RDS across multiple AZs (production HA)."
  default     = false
}

variable "db_skip_final_snapshot" {
  type        = bool
  description = "Skip the final snapshot on RDS destroy (dev convenience)."
  default     = true
}

variable "db_deletion_protection" {
  type        = bool
  description = "Protect the RDS instance from accidental deletion."
  default     = false
}