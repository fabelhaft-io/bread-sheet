# ──────────── SSM Parameters ──────────────────────────────────────────────────

resource "aws_ssm_parameter" "database_url" {
  name        = "/breadsheet/dev/DATABASE_URL"
  description = "url for development database"
  type        = "SecureString"
  value       = "placeholder"

  tags = merge(local.tags, { Name = "/breadsheet/dev/DATABASE_URL" })

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "supabase_url" {
  name        = "/breadsheet/dev/SUPABASE_URL"
  description = "supabase link to the dev stage"
  type        = "String"
  value       = "placeholder"

  tags = merge(local.tags, {
    Name     = "/breadsheet/dev/SUPABASE_URL"
    Resource = "Supabase"
  })

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "supabase_key" {
  name        = "/breadsheet/dev/SUPABASE_PUBLISHABLE_DEFAULT_KEY"
  description = "The supabase project public key"
  type        = "String"
  value       = "placeholder"

  tags = merge(local.tags, {
    Name     = "/breadsheet/dev/SUPABASE_PUBLISHABLE_DEFAULT_KEY"
    Resource = "Supabase"
  })

  lifecycle {
    ignore_changes = [value]
  }
}