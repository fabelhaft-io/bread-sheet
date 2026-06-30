import { describe, it, expect, vi } from 'vitest';
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
    const cfg = buildDatabaseConfig(
      {
        DATABASE_URL: IAM_URL,
        DB_SSL: 'verify-full',
        DB_AUTH: 'iam',
        AWS_REGION: 'eu-west-1',
      },
      () => 'ca',
    );
    expect(cfg.password).toBeTypeOf('function');
    const token = await cfg.password!();
    expect(token).toBe('mock-iam-token');
  });

  it('iam: does not include password in connectionString', () => {
    const cfg = buildDatabaseConfig(
      {
        DATABASE_URL: IAM_URL,
        DB_SSL: 'verify-full',
        DB_AUTH: 'iam',
        AWS_REGION: 'eu-west-1',
      },
      () => 'ca',
    );
    expect(cfg.connectionString).not.toContain('password');
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
  it('extracts hostname, port, and username', () => {
    const result = parseDatabaseUrl(
      'postgresql://breadsheet_iam@myhost.rds.amazonaws.com:5432/breadsheet',
    );
    expect(result).toEqual({
      hostname: 'myhost.rds.amazonaws.com',
      port: 5432,
      username: 'breadsheet_iam',
    });
  });

  it('handles URL with password present', () => {
    const result = parseDatabaseUrl(
      'postgresql://user:pass@host.example.com:5433/db',
    );
    expect(result).toEqual({ hostname: 'host.example.com', port: 5433, username: 'user' });
  });

  it('throws on malformed URL', () => {
    expect(() => parseDatabaseUrl('not-a-url')).toThrow(/Cannot parse DATABASE_URL/);
  });
});