terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.39"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 8.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Cost Explorer / Cost Anomaly Detection is only reachable through the us-east-1
# API endpoint regardless of which region the monitored resources run in — see
# detection.tf (ADR 0005 D).
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}

# Only used by the GCP WIF resources (gcp-wif.tf) and the billing budget
# (detection.tf). `user_project_override` + `billing_project`: local ADC has no
# quota project set by default, and billingbudgets.googleapis.com (unlike the
# WIF-related APIs used so far) requires one — without this, calls are billed
# against whatever project the ADC happened to default to, not this one.
provider "google" {
  project = var.gcp_project
  region  = var.gcp_location

  billing_project       = var.gcp_project
  user_project_override = true
}