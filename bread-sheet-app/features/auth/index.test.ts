import { isValidEmail, signIn, signUp, signOut, signInAsGuest, upgradeAccount } from './index';
import { supabase } from '@/lib/supabase';

const TEST_REDIRECT_URL = 'http://localhost:3000/auth/callback';

beforeAll(() => {
  process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL = TEST_REDIRECT_URL;
});

afterAll(() => {
  delete process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL;
});

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: jest.fn(),
      signInAnonymously: jest.fn(),
      signUp: jest.fn(),
      updateUser: jest.fn(),
      signOut: jest.fn(),
    },
  },
}));

const mockAuth = supabase.auth as jest.Mocked<typeof supabase.auth>;

describe('isValidEmail', () => {
  it('accepts a standard email address', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
  });

  it('accepts email with subdomain and plus-addressing', () => {
    expect(isValidEmail('test.name+tag@mail.domain.co.uk')).toBe(true);
  });

  it('rejects a plain string with no @ or domain', () => {
    expect(isValidEmail('notanemail')).toBe(false);
  });

  it('rejects an address with no local part', () => {
    expect(isValidEmail('@nodomain.com')).toBe(false);
  });

  it('rejects an address with no domain after @', () => {
    expect(isValidEmail('user@')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });
});

describe('signIn', () => {
  it('delegates to supabase.auth.signInWithPassword with the correct credentials', async () => {
    (mockAuth.signInWithPassword as jest.Mock).mockResolvedValue({ data: {}, error: null });
    await signIn('a@b.com', 'secret');
    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret' });
  });
});

describe('signUp', () => {
  it('delegates to supabase.auth.signUp with credentials and emailRedirectTo', async () => {
    (mockAuth.signUp as jest.Mock).mockResolvedValue({ data: {}, error: null });
    await signUp('a@b.com', 'secret');
    expect(mockAuth.signUp).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'secret',
      options: { emailRedirectTo: TEST_REDIRECT_URL },
    });
  });
});

describe('signInAsGuest', () => {
  it('delegates to supabase.auth.signInAnonymously', async () => {
    (mockAuth.signInAnonymously as jest.Mock).mockResolvedValue({ data: {}, error: null });
    await signInAsGuest();
    expect(mockAuth.signInAnonymously).toHaveBeenCalled();
  });
});

describe('upgradeAccount', () => {
  it('delegates to supabase.auth.updateUser with credentials and emailRedirectTo', async () => {
    (mockAuth.updateUser as jest.Mock).mockResolvedValue({ data: {}, error: null });
    await upgradeAccount('a@b.com', 'newpass');
    expect(mockAuth.updateUser).toHaveBeenCalledWith(
      { email: 'a@b.com', password: 'newpass' },
      { emailRedirectTo: TEST_REDIRECT_URL },
    );
  });
});

describe('signOut', () => {
  it('delegates to supabase.auth.signOut', async () => {
    (mockAuth.signOut as jest.Mock).mockResolvedValue({ error: null });
    await signOut();
    expect(mockAuth.signOut).toHaveBeenCalled();
  });
});
