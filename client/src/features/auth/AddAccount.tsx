import { useState } from 'react';
import { Button, Text, useTheme, XStack } from 'tamagui';

import { describeError, PASSWORD_MIN } from '@kraftverk/api-client';
import { Card, haptic, Icon } from '@kraftverk/ui';

import { useServer } from '../../state/ServersProvider';
import { ConfirmWithYours } from './ConfirmWithYours';
import { Field, passwordProblem, suggestPassword } from './fields';

export function AddAccount({ onAdded }: { onAdded: () => Promise<void> }) {
  const server = useServer();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [yours, setYours] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const invalid = !username.trim() || !yours || passwordProblem(password) !== null;
  const close = () => {
    setOpen(false);
    setUsername('');
    setPassword('');
    setYours('');
    setProblem(null);
  };

  if (!open) {
    return (
      <Button
        size="$3"
        alignSelf="flex-start"
        icon={<Icon name="user-plus" size={14} color={theme.color?.val} />}
        onPress={() => {
          haptic();
          setOpen(true);
        }}
      >
        Add an account
      </Button>
    );
  }

  return (
    <Card gap="$3">
      <Text fontSize={13} color="$muted" lineHeight={19}>
        Every account is an administrator: it can use and change everything, and manage accounts.
      </Text>
      <Field label="Username" kind="username" value={username} onChange={setUsername} autoFocus />
      <Field
        label="Password"
        kind="new-password"
        value={password}
        onChange={setPassword}
        hint={`At least ${PASSWORD_MIN} characters. Pass it on somewhere private; they can change it once they are in.`}
      />
      <ConfirmWithYours value={yours} onChange={setYours} />
      {problem ? (
        <Text fontSize={13} color="$danger" lineHeight={18} role="alert">
          {problem}
        </Text>
      ) : null}
      <XStack gap="$2" flexWrap="wrap">
        <Button size="$3" onPress={() => setPassword(suggestPassword())}>
          Suggest a password
        </Button>
        <Button
          size="$3"
          disabled={busy}
          onPress={close}
        >
          Cancel
        </Button>
        <Button
          size="$3"
          backgroundColor="$accent"
          color="$background"
          disabled={busy || invalid}
          opacity={busy || invalid ? 0.5 : 1}
          onPress={async () => {
            haptic();
            setBusy(true);
            setProblem(null);
            try {
              await server.accounts.add(username.trim(), password, yours);
              close();
              await onAdded();
            } catch (error) {
              setProblem(describeError(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          Add account
        </Button>
      </XStack>
    </Card>
  );
}
