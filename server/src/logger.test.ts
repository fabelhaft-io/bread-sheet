import { describe, it, expect, afterEach, vi } from 'vitest';
import winston from 'winston';

// The logger reads env at module load, so each case sets env then imports a
// fresh copy via vi.resetModules() + dynamic import.
async function loadLogger(env: Record<string, string | undefined>) {
  vi.resetModules();
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    const mod = await import('./logger.js');
    return mod.default;
  } finally {
    process.env = prev;
  }
}

describe('logger', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('logs to stdout via a Console transport — never to files (containerised: only stdout is collected)', async () => {
    const logger = await loadLogger({ NODE_ENV: 'production', LOG_LEVEL: undefined });
    expect(logger.transports).toHaveLength(1);
    expect(logger.transports[0]).toBeInstanceOf(winston.transports.Console);
    expect(
      logger.transports.some((t) => t instanceof winston.transports.File),
    ).toBe(false);
  });

  it('honours LOG_LEVEL over the environment default', async () => {
    const logger = await loadLogger({ NODE_ENV: 'production', LOG_LEVEL: 'debug' });
    expect(logger.level).toBe('debug');
  });

  it('falls back to info in production when LOG_LEVEL is unset', async () => {
    const logger = await loadLogger({ NODE_ENV: 'production', LOG_LEVEL: undefined });
    expect(logger.level).toBe('info');
  });
});