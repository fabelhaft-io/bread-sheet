import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase URL and Publishable Key are required.');
}

/**
 * Session persistence (P8-001).
 *
 * `persistSession` defaults to `true`, but auth-js resolves its storage in the
 * order: explicit `storage` → `globalThis.localStorage` → in-memory fallback.
 * React Native has no `localStorage`, so without an explicit adapter the session
 * lived in memory and died with the process: registered users saw the login
 * screen after every cold start, and anonymous users were handed a brand-new
 * user id (silently orphaning their earlier ratings).
 *
 * AsyncStorage is the adapter Supabase documents and tests. On web it is backed
 * by `localStorage`, so a single code path covers both platforms.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // handled manually via Linking on native
    flowType: 'pkce',
  },
});

/**
 * Drive token refresh off the app lifecycle: auth-js' refresh timer is useless
 * while the app is backgrounded (and on iOS the timer is suspended anyway), so
 * pause it and resume — which also refreshes immediately if the token expired
 * while away — on the next foreground.
 */
function handleAppStateChange(state: AppStateStatus): void {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
}

AppState.addEventListener('change', handleAppStateChange);
// The listener only fires on *changes*; prime it with the state at import time.
handleAppStateChange(AppState.currentState);
