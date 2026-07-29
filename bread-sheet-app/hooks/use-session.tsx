import { api } from '@/lib/api';
import { setActiveCacheUser } from '@/lib/offline/store';
import { supabase } from '@/lib/supabase';
import { AuthChangeEvent, Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';

const SessionContext = createContext<{
    session: Session | null;
    isLoading: boolean;
    isAnonymous: boolean;
}>({
    session: null,
    isLoading: true,
    isAnonymous: false,
});

export function useSession() {
    return useContext(SessionContext);
}

const SYNC_EVENTS: AuthChangeEvent[] = ['SIGNED_IN', 'USER_UPDATED', 'TOKEN_REFRESHED'];

export function SessionProvider({ children }: { children: ReactNode }) {
    const [session, setSession] = useState<Session | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            // Point the offline caches at this user *before* the session lands
            // in state, so the first render of any consumer already peeks into
            // the right namespace (P8-002).
            setActiveCacheUser(session?.user.id ?? null);
            setSession(session);
            setIsLoading(false);
            if (session) api.post('/api/users/sync', {}).catch(() => {});
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            setActiveCacheUser(session?.user.id ?? null);
            setSession(session);
            if (session && SYNC_EVENTS.includes(event)) {
                api.post('/api/users/sync', {}).catch(() => {});
            }
        });

        // Exchange auth code from deep link (email verification callback)
        const handleDeepLink = async ({ url }: { url: string }) => {
            await supabase.auth.exchangeCodeForSession(url);
        };
        Linking.getInitialURL().then(url => { if (url) handleDeepLink({ url }); });
        const linkingSub = Linking.addEventListener('url', handleDeepLink);

        return () => {
            subscription.unsubscribe();
            linkingSub.remove();
        };
    }, []);

    return (
        <SessionContext.Provider value={{ session, isLoading, isAnonymous: session?.user.is_anonymous ?? false }}>
            {children}
        </SessionContext.Provider>
    );
}
