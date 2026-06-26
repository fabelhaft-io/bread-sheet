terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.39"
    }
    # Transitive requirements of terraform-aws-modules/{vpc,eks,rds} and the
    # random_password used for the RDS master credential.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    cloudinit = {
      source  = "hashicorp/cloudinit"
      version = "~> 2.3"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    # GCP Workload Identity Federation for keyless Vision/Vertex auth (gcp-wif.tf).
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
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

# Only used by the GCP WIF resources (gcp-wif.tf), which are created for real-AWS
# cloud environments. project/region are empty for the local environment, where
# no google resources are instantiated, so the provider is never invoked.
provider "google" {
  project = var.gcp_project
  region  = var.gcp_location
}