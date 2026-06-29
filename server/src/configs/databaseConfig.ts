import fs from 'node:fs';

/**
 * TLS configuration for the runtime `pg` connection pool used by the Prisma
 * driver adapter (see `src/db.ts`).
 *
 * Why this exists: the app connects through `@prisma/adapter-pg` (a `pg.Pool`),
 * which is a *different* TLS stack from the Prisma migration engine. `pg` >= 8.22
 * treats `sslmode=require` in the URL as `verify-full`, which validates the server
 * certificate against Node's default trust store. The AWS RDS CA is **not** in that
 * store, so the handshake is aborted client-side and RDS logs
 * `could not accept SSL connection: EOF detected`. Migrations still succeed because
 * Prisma's engine treats `require` as encrypt-only — which is exactly why the bug
 * is invisible at boot and only bites the first real query.
 *
 * The fix is to configure TLS explicitly here against the shipped RDS CA bundle,
 * and to strip `sslmode` from the URL so `pg-connection-string` neither emits its
 * deprecation warning nor double-configures TLS.
 */
export interface DatabaseConnectionConfig {
  connectionString: string;
  ssl: false | { ca: string; rejectUnauthorized: true };
}

const VALID_DB_SSL_MODES = ['disabled', 'verify-full'] as const;
type DbSslMode = (typeof VALID_DB_SSL_MODES)[number];

// Where the Docker image stores the AWS RDS global CA bundle (see Dockerfile).
// Overridable for local/dev experimentation, but not a runtime-behaviour switch.
const DEFAULT_RDS_CA_BUNDLE_PATH = '/usr/src/app/certs/rds-global-bundle.pem';

/**
 * Build the `connectionString` + `ssl` options for the `pg.Pool`. Pure and
 * dependency-injectable so it can be unit-tested without a real filesystem.
 *
 * Fails fast (CLAUDE.md convention): `DATABASE_URL` and `DB_SSL` are required, and
 * `DB_SSL` must be in the allowlist — no silent default.
 */
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

  // Local Postgres (docker-compose) speaks no TLS — connect plaintext.
  if (mode === 'disabled') {
    return { connectionString: rawUrl, ssl: false };
  }

  // verify-full: drop `sslmode` from the URL (we own TLS here, not the URL) and
  // verify the RDS server cert against the shipped CA bundle.
  const caPath = env.RDS_CA_BUNDLE_PATH || DEFAULT_RDS_CA_BUNDLE_PATH;
  const ca = readCaBundle(caPath);
  return {
    connectionString: stripSslMode(rawUrl),
    ssl: { ca, rejectUnauthorized: true },
  };
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