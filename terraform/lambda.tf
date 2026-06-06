# ── IAM ──────────────────────────────────────────────────────────────────────

resource "aws_iam_role" "image_resizer" {
  name = "image-resizer-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "image_resizer_s3" {
  name = "image-resizer-s3"
  role = aws_iam_role.image_resizer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "${aws_s3_bucket.images.arn}/*"
    }]
  })
}

resource "aws_iam_role_policy" "image_resizer_sqs" {
  name = "image-resizer-sqs"
  role = aws_iam_role.image_resizer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.image_resizer_dlq.arn
    }]
  })
}

# ── Lambda source archive ─────────────────────────────────────────────────────
# Run `npm run build` inside server/lambda/imageResizer/ before `terraform apply`.
# The build script writes the compiled JS + sharp native binary to dist/bundle/.

data "archive_file" "image_resizer" {
  type        = "zip"
  source_dir  = "${path.module}/../server/lambda/imageResizer/dist/bundle"
  output_path = "${path.module}/../server/lambda/imageResizer/dist/imageResizer.zip"
}

# ── Lambda function ───────────────────────────────────────────────────────────

resource "aws_lambda_function" "image_resizer" {
  function_name    = "image-resizer"
  role             = aws_iam_role.image_resizer.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 512

  filename         = data.archive_file.image_resizer.output_path
  source_code_hash = data.archive_file.image_resizer.output_base64sha256

  dead_letter_config {
    target_arn = aws_sqs_queue.image_resizer_dlq.arn
  }
}

resource "aws_lambda_permission" "allow_s3_invoke" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.image_resizer.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.images.arn
}

# ── S3 notification → Lambda trigger ─────────────────────────────────────────

resource "aws_s3_bucket_notification" "image_uploads" {
  bucket = aws_s3_bucket.images.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.image_resizer.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "raw/"
  }

  depends_on = [aws_lambda_permission.allow_s3_invoke]
}

# ── Dead-letter queue ─────────────────────────────────────────────────────────

resource "aws_sqs_queue" "image_resizer_dlq" {
  name                      = "image-resizer-dlq"
  message_retention_seconds = 1209600 # 14 days
}