import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const awsClientSpy = vi.hoisted(() => vi.fn());

vi.mock('google-auth-library', () => {
  class AwsClient {
    options: unknown;
    constructor(opts: unknown) {
      awsClientSpy(opts);
      this.options = opts;
    }
  }
  return { AwsClient };
});

// The AWS SDK provider chain is stubbed to return fixed task-role credentials.
vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => async () => ({
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret',
    sessionToken: 'session-token',
  }),
}));

const WIF_ENV = ['GCP_WORKLOAD_IDENTITY_AUDIENCE', 'GCP_SERVICE_ACCOUNT_EMAIL', 'AWS_REGION'];

function clearEnv() {
  for (const key of WIF_ENV) delete process.env[key];
}

const AUDIENCE =
  '//iam.googleapis.com/projects/1054240616692/locations/global/workloadIdentityPools/breadsheet-dev/providers/aws-ecs';
const SA_EMAIL = 'breadsheet-dev-vision@breadsheet-496522.iam.gserviceaccount.com';

describe('getGcpWorkloadIdentityClient', () => {
  beforeEach(() => {
    awsClientSpy.mockReset();
    vi.resetModules();
    clearEnv();
  });

  afterEach(clearEnv);

  it('returns null when WIF is not configured (local dev → default ADC)', async () => {
    const { getGcpWorkloadIdentityClient } = await import('./gcpWorkloadIdentity.js');

    expect(getGcpWorkloadIdentityClient()).toBeNull();
    expect(awsClientSpy).not.toHaveBeenCalled();
  });

  it('throws when only one of the two WIF variables is set', async () => {
    process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE = AUDIENCE;
    const { getGcpWorkloadIdentityClient } = await import('./gcpWorkloadIdentity.js');

    expect(() => getGcpWorkloadIdentityClient()).toThrow(/set BOTH/);
    expect(awsClientSpy).not.toHaveBeenCalled();
  });

  it('builds an AwsClient with the federation + impersonation config when fully configured', async () => {
    process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE = AUDIENCE;
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = SA_EMAIL;
    const { getGcpWorkloadIdentityClient } = await import('./gcpWorkloadIdentity.js');

    const client = getGcpWorkloadIdentityClient();

    expect(client).not.toBeNull();
    expect(awsClientSpy).toHaveBeenCalledTimes(1);
    const opts = awsClientSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.audience).toBe(AUDIENCE);
    expect(opts.subject_token_type).toBe('urn:ietf:params:aws:token-type:aws4_request');
    expect(opts.token_url).toBe('https://sts.googleapis.com/v1/token');
    expect(opts.service_account_impersonation_url).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`,
    );
    expect(opts.aws_security_credentials_supplier).toBeDefined();
  });

  it('the supplier maps AWS SDK creds (sessionToken → token) and reads the region', async () => {
    process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE = AUDIENCE;
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = SA_EMAIL;
    process.env.AWS_REGION = 'eu-west-1';
    const { getGcpWorkloadIdentityClient } = await import('./gcpWorkloadIdentity.js');

    getGcpWorkloadIdentityClient();
    const opts = awsClientSpy.mock.calls[0][0] as {
      aws_security_credentials_supplier: {
        getAwsRegion: (ctx: unknown) => Promise<string>;
        getAwsSecurityCredentials: (ctx: unknown) => Promise<unknown>;
      };
    };
    const supplier = opts.aws_security_credentials_supplier;

    await expect(supplier.getAwsRegion({})).resolves.toBe('eu-west-1');
    await expect(supplier.getAwsSecurityCredentials({})).resolves.toEqual({
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      token: 'session-token',
    });
  });

  it('the supplier throws if no AWS region is available', async () => {
    process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE = AUDIENCE;
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = SA_EMAIL;
    const { getGcpWorkloadIdentityClient } = await import('./gcpWorkloadIdentity.js');

    getGcpWorkloadIdentityClient();
    const opts = awsClientSpy.mock.calls[0][0] as {
      aws_security_credentials_supplier: { getAwsRegion: (ctx: unknown) => Promise<string> };
    };

    await expect(opts.aws_security_credentials_supplier.getAwsRegion({})).rejects.toThrow(
      /AWS_REGION/,
    );
  });

  it('memoises the client across calls', async () => {
    process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE = AUDIENCE;
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = SA_EMAIL;
    const { getGcpWorkloadIdentityClient } = await import('./gcpWorkloadIdentity.js');

    const a = getGcpWorkloadIdentityClient();
    const b = getGcpWorkloadIdentityClient();

    expect(a).toBe(b);
    expect(awsClientSpy).toHaveBeenCalledTimes(1);
  });
});