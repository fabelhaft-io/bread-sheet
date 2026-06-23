# Container registry for the server image. Real-AWS only.
# CI builds `server/Dockerfile` and pushes to this repo tagged with the Git SHA;
# the k8s Deployment references <repository_url>:<sha>.
resource "aws_ecr_repository" "server" {
  count = local.cloud_count

  name                 = "${local.name_prefix}-server"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

# Keep only the most recent images to bound storage cost.
resource "aws_ecr_lifecycle_policy" "server" {
  count = local.cloud_count

  repository = aws_ecr_repository.server[0].name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images beyond the last 10"
      selection = {
        tagStatus   = "untagged"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}