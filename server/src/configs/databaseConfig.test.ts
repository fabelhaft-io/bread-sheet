import { describe, it, expect, vi } from 'vitest';
import ConnectionParameters from 'pg/lib/connection-parameters';
import { buildDatabaseConfig, parseDatabaseUrl } from './databaseConfig.js';

vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: class {
    getAuthToken() {
      return Promise.resolve('mock-iam-token');
    }
  },
}));

const BASE_URL = 'postgresql://admin:password@host.rds.amazonaws.com:5432/breadsheet';
const IAM_URL = 'postgresql://breadsheet_iam@host.rds.amazonaws.com:5432/breadsheet';

const IAM_ENV = {
  DATABASE_URL: IAM_URL,
  DB_SSL: 'verify-full',
  DB_AUTH: 'iam',
  AWS_REGION: 'eu-west-1',
};

describe('buildDatabaseConfig', () => {
  it('throws when DATABASE_URL is missing', () => {
    expect(() => buildDatabaseConfig({ DB_SSL: 'disabled' })).toThrow(/DATABASE_URL/);
  });

  it('throws when DB_SSL is missing (no silent default)', () => {
    expect(() => buildDatabaseConfig({ DATABASE_URL: BASE_URL })).toThrow(/DB_SSL/);
  });

  it('throws when DB_SSL is not in the allowlist', () => {
    expect(() =>
      buildDatabaseConfig({ DATABASE_URL: BASE_URL, DB_SSL: 'require' }),
    ).toThrow(/Invalid DB_SSL "require"/);
  });

  it('throws when DB_AUTH is not in the allowlist', () => {
    expect(() =>
      buildDatabaseConfig({ DATABASE_URL: BASE_URL, DB_SSL: 'verify-full', DB_AUTH: 'bogus' }),
    ).toThrow(/Invalid DB_AUTH "bogus"/);
  });

  it('disabled: passes the URL through and disables TLS', () => {
    const cfg = buildDatabaseConfig({ DATABASE_URL: BASE_URL, DB_SSL: 'disabled' });
    expect(cfg.connectionString).toBe(BASE_URL);
    expect(cfg.ssl).toBe(false);
    expect(cfg.password).toBeUndefined();
  });

  it('disabled: never reads the CA bundle', () => {
    const readCa = vi.fn();
    buildDatabaseConfig({ DATABASE_URL: BASE_URL, DB_SSL: 'disabled' }, readCa);
    expect(readCa).not.toHaveBeenCalled();
  });

  it('verify-full: strips sslmode from the URL and verifies against the CA bundle', () => {
    const readCa = vi.fn().mockReturnValue('-----BEGIN CERTIFICATE-----\n...');
    const cfg = buildDatabaseConfig(
      { DATABASE_URL: `${BASE_URL}?sslmode=require`, DB_SSL: 'verify-full' },
      readCa,
    );
    expect(cfg.connectionString).toBe(BASE_URL);
    expect(cfg.connectionString).not.toContain('sslmode');
    expect(cfg.ssl).toEqual({ ca: '-----BEGIN CERTIFICATE-----\n...', rejectUnauthorized: true });
    expect(cfg.password).toBeUndefined();
  });

  it('verify-full: preserves other query params while dropping sslmode', () => {
    const cfg = buildDatabaseConfig(
      {
        DATABASE_URL: `${BASE_URL}?sslmode=require&connection_limit=5`,
        DB_SSL: 'verify-full',
      },
      () => 'ca',
    );
    expect(cfg.connectionString).toContain('connection_limit=5');
    expect(cfg.connectionString).not.toContain('sslmode');
  });

  it('verify-full: reads the bundle from RDS_CA_BUNDLE_PATH when set', () => {
    const readCa = vi.fn().mockReturnValue('ca');
    buildDatabaseConfig(
      { DATABASE_URL: BASE_URL, DB_SSL: 'verify-full', RDS_CA_BUNDLE_PATH: '/custom/ca.pem' },
      readCa,
    );
    expect(readCa).toHaveBeenCalledWith('/custom/ca.pem');
  });

  it('iam: throws when DB_SSL is not verify-full', () => {
    expect(() =>
      buildDatabaseConfig({ DATABASE_URL: IAM_URL, DB_SSL: 'disabled', DB_AUTH: 'iam' }),
    ).toThrow(/DB_AUTH=iam requires DB_SSL=verify-full/);
  });

  it('iam: throws when AWS_REGION is missing', () => {
    expect(() =>
      buildDatabaseConfig(
        { DATABASE_URL: IAM_URL, DB_SSL: 'verify-full', DB_AUTH: 'iam' },
        () => 'ca',
      ),
    ).toThrow(/DB_AUTH=iam requires AWS_REGION/);
  });

  it('iam: returns an async password callback', async () => {
    const cfg = buildDatabaseConfig(IAM_ENV, () => 'ca');
    expect(cfg.password).toBeTypeOf('function');
    const token = await cfg.password!();
    expect(token).toBe('mock-iam-token');
  });

  it('iam: returns discrete fields and NO connectionString', () => {
    const cfg = buildDatabaseConfig(IAM_ENV, () => 'ca');
    expect(cfg.connectionString).toBeUndefined();
    expect(cfg).toMatchObject({
      host: 'host.rds.amazonaws.com',
      port: 5432,
      user: 'breadsheet_iam',
      database: 'breadsheet',
    });
  });

  it('iam: discards a stale token baked into DATABASE_URL by the migration step', () => {
    // scripts/start.sh mints a 15-minute token for `prisma migrate deploy`. If that
    // URL ever reaches the runtime, it must not become the connection password —
    // it is already half-expired and cannot be refreshed.
    const cfg = buildDatabaseConfig(
      {
        ...IAM_ENV,
        DATABASE_URL:
          'postgresql://breadsheet_iam:stale%2Ftoken%3Dabc@host.rds.amazonaws.com:5432/breadsheet?sslmode=require',
      },
      () => 'ca',
    );
    expect(cfg.connectionString).toBeUndefined();
    expect(cfg.user).toBe('breadsheet_iam');
    expect(cfg.password).toBeTypeOf('function');
  });

  it('iam: rejects query params it cannot carry rather than dropping them silently', () => {
    expect(() =>
      buildDatabaseConfig(
        { ...IAM_ENV, DATABASE_URL: `${IAM_URL}?connection_limit=5` },
        () => 'ca',
      ),
    ).toThrow(/does not support query parameters/);
  });

  it('password mode (default): no password callback', () => {
    const cfg = buildDatabaseConfig(
      { DATABASE_URL: BASE_URL, DB_SSL: 'verify-full' },
      () => 'ca',
    );
    expect(cfg.password).toBeUndefined();
  });
});

