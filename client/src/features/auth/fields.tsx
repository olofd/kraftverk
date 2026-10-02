import { Input, Text, YStack } from 'tamagui';

import { PASSWORD_MIN } from '@kraftverk/api-client';

/**
 * One labelled field. The autocomplete hints are not decoration: they are what
 * lets a password manager fill the login and save a new password correctly,
 * which is the difference between a long random password and "kraftverk1".
 */
export function Field({
  label,
  value,
  onChange,
  kind,
  hint,
  autoFocus,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  kind: 'username' | 'current-password' | 'new-password';
  hint?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  const secret = kind !== 'username';
  return (
    <YStack gap="$1.5">
      <Text fontSize={12} fontWeight="600" color="$muted">
        {label}
      </Text>
      <Input
        size="$3"
        value={value}
        onChangeText={onChange}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        // `type`, not `secureTextEntry`: Tamagui's web Input discards the latter,
        // and a password field that shows what you type is not one.
        type={secret ? 'password' : 'text'}
        autoComplete={kind === 'username' ? 'username' : kind === 'current-password' ? 'current-password' : 'new-password'}
        textContentType={kind === 'username' ? 'username' : kind === 'current-password' ? 'password' : 'newPassword'}
        onSubmitEditing={onSubmit}
        returnKeyType={onSubmit ? 'go' : 'next'}
        backgroundColor="$background"
        borderColor="$borderColor"
        aria-label={label}
      />
      {hint ? (
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {hint}
        </Text>
      ) : null}
    </YStack>
  );
}

/**
 * A password nobody will guess and a password manager will happily keep.
 * 20 characters from 57 — the letters and digits without the look-alikes
 * (I, O, l, 0, 1), so it can be read aloud or typed — is about 116 bits.
 */
export function suggestPassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length * 2);
  crypto.getRandomValues(bytes);
  let out = '';
  // Rejection sampling, so no letter is more likely than another.
  const limit = 256 - (256 % alphabet.length);
  for (const byte of bytes) {
    if (byte >= limit) continue;
    out += alphabet[byte % alphabet.length];
    if (out.length === length) break;
  }
  return out.length === length ? out : suggestPassword(length);
}

/** Why a proposed password will be refused, before the server says so. */
export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < PASSWORD_MIN) return `At least ${PASSWORD_MIN} characters`;
  if (confirm !== undefined && password !== confirm) return 'The two passwords differ';
  return null;
}
