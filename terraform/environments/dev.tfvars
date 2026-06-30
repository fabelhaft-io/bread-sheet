# `dev` cloud environment — full stack on real AWS (VPC + Fargate + RDS + S3; image on GHCR).
# Apply: terraform init -backend-config=environments/dev.s3.tfbackend
#        terraform apply -var-file=environments/dev.tfvars
environment         = "dev"
aws_region          = "eu-west-1"
s3_bucket_name      = "breadsheet-dev-s3-493942067033-eu-west-1-an"
vpc_cidr            = "10.0.0.0/16"

db_instance_class   = "db.t4g.micro"
db_multi_az         = false

# Live Google Cloud (keyless via AWS-provider Workload Identity Federation)
enable_google_wif = true
gcp_project       = "breadsheet-496522"
gcp_location      = "europe-west1"
gcp_wif_pool_id   = "breadsheet-dev"