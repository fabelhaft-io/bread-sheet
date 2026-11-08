import { describe, it, expect, afterEach, vi } from 'vitest';

// config.ts validates at import time, so every case re-imports a fresh copy.
// Values are blanked with '' rather than deleted: dotenv.config() never
// overwrites an existing key, but it *would* refill a deleted one from a local
// server/.env and make the "missing" cases pass or fail by machine.
async function loadConfig() {
  vi.resetModules();
  return (await import('./config.js')).default;
}

const ORIGINAL = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_PUBLISHABLE_DEFAULT_KEY: process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY,
};

afterEach(() => {
  process.env.SUPABASE_URL = ORIGINAL.SUPABASE_URL;
  process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY = ORIGINAL.SUPABASE_PUBLISHABLE_DEFAULT_KEY;
  vi.resetModules();
});

describe('config: Supabase (TICKET-P9-010)', () => {
  it('exposes SUPABASE_URL and SUPABASE_PUBLISHABLE_DEFAULT_KEY', async () => {
    process.env.SUPABASE_URL = 'https://abc.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY = 'sb_publishable_abc';

    const config = await loadConfig();

    expect(config.supabaseUrl).toBe('https://abc.supabase.co');
    expect(config.supabasePublishableKey).toBe('sb_publishable_abc');
  });

  it('refuses to start without SUPABASE_URL, naming the variable', async () => {
    process.env.SUPABASE_URL = '';
    await expect(loadConfig()).rejects.toThrow(
      'Missing required environment variable: SUPABASE_URL',
    );
  });

  it('rejects a SUPABASE_URL that is not an http(s) URL', async () => {
    process.env.SUPABASE_URL = 'abc.supabase.co';
    await expect(loadConfig()).rejects.toThrow('Invalid SUPABASE_URL "abc.supabase.co"');
  });

  it('refuses to start without SUPABASE_PUBLISHABLE_DEFAULT_KEY, naming the variable', async () => {
    process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY = '';
    await expect(loadConfig()).rejects.toThrow(
      'Missing required environment variable: SUPABASE_PUBLISHABLE_DEFAULT_KEY',
    );
  });
});
