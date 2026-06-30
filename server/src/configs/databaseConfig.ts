import fs from 'node:fs';
import { Signer } from '@aws-sdk/rds-signer';

export interface DatabaseConnectionConfig {
  connectionString: string;
  ssl: false | { ca: string; rejectUnauthorized: true };
  password?: () => Promise<string>;
}

const VALID_DB_SSL_MODES = ['disabled', 'verify-full'] as const;
type DbSslMode = (typeof VALID_DB_SSL_MODES)[number];

const VALID_DB_AUTH_MODES = ['password', 'iam'] as const;
type DbAuthMode = (typeof VALID_DB_AUTH_MODES)[number];

const DEFAULT_RDS_CA_BUNDLE_PATH = '/usr/src/app/certs/rds-global-bundle.pem';

export function buildDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  readCaBundle: (path: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): DatabaseConnectionConfig {
  const rawUrl = env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error('Missing required environment variable: DATABASE_URL');
  }

  const mode = env.DB_SSL;
  if (!mode) {
    throw new Error(
      'Missing required environment variable: DB_SSL. Valid values: disabled | verify-full',
    );
  }
  if (!VALID_DB_SSL_MODES.includes(mode as DbSslMode)) {
    throw new Error(
      `Invalid DB_SSL "${mode}". Must be one of: ${VALID_DB_SSL_MODES.join(' | ')}`,
    );
  }

  const authMode = env.DB_AUTH ?? 'password';
  if (!VALID_DB_AUTH_MODES.includes(authMode as DbAuthMode)) {
    throw new Error(
      `Invalid DB_AUTH "${authMode}". Must be one of: ${VALID_DB_AUTH_MODES.join(' | ')}`,
    );
  }

  if (authMode === 'iam' && mode !== 'verify-full') {
    throw new Error('DB_AUTH=iam requires DB_SSL=verify-full (RDS IAM auth mandates TLS)');
  }

  if (mode === 'disabled') {
    return { connectionString: rawUrl, ssl: false };
  }

  const caPath = env.RDS_CA_BUNDLE_PATH || DEFAULT_RDS_CA_BUNDLE_PATH;
  const ca = readCaBundle(caPath);
  const connectionString = stripSslMode(rawUrl);
  const ssl = { ca, rejectUnauthorized: true } as const;

  if (authMode === 'iam') {
    const { hostname, port, username } = parseDatabaseUrl(connectionString);
    const region = env.AWS_REGION;
    if (!region) {
      throw new Error('DB_AUTH=iam requires AWS_REGION');
    }
    const signer = new Signer({ hostname, port, username, region });
    return {
      connectionString,
      ssl,
      password: () => signer.getAuthToken(),
    };
  }

  return { connectionString, ssl };
}

/**
 * Remove the `sslmode` query param without re-parsing the URL. We deliberately
 * avoid `new URL()` here: it would round-trip the userinfo and could normalise an
 * exotic RDS password differently from the working string. So we touch only the
 * query portion, leaving everything before `?` byte-for-byte intact.
 */
function stripSslMode(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return rawUrl;
  const base = rawUrl.slice(0, qIdx);
  const params = rawUrl
    .slice(qIdx + 1)
    .split('&')
    .filter((p) => p.length > 0 && !/^sslmode=/i.test(p));
  return params.length > 0 ? `${base}?${params.join('&')}` : base;
}

export function parseDatabaseUrl(url: string): {
  hostname: string;
  port: number;
  username: string;
} {
  const match = url.match(/^postgresql:\/\/([^:@]+)(?::[^@]*)?@([^/:]+):(\d+)\//);
  if (!match) {
    throw new Error(
      'Cannot parse DATABASE_URL for IAM auth. Expected: postgresql://user@host:port/db',
    );
  }
  return { username: match[1], hostname: match[2], port: Number(match[3]) };
}