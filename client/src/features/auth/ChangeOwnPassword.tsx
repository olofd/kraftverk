import { useState } from 'react';
import { Button, Text, XStack } from 'tamagui';

import { PASSWORD_MIN } from '@kraftverk/api-contract';
import { describeError } from '@kraftverk/api-client';
import { Card, haptic } from '@kraftverk/ui';

import { useServer } from '../../state/ServersProvider';
import { Field, passwordProblem } from './fields';

export function ChangeOwnPassword() {
  const server = useServer();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);

  const invalid = !current || passwordProblem(next, confirm) !== null;

  if (!open) {
    return (
      <Button size="$3" alignSelf="flex-start" onPress={() => setOpen(true)}>
        Change your password
      </Button>
    );
  }

  return (
    <Card gap="$3">
      <Field label="Current password" kind="current-password" value={current} onChange={setCurrent} autoFocus />
      <Field label="New password" kind="new-password" value={next} onChange={setNext} hint={`At least ${PASSWORD_MIN} characters.`} />
      <Field label="New password again" kind="new-password" value={confirm} onChange={setConfirm} />
      {message ? (
        <Text fontSize={13} color={message.tone === 'danger' ? '$danger' : '$success'} lineHeight={18} role="alert">
          {message.text}
        </Text>
      ) : null}
      <XStack gap="$2">
        <Button flex={1} size="$3" disabled={busy} onPress={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          flex={1}
          size="$3"
          backgroundColor="$accent"
          color="$background"
          disabled={busy || invalid}
          opacity={busy || invalid ? 0.5 : 1}
          onPress={async () => {
            haptic();
            setBusy(true);
            setMessage(null);
            try {
              await server.auth.changePassword(current, next);
              setCurrent('');
              setNext('');
              setConfirm('');
              setMessage({ tone: 'success', text: 'Changed. Every other device signed in as you has been signed out.' });
            } catch (error) {
              setMessage({ tone: 'danger', text: describeError(error) });
            } finally {
              setBusy(false);
            }
          }}
        >
          Change password
        </Button>
      </XStack>
    </Card>
  );
}
