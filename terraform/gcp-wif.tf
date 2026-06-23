# GCP Workload Identity Federation — keyless auth from the EKS server pod to
# Google Cloud (Cloud Vision for VISION_MODE=live, Vertex AI for
# PLAUSIBILITY_MODE=gemini with GOOGLE_GENAI_USE_VERTEXAI=true).
#
# Flow: the pod projects its Kubernetes ServiceAccount token (audience = this WIF
# provider). GCP's STS trusts the EKS cluster OIDC issuer, exchanges that token
# for a short-lived credential, and impersonates the service account below — which
# holds the Vision/Vertex roles. No service-account key is ever created or stored.
#
# Created only for real-AWS environments with var.enable_google_wif (local.gcp_count).

resource "google_iam_workload_identity_pool" "eks" {
  count = local.gcp_count

  workload_identity_pool_id = var.gcp_wif_pool_id
  display_name              = "EKS ${var.environment}"
  description               = "Federates the bread-sheet EKS ${var.environment} cluster into GCP."
}

resource "google_iam_workload_identity_pool_provider" "eks_oidc" {
  count = local.gcp_count

  workload_identity_pool_id          = google_iam_workload_identity_pool.eks[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "eks-oidc"
  display_name                       = "EKS OIDC"

  # Map the k8s token subject (system:serviceaccount:<ns>:<sa>) to google.subject.
  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }

  oidc {
    issuer_uri = module.eks[0].cluster_oidc_issuer_url
    # No allowed_audiences => GCP accepts the canonical default audience
    # (//iam.googleapis.com/<provider>), which is exactly what
    # `gcloud iam workload-identity-pools create-cred-config` emits. The pod's
    # projected SA token must request that same audience (k8s/deployment.yaml).
  }
}

# Service account the pod impersonates; carries the Vision + Vertex permissions.
resource "google_service_account" "server" {
  count = local.gcp_count

  account_id   = "breadsheet-${var.environment}-vision"
  display_name = "bread-sheet ${var.environment} server (Vision/Vertex)"
}

resource "google_project_iam_member" "vision" {
  count = local.gcp_count

  project = var.gcp_project
  role    = "roles/cloudvision.user"
  member  = "serviceAccount:${google_service_account.server[0].email}"
}

resource "google_project_iam_member" "vertex" {
  count = local.gcp_count

  project = var.gcp_project
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.server[0].email}"
}

# Let the federated EKS ServiceAccount (default:bread-sheet-server) impersonate
# the GCP service account.
resource "google_service_account_iam_member" "wif_impersonation" {
  count = local.gcp_count

  service_account_id = google_service_account.server[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.eks[0].name}/subject/${local.server_service_account}"
}
