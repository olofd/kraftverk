import { useEffect, useState } from 'react';
import { Button, Input, Text, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import { Card, haptic, SectionLabel } from '@kraftverk/ui';

import { confirmAction } from '../../platform/confirm';
import { useDevices } from '../../state/DevicesProvider';
import { useServer } from '../../state/ServersProvider';

/**
 * Emptying the database.
 *
 * The blank canvas a fresh install starts from, without asking anyone to find
 * and delete a file on the server. It takes everything: devices, their recorded
 * history, their connections and secrets, their links, and the audit timeline
 * that would otherwise be the record of it happening.
 *
 * Guarded by a passphrase kept in a file on the server, because this API has no
 * authentication of its own and this is the most destructive thing it offers.
 * When no such file exists the control is not shown as a disabled button — it is
 * shown as instructions, because "not enabled" is a thing the user can fix and
 * a greyed-out button does not say how.
 */
export function ResetEverything() {
  const { refresh } = useDevices();
  const server = useServer();

  const [availability, setAvailability] = useState<{ available: boolean; secretFile: string } | null>(
    null
  );
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void server.reset
      .available()
      .then((answer) => live && setAvailability(answer))
      .catch(() => live && setAvailability(null));
    return () => {
      live = false;
    };
  }, [server]);

  const wipe = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await server.reset.run(secret.trim());
      setSecret('');
      setDone(`Removed ${result.rows} rows across ${result.tables.length} tables.`);
      await refresh();
    } catch (err) {
      setError(describeError(err) || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const ask = async () => {
    haptic();
    const message = 'Every device, all recorded history, every connection and its secrets will be deleted. This cannot be undone.';
    if (await confirmAction('Erase everything?', message, 'Erase', 'dangerous')) void wipe();
  };

  // Nothing to say until the server has answered.
  if (!availability) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Danger zone</SectionLabel>

      {availability.available ? (
        <Card gap="$3" borderColor="$danger">
          <YStack gap="$2">
            <Text fontSize={15} fontWeight="700" color="$danger">
              Erase everything
            </Text>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Removes every device, all recorded history, every connection and its secrets, and the
              audit timeline. The server keeps running and comes back as a blank canvas.
            </Text>
          </YStack>

          <XStack gap="$2">
            <Input
              flex={1}
              size="$3"
              value={secret}
              placeholder="Reset passphrase"
              // `type`: Tamagui's web Input ignores `secureTextEntry`, and showed this in the clear.
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              onChangeText={setSecret}
              onSubmitEditing={() => (!busy && secret.trim() ? ask() : undefined)}
              aria-label="Reset passphrase"
              backgroundColor="$background"
              borderColor="$borderColor"
            />
            <Button
              size="$3"
              borderColor="$danger"
              color="$danger"
              disabled={busy || secret.trim().length === 0}
              onPress={ask}
            >
              {busy ? 'Erasing…' : 'Erase'}
            </Button>
          </XStack>

          {error ? (
            <Text fontSize={12} color="$danger" lineHeight={18}>
              {error}
            </Text>
          ) : null}
          {done ? (
            <Text fontSize={12} color="$muted" lineHeight={18}>
              {done}
            </Text>
          ) : null}
        </Card>
      ) : (
        /*
          Instructions rather than a disabled control. Not being enabled is
          something the user can change, and a greyed-out button would not say
          how — nor that the fix is on the server rather than in the app.
        */
        <Card gap="$2">
          <Text fontSize={15} fontWeight="700" color="$color">
            Erasing is not enabled
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            To allow this app to empty the database, write a passphrase of at least 16 characters to
            this file on the server and restart nothing — it is read on each attempt:
          </Text>
          <Text fontSize={12} color="$color" fontFamily="$mono" lineHeight={18}>
            {availability.secretFile}
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            The file is gitignored and never leaves the server. Delete it again to switch this off.
          </Text>
        </Card>
      )}
    </YStack>
  );
}
