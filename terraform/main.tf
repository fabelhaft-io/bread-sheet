terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.39"
    }
  }
}

locals {
  is_local = var.localstack_endpoint != ""
}

provider "aws" {
  region = var.aws_region

  access_key = local.is_local ? "test" : null
  secret_key = local.is_local ? "test" : null

  skip_credentials_validation = local.is_local
  skip_metadata_api_check     = local.is_local
  skip_requesting_account_id  = local.is_local
  s3_use_path_style           = local.is_local

  endpoints {
    s3     = var.localstack_endpoint
    lambda = var.localstack_endpoint
    iam    = var.localstack_endpoint
    sts    = var.localstack_endpoint
    sqs    = var.localstack_endpoint
  }
}