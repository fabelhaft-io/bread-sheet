# `dev` cloud environment — full stack on real AWS (VPC + EKS + RDS + S3; image on GHCR).
# Apply: terraform init -backend-config=environments/dev.s3.tfbackend
#        terraform apply -var-file=environments/dev.tfvars
environment         = "dev"
aws_region          = "us-east-1"
localstack_endpoint = "" # empty => real AWS (cloud resources are created)
s3_bucket_name      = "breadsheet-images-dev"

# Firewall: restrict the public EKS API endpoint to your IP. Find it with
#   curl -s ifconfig.me
# then set e.g. allowed_cidrs = ["203.0.113.7/32"]. Left open by default.
allowed_cidrs = ["0.0.0.0/0"]

# Cheap dev sizing (defaults already lean this way; listed for visibility).
single_nat_gateway  = true
node_instance_types = ["t3.small"]
node_desired_size   = 2
db_instance_class   = "db.t4g.micro"
db_multi_az         = false

# Live Google Cloud (keyless via Workload Identity Federation). Set your project.
enable_google_wif = true
gcp_project       = "REPLACE_GCP_PROJECT_ID"
gcp_location      = "europe-west1"