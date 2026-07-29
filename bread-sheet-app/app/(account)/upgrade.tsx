import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  EMAIL_ALREADY_REGISTERED_MESSAGE,
  isEmailAlreadyRegistered,
  isValidEmail,
  upgradeAccount,
} from '@/features/auth';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  TouchableOpacity,
} from 'react-native';

export default function UpgradeScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const tint = Colors[colorScheme].tint;
  const bg = Colors[colorScheme].background;
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function upgrade() {
    if (!isValidEmail(email)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setLoading(true);
    const { error } = await upgradeAccount(email, password);
    setLoading(false);
    if (error) {
      // The taken-email case is the only one the user can do something about,
      // and Supabase's raw copy for it doesn't say what to do (P8-003).
      if (isEmailAlreadyRegistered(error)) {
        setEmailError(EMAIL_ALREADY_REGISTERED_MESSAGE);
        return;
      }
      Alert.alert('Upgrade failed', error.message);
      return;
    }
    router.replace({ pathname: '/(account)/verify-email', params: { email } });
  }

  return (
    <KeyboardAvoidingView
      style={styles.keyboardView}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ThemedView style={styles.container}>
        <ThemedText type="title" style={styles.title}>Save your account</ThemedText>
        <ThemedText style={styles.subtitle}>
          Add an email and password to keep your ratings and groups across devices.
          Your guest data won&lsquo;t be lost.
        </ThemedText>

        <TextInput
          style={[styles.input, { borderColor: Colors[colorScheme].icon, color: Colors[colorScheme].text }]}
          placeholder="Email"
          placeholderTextColor={Colors[colorScheme].icon}
          value={email}
          onChangeText={(v) => { setEmail(v); setEmailError(''); }}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        {emailError ? <ThemedText style={styles.fieldError}>{emailError}</ThemedText> : null}
        <TextInput
          style={[styles.input, { borderColor: Colors[colorScheme].icon, color: Colors[colorScheme].text }]}
          placeholder="Password"
          placeholderTextColor={Colors[colorScheme].icon}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
        />

        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: tint }, loading && styles.disabled]}
          onPress={upgrade}
          disabled={loading}
        >
          <ThemedText style={[styles.primaryButtonText, { color: bg }]}>
            {loading ? 'Saving…' : 'Save Account'}
          </ThemedText>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.back()} style={styles.cancelButton}>
          <ThemedText style={[styles.cancelText, { color: Colors[colorScheme].icon }]}>
            Maybe later
          </ThemedText>
        </TouchableOpacity>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardView: {
    flex: 1,
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  title: {
    marginBottom: 4,
  },
  subtitle: {
    opacity: 0.6,
    marginBottom: 8,
    lineHeight: 22,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  primaryButton: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryButtonText: {
    fontWeight: '600',
    fontSize: 16,
  },
  disabled: {
    opacity: 0.5,
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  fieldError: {
    color: '#e53e3e',
    fontSize: 13,
    marginTop: -4,
  },
  cancelText: {
    fontSize: 14,
  },
});
