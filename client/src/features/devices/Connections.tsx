import { router } from 'expo-router';
import { useState } from 'react';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceView } from '@kraftverk/api-client';
import { Card, haptic, Icon, Row, RowSeparator, SectionLabel, Toggle } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { secretWords } from '../../components/ProblemList';
import { useAttempt } from '../../components/useAttempt';
import { confirmAction } from '../../platform/confirm';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';
import { useReach } from '../../state/useReach';
import { ConfirmWithYours } from '../auth/ConfirmWithYours';

/**
 * How this device is reached (docs/DATA-MODEL.md §4): one connection in use,
 * the rest standing by in order. Another way to reach it is added through the
 * same steps as the device itself, and must reach this device.
 */
export function Connections({ device }: { device: DeviceView }) {
  const { prefer, removeConnection, setExportable } = useDevices();
  const { asksYourPassword } = useHome();
  // The connection whose secrets are to leave in plain text, once your password says it is you.
  const [asking, setAsking] = useState<string | null>(null);
  const [yours, setYours] = useState('');
  const reach = useReach();
  const { busy, error, attempt } = useAttempt();
  const theme = useTheme();

  const act = async (work: () => Promise<void>) => {
    haptic();
    await attempt(async () => {
      await work();
    }, 'That did not work');
  };

  const ordered = [...device.connections].sort((a, b) => a.priority - b.priority);

  return (
    <YStack gap="$2">
      <SectionLabel>Connections</SectionLabel>
      <Card inset>
        {ordered.length === 0 ? (
          <Row title="Nothing can reach this device" subtitle="Add a way to reach it" />
        ) : (
          ordered.map((connection, index) => (
            <YStack key={connection.id}>
              {index > 0 ? <RowSeparator /> : null}
              <YStack paddingHorizontal="$4" paddingVertical="$3" gap="$2">
                <XStack alignItems="center" justifyContent="space-between" gap="$2">
                  <YStack flex={1} gap={2}>
                    <Text fontSize={15} fontWeight="600" color="$color">
                      {/* Through a bridge: reached wherever the bridge is — named by the bridge, not a node. */}
                      {connection.through ? `${connection.methodLabel}, through ${connection.through.name}` : `${connection.methodLabel}, ${reach.of(connection.heldBy)}`}
                    </Text>
                    <Text fontSize={12} color="$muted">
                      {connection.inUse
                        ? 'In use'
                        : connection.lastConnectedAt
                          ? `Standing by · last connected ${new Date(connection.lastConnectedAt).toLocaleString()}`
                          : 'Standing by'}
                      {connection.through ? '' : ` · ${connection.address}`}
                      {connection.secrets.length ? ` · ${secretWords(connection.secrets)} kept` : ''}
                    </Text>
                  </YStack>
                  {connection.inUse ? <Icon name="check-circle" size={16} color={theme.success?.val} /> : null}
                </XStack>
                {connection.heldBy.kind === 'master' && connection.secrets.length ? (
                  <XStack alignItems="center" gap="$3">
                    <YStack flex={1} gap={2}>
                      <Text fontSize={14} fontWeight="600" color="$color">
                        Its secrets may leave in plain text
                      </Text>
                      <Text fontSize={12} color={connection.secretsExportable ? '$warning' : '$muted'} lineHeight={17}>
                        {connection.secretsExportable
                          ? `An export that asks for plain text carries its ${secretWords(connection.secrets)} as it is: anyone with the file has it.`
                          : `Off: an export leaves its ${secretWords(connection.secrets)} out, or seals it with a passphrase.`}
                      </Text>
                    </YStack>
                    <Toggle
                      label="Its secrets may leave in plain text"
                      checked={connection.secretsExportable}
                      disabled={busy}
                      onCheckedChange={(on) =>
                      void act(async () => {
                        if (
                          on &&
                          !(await confirmAction(
                            'Let its secrets leave in plain text?',
                            `An export that asks for plain text will carry ${device.name}’s ${secretWords(connection.secrets)} as it is. Anyone who has the file — a backup, a mail, a shared folder — can then reach the device as you do.\n\nAn export sealed with a passphrase carries it safely without this.`,
                            'Let it leave',
                            'dangerous'
                          ))
                        )
                          return;
                        if (on && asksYourPassword) {
                          setYours('');
                          setAsking(connection.id);
                          return;
                        }
                        await setExportable(device, connection, on);
                      })
                      }
                    />
                  </XStack>
                ) : null}
                {asking === connection.id ? (
                  <YStack gap="$2">
                    <ConfirmWithYours value={yours} onChange={setYours} />
                    <XStack gap="$2">
                      <Button
                        size="$3"
                        minHeight={44}
                        backgroundColor="$danger"
                        color="$background"
                        disabled={busy || !yours}
                        opacity={busy || !yours ? 0.5 : 1}
                        onPress={() =>
                          void act(async () => {
                            await setExportable(device, connection, true, yours);
                            setAsking(null);
                            setYours('');
                          })
                        }
                      >
                        Let it leave
                      </Button>
                      <Button size="$3" minHeight={44} disabled={busy} onPress={() => setAsking(null)}>
                        Cancel
                      </Button>
                    </XStack>
                  </YStack>
                ) : null}
                {ordered.length > 1 ? (
                  <XStack gap="$2">
                    {index > 0 ? (
                      <Button size="$3" minHeight={44} disabled={busy} onPress={() => void act(() => prefer(device, connection))}>
                        Make preferred
                      </Button>
                    ) : null}
                    <Button
                      size="$3" minHeight={44}
                      disabled={busy}
                      onPress={() =>
                        void act(async () => {
                          if (await confirmAction('Remove this connection?', `${device.name} will no longer be reached ${connection.methodLabel.toLowerCase()}, ${reach.of(connection.heldBy)}.`, 'Remove')) {
                            await removeConnection(device, connection);
                          }
                        })
                      }
                    >
                      Remove
                    </Button>
                  </XStack>
                ) : null}
              </YStack>
            </YStack>
          ))
        )}
        <RowSeparator />
        <Pressable onPress={() => router.push(`/add-device?attach=${encodeURIComponent(device.id)}&type=${encodeURIComponent(device.typeId)}`)}>
          <Row title="Add another way to reach it" accessory={<Icon name="plus" size={16} color={theme.muted?.val} />} />
        </Pressable>
      </Card>
      {error ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {error}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
