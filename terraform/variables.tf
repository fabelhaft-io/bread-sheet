variable "environment" {
  type        = string
  description = "Deployment environment."
  validation {
    condition     = contains(["local", "production"], var.environment)
    error_message = "environment must be 'local' or 'production'."
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