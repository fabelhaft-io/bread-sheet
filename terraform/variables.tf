variable "environment" {
  type        = string
  description = "Deployment environment."
  validation {
    condition     = contains(["dev", "production"], var.environment)
    error_message = "environment must be 'dev' or 'production'."
  }
}

variable "aws_region" {
  type        = string
  description = "AWS region for all resources."
}

variable "s3_bucket_name" {
  type        = string
  description = "Name of the S3 bucket for image storage."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC."
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  type        = map(string)
  description = "Map of logical AZ key to AWS AZ name (AZ IDs: az1=euw1-az1=eu-west-1c, az2=euw1-az2=eu-west-1a)."
  default = {
    az1 = "eu-west-1c"
    az2 = "eu-west-1a"
  }
}

# ──────────── DB Variables ────────────────────────

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

variable "db_iam_user" {
  type        = string
  description = "PostgreSQL username granted rds_iam for IAM database authentication."
  default     = "breadsheet_iam"
}

# ── GCP Workload Identity Federation (keyless Vision / Vertex AI) ──────────────
# Lets AWS ECS authenticate to Google Cloud

variable "enable_google_wif" {
  type        = bool
  description = "Provision GCP Workload Identity Federation so the server pod can call Cloud Vision / Vertex AI keylessly."
  default     = true
}

variable "gcp_project" {
  type        = string
  description = "GCP project ID hosting Vision/Vertex AI. Required when enable_google_wif is true."
  default     = ""
}

variable "gcp_location" {
  type        = string
  description = "GCP location for Vertex AI (e.g. europe-west1). Maps to GOOGLE_CLOUD_LOCATION."
  default     = "europe-west1"
}

variable "gcp_wif_pool_id" {
  type        = string
  description = "Workload Identity Pool ID for Fargate."
  default     = "breadsheet-dev"
}