describe('parseDatabaseUrl', () => {
  it('extracts hostname, port, username, and database', () => {
    const result = parseDatabaseUrl(
      'postgresql://breadsheet_iam@myhost.rds.amazonaws.com:5432/breadsheet',
    );
    expect(result).toEqual({
      hostname: 'myhost.rds.amazonaws.com',
      port: 5432,
      username: 'breadsheet_iam',
      database: 'breadsheet',
    });
  });

  it('handles URL with password present', () => {
    const result = parseDatabaseUrl('postgresql://user:pass@host.example.com:5433/db');
    expect(result).toEqual({
      hostname: 'host.example.com',
      port: 5433,
      username: 'user',
      database: 'db',
    });
  });

  it('stops the database name at a query string', () => {
    const result = parseDatabaseUrl(
      'postgresql://user:pass@host.example.com:5433/db?sslmode=require',
    );
    expect(result.database).toBe('db');
  });

  it('percent-decodes user and database', () => {
    const result = parseDatabaseUrl('postgresql://my%40user@host.example.com:5432/my%20db');
    expect(result.username).toBe('my@user');
    expect(result.database).toBe('my db');
  });

  it('throws on malformed URL', () => {
    expect(() => parseDatabaseUrl('not-a-url')).toThrow(/Cannot parse DATABASE_URL/);
  });
});

/**
 * Regression guard for the P1010 / "PAM authentication failed" outage.
 *
 * A unit test on buildDatabaseConfig alone cannot catch this: it returned a
 * perfectly good callback, which `pg` then threw away. The assertion has to run
 * through pg's real config merge.
 */
describe('pg config merge: the IAM password callback must survive', () => {
  it('resolves to a function password in pg ConnectionParameters', () => {
    const cfg = buildDatabaseConfig(IAM_ENV, () => 'ca');
    const params = new ConnectionParameters({ ...cfg });
    expect(typeof params.password).toBe('function');
    expect(params.host).toBe('host.rds.amazonaws.com');
    expect(params.user).toBe('breadsheet_iam');
    expect(params.database).toBe('breadsheet');
  });

  it('keeps the CA bundle and certificate verification', () => {
    const cfg = buildDatabaseConfig(IAM_ENV, () => 'CA-BUNDLE');
    const params = new ConnectionParameters({ ...cfg });
    expect(params.ssl).toEqual({ ca: 'CA-BUNDLE', rejectUnauthorized: true });
  });

  it('documents the trap: a connectionString alongside it destroys the callback', () => {
    // pg merges as `Object.assign({}, config, parse(connectionString))`, and
    // pg-connection-string always emits a `password` key. This is the shape that
    // caused the outage — asserted here so nobody reintroduces it.
    const cfg = buildDatabaseConfig(IAM_ENV, () => 'ca');
    // @types/pg omits `connectionString` from ConnectionParametersConfig, but pg
    // reads it at runtime — which is precisely how this slipped through review.
    const trap = { ...cfg, connectionString: IAM_URL } as ConstructorParameters<
      typeof ConnectionParameters
    >[0];
    const params = new ConnectionParameters(trap);
    expect(typeof params.password).not.toBe('function');
  });
});