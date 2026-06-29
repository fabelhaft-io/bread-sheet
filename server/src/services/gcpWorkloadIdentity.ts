import {
  AwsClient,
  type AwsSecurityCredentials,
  type AwsSecurityCredentialsSupplier,
} from 'google-auth-library';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

/**
 * Shared GCP Workload Identity Federation client.
 *
 * Lets the Fargate task authenticate to Google Cloud (Vertex AI / Cloud Vision) by impersonating a
 * GCP service account using its **AWS task-role identity** — no service-account key is ever created.
 *
 * Why a programmatic AWS credential supplier instead of the stock `--aws` credential-config: that
 * config fetches AWS credentials from EC2 IMDS (169.254.169.254), which does **not** serve task-role
 * credentials on Fargate — those come from the ECS container credentials endpoint
 * (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`). The AWS SDK's default provider chain reads that
 * endpoint, so we hand its credentials to google-auth via the supplier below.
 *
 * Returns `null` when WIF is not configured (local dev), so callers fall back to default ADC
 * (e.g. `gcloud auth application-default login`). Configuration is all-or-nothing: set BOTH
 * `GCP_WORKLOAD_IDENTITY_AUDIENCE` and `GCP_SERVICE_ACCOUNT_EMAIL`, or neither.
 */

// Created once; the AWS SDK provider caches + refreshes the container-endpoint credentials itself.
const awsCredentialProvider = defaultProvider();

const awsSecurityCredentialsSupplier: AwsSecurityCredentialsSupplier = {
  async getAwsRegion(): Promise<string> {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error(
        'AWS_REGION (or AWS_DEFAULT_REGION) is required for GCP Workload Identity Federation.',
      );
    }
    return region;
  },
  async getAwsSecurityCredentials(): Promise<AwsSecurityCredentials> {
    const creds = await awsCredentialProvider();
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      token: creds.sessionToken,
    };
  },
};

let resolved = false;
let client: AwsClient | null = null;

export function getGcpWorkloadIdentityClient(): AwsClient | null {
  if (resolved) return client;
  resolved = true;

  const audience = process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE;
  const serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

  if (!audience && !serviceAccountEmail) {
    client = null; // not configured → callers fall back to default ADC (local dev)
    return client;
  }
  if (!audience || !serviceAccountEmail) {
    throw new Error(
      'GCP Workload Identity is partially configured — set BOTH ' +
        'GCP_WORKLOAD_IDENTITY_AUDIENCE and GCP_SERVICE_ACCOUNT_EMAIL (or neither).',
    );
  }

  client = new AwsClient({
    audience,
    subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    aws_security_credentials_supplier: awsSecurityCredentialsSupplier,
  });
  return client;
}

/** Test seam — resets the memoised client between tests. */
export function __resetGcpWorkloadIdentityClient(): void {
  resolved = false;
  client = null;
}