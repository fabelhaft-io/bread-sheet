import { supabase } from '@/lib/supabase';

function getAuthRedirectUrl(): string {
  const url = process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL;
  if (!url) {
    throw new Error('EXPO_PUBLIC_AUTH_REDIRECT_URL is required for email verification flows');
  }
  return url;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signInAsGuest() {
  return supabase.auth.signInAnonymously();
}

export async function signUp(email: string, password: string) {
  return supabase.auth.signUp({ email, password, options: { emailRedirectTo: getAuthRedirectUrl() } });
}

export async function upgradeAccount(email: string, password: string) {
  return supabase.auth.updateUser({ email, password }, { emailRedirectTo: getAuthRedirectUrl() } );
}

export async function signOut() {
  return supabase.auth.signOut();
}
