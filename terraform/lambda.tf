# ──────────── Image Resizer Lambda ────────────────────────────────────────────
#
# Resizes uploaded images from raw/{kind}/{uuid}.jpg → processed/{uuid}.jpg.
# Triggered by S3 ObjectCreated events on the raw/ prefix.
#
# Build the bundle before applying:
#   cd server/lambda/imageResizer && npm install && npm run build

data "archive_file" "image_resizer" {
  type        = "zip"
  source_dir  = "${path.module}/../server/lambda/imageResizer/dist/bundle"
  output_path = "${path.module}/../server/lambda/imageResizer/dist/imageResizer.zip"
}

# ──────────── Lambda Execution Role ──────────────────────────────────────────

resource "aws_iam_role" "lambda_image_resizer" {
  name = "${local.name_prefix}-lambda-image-resizer"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(local.tags, { Name = "${local.name_prefix}-lambda-image-resizer" })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_image_resizer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_s3" {
  name = "ImageResizerS3Access"
  role = aws_iam_role.lambda_image_resizer.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadRaw"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.images.arn}/raw/*"
      },
      {
        Sid      = "WriteProcessed"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.images.arn}/processed/*"
      },
    ]
  })
}

# ──────────── Lambda Function ────────────────────────────────────────────────

resource "aws_lambda_function" "image_resizer" {
  function_name = "${local.name_prefix}-image-resizer"
  role          = aws_iam_role.lambda_image_resizer.arn
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30
  memory_size   = 512

  filename         = data.archive_file.image_resizer.output_path
  source_code_hash = data.archive_file.image_resizer.output_base64sha256

  architectures = ["x86_64"]

  tags = merge(local.tags, { Name = "${local.name_prefix}-image-resizer" })
}

# ──────────── S3 → Lambda Trigger ────────────────────────────────────────────

resource "aws_lambda_permission" "s3_invoke" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.image_resizer.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.images.arn
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_s3_bucket_notification" "raw_upload" {
  bucket = aws_s3_bucket.images.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.image_resizer.arn
    events             = ["s3:ObjectCreated:*"]
    filter_prefix      = "raw/"
  }

  depends_on = [aws_lambda_permission.s3_invoke]
}
