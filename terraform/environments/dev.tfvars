# `dev` cloud environment — full stack on real AWS (VPC + EKS + RDS + ECR + S3).
# Apply: terraform init -backend-config=environments/dev.s3.tfbackend
#        terraform apply -var-file=environments/dev.tfvars
environment         = "dev"
aws_region          = "us-east-1"
localstack_endpoint = "" # empty => real AWS (cloud resources are created)
s3_bucket_name      = "breadsheet-images-dev"

# Cheap dev sizing (defaults already lean this way; listed for visibility).
single_nat_gateway  = true
node_instance_types = ["t3.small"]
node_desired_size   = 2
db_instance_class   = "db.t4g.micro"
db_multi_az         = false