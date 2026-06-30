terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.39"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Only used by the GCP WIF resources (gcp-wif.tf)
provider "google" {
  project = var.gcp_project
  region  = var.gcp_location
}