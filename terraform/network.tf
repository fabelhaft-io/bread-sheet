# VPC for EKS + RDS. Real-AWS only (count = 0 for the LocalStack environment).
#
# Two AZs, public subnets for the load balancers / NAT, private subnets for the
# EKS nodes and RDS. A single NAT gateway keeps dev cost down (production should
# flip one_nat_gateway_per_az on via tfvars if HA egress is required).
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.6"

  count = local.cloud_count

  name = "${local.name_prefix}-vpc"
  cidr = var.vpc_cidr

  azs             = slice(data.aws_availability_zones.available[0].names, 0, 2)
  public_subnets  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_subnets = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat_gateway
  one_nat_gateway_per_az = !var.single_nat_gateway
  enable_dns_hostnames   = true

  # Subnet tags required by the AWS Load Balancer Controller / in-tree ELB
  # provisioning so a LoadBalancer Service can place ELBs in the right subnets.
  public_subnet_tags = {
    "kubernetes.io/role/elb"                      = "1"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"             = "1"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
  }

  tags = local.tags
}