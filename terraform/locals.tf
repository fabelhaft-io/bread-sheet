locals {
  name_prefix = "breadsheet-${var.environment}"

  tags = {
    Project   = "breadsheet"
    Stage     = var.environment
    ManagedBy = "terraform"
  }
}