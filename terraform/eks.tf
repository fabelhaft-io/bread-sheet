# EKS cluster for the API server. Real-AWS only.
#
# One managed node group, sized small for dev (see node_* variables). IRSA is
# enabled (the module provisions the OIDC provider) so pods assume IAM roles via
# their ServiceAccount instead of using static keys — see irsa.tf.
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  count = local.cloud_count

  # v21 renamed: name (was cluster_name), kubernetes_version (was cluster_version),
  # endpoint_public_access (was cluster_endpoint_public_access).
  name               = local.cluster_name
  kubernetes_version = var.cluster_version

  endpoint_public_access       = true
  endpoint_public_access_cidrs = var.allowed_cidrs

  # Grant the principal running `terraform apply` cluster-admin so kubectl works
  # immediately after provisioning.
  enable_cluster_creator_admin_permissions = true

  vpc_id     = module.vpc[0].vpc_id
  subnet_ids = module.vpc[0].private_subnets

  eks_managed_node_groups = {
    default = {
      instance_types = var.node_instance_types
      capacity_type  = "ON_DEMAND"

      min_size     = var.node_min_size
      max_size     = var.node_max_size
      desired_size = var.node_desired_size
    }
  }

  tags = local.tags
}