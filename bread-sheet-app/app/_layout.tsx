import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { SessionProvider, useSession } from '@/hooks/use-session';
import { RecentProductsProvider } from '@/hooks/use-recent-products';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useEffect, useRef } from 'react';

import {
  clearPendingReturnTo,
  getPendingReturnTo,
} from '@/lib/pending-return-to';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

const AUTHENTICATED_GROUPS = ['(tabs)', '(account)', '(app)'];

function RootLayoutNav() {
  const { session, isLoading, isAnonymous } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const handlingReturnTo = useRef(false);

  useEffect(() => {
    if (isLoading) return;
    const inAuthenticatedGroup = AUTHENTICATED_GROUPS.includes(segments[0] as string);
    const inAuthGroup = segments[0] === '(auth)';

    if (session && !isAnonymous && !inAuthenticatedGroup) {
      // Before doing the default post-signin redirect to /(tabs), honour any
      // pending return-to hint stored at signup time (e.g. the user was on a
      // product-not-found screen when they kicked off signup).
      if (handlingReturnTo.current) return;
      handlingReturnTo.current = true;
      (async () => {
        try {
          const returnTo = await getPendingReturnTo();
          if (returnTo) {
            await clearPendingReturnTo();
            router.replace(returnTo as never);
            return;
          }
          router.replace('/(tabs)');
        } finally {
          handlingReturnTo.current = false;
        }
      })();
    } else if (!session && !inAuthGroup) {
      router.replace('/(auth)/login');
    }
  }, [session, isAnonymous, isLoading, segments, router]);

  if (isLoading) return null;

  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(account)" options={{ headerShown: false }} />
      <Stack.Screen name="(app)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
    </Stack>
  );
}
export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <SessionProvider>
          <RecentProductsProvider>
            <RootLayoutNav />
          </RecentProductsProvider>
        </SessionProvider>
        <StatusBar style="auto" />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
