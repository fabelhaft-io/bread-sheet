# ──────────── GCP Workload Identity Federation ────────────────────────────────
# Keyless auth from the Fargate task to Google Cloud (Vertex AI / Gemini for
# VISION_MODE=llm + PLAUSIBILITY_MODE=gemini). The ECS task role is the federation
# source — GCP trusts an AWS STS GetCallerIdentity signed with the task role's creds.

resource "google_iam_workload_identity_pool" "aws" {
  count = var.enable_google_wif ? 1 : 0

  project                   = var.gcp_project
  workload_identity_pool_id = var.gcp_wif_pool_id
  display_name              = "BreadSheet Dev Stage"
  description               = "Federates AWS (Fargate task role) into GCP for dev."
}

resource "google_iam_workload_identity_pool_provider" "aws_ecs" {
  count = var.enable_google_wif ? 1 : 0

  project                            = var.gcp_project
  workload_identity_pool_id          = google_iam_workload_identity_pool.aws[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "aws-ecs"

  attribute_mapping = {
    "google.subject"     = "assertion.arn"
    "attribute.aws_role" = "assertion.arn.contains('assumed-role') ? assertion.arn.extract('{account_arn}assumed-role/') + 'assumed-role/' + assertion.arn.extract('assumed-role/{role_name}/') : assertion.arn"
  }

  attribute_condition = "assertion.arn.startsWith('arn:aws:sts::493942067033:assumed-role/breadsheet-dev-ecs-task/')"

  aws {
    account_id = "493942067033"
  }
}

# ──────────── Service Account ─────────────────────────────────────────────────

resource "google_service_account" "vision" {
  count = var.enable_google_wif ? 1 : 0

  project      = var.gcp_project
  account_id   = "breadsheet-${var.environment}-vision"
  display_name = "BreadSheet Dev Server (Vision/Vertex)"
}

resource "google_project_iam_member" "vision_aiplatform" {
  count = var.enable_google_wif ? 1 : 0

  project = var.gcp_project
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.vision[0].email}"
}

# ──────────── Impersonation Binding ───────────────────────────────────────────
# Only the Fargate task role can impersonate this SA (scoped by principalSet).

resource "google_service_account_iam_member" "wif" {
  count = var.enable_google_wif ? 1 : 0

  service_account_id = google_service_account.vision[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/1054240616692/locations/global/workloadIdentityPools/${var.gcp_wif_pool_id}/attribute.aws_role/arn:aws:sts::493942067033:assumed-role/breadsheet-dev-ecs-task"
}