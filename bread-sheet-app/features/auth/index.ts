import { clearAllCaches } from '@/lib/offline/store';
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

/**
 * Copy for the one upgrade failure the user can act on: the email they typed
 * already belongs to an account. Their anonymous ratings stay where they are —
 * merging two existing accounts is out of scope (P8-003).
 */
export const EMAIL_ALREADY_REGISTERED_MESSAGE =
  'That email is already registered — sign in to that account instead. Your guest ratings stay on this device for now.';

/**
 * Supabase reports "this email is taken" through a couple of different shapes
 * depending on the project's email-confirmation settings, so match on the code
 * first and fall back to the message text.
 */
export function isEmailAlreadyRegistered(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'email_exists' || error.code === 'user_already_exists') return true;
  const message = error.message?.toLowerCase() ?? '';
  return message.includes('already registered') || message.includes('already been registered');
}

/**
 * Upgrade an anonymous session in place. This calls `updateUser` on the
 * *existing* session, which is Supabase's documented anonymous-upgrade path and
 * keeps the same user id — so every rating already submitted stays attached
 * with no migration step (P8-003).
 */
export async function upgradeAccount(email: string, password: string) {
  return supabase.auth.updateUser({ email, password }, { emailRedirectTo: getAuthRedirectUrl() } );
}

export async function signOut() {
  const result = await supabase.auth.signOut();
  // Drop every user-namespaced cache and the pending outbox: the next account
  // to sign in on this device must never see the previous one's data.
  await clearAllCaches();
  return result;
}
