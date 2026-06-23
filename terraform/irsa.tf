# IRSA role for the server pod. Real-AWS only.
#
# The pod's ServiceAccount (default:bread-sheet-server, annotated in
# terraform/k8s/serviceaccount.yaml) assumes this role via the cluster OIDC
# provider, granting S3 access to the images bucket without static AWS keys.
locals {
  server_service_account = "system:serviceaccount:default:bread-sheet-server"
}

resource "aws_iam_role" "server_irsa" {
  count = local.cloud_count

  name = "${local.name_prefix}-server-irsa"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = module.eks[0].oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${module.eks[0].oidc_provider}:sub" = local.server_service_account
          "${module.eks[0].oidc_provider}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "server_s3" {
  count = local.cloud_count

  name = "${local.name_prefix}-server-s3"
  role = aws_iam_role.server_irsa[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.images.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.images.arn
      }
    ]
  })
}