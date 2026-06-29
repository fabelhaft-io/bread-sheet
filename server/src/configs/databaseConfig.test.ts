import { describe, it, expect, vi } from 'vitest';
import { buildDatabaseConfig } from './databaseConfig.js';

const BASE_URL = 'postgresql://admin:password@host.rds.amazonaws.com:5432/breadsheet';

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

  it('disabled: passes the URL through and disables TLS', () => {
    const cfg = buildDatabaseConfig({ DATABASE_URL: BASE_URL, DB_SSL: 'disabled' });
    expect(cfg.connectionString).toBe(BASE_URL);
    expect(cfg.ssl).toBe(false);
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
});