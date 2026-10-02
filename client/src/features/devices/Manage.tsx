import { useState } from 'react';
import { router } from 'expo-router';
import { Button, Input, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, type DeviceView } from '@kraftverk/api-client';
import { Card, haptic, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { confirmAction } from '../../platform/confirm';
import { useDevices } from '../../state/DevicesProvider';

export const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// --- manage -----------------------------------------------------------------------

/**
 * Its name, and removing it. Removing keeps its history in the home — a
 * server's, or the app's own — so adding the same device again can bring it
 * back.
 */
export function Manage({ device }: { device: DeviceView }) {
  const { rename, remove } = useDevices();
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  const dirty = name.trim() !== device.name && name.trim().length > 0;

  const removeIt = async () => {
    haptic();
    const message = `${device.name} leaves your list, and its connections go. Its history is kept: add the same device again to bring it back.`;
    if (!(await confirmAction('Remove this device?', message, 'Remove', 'dangerous'))) return;
    setBusy(true);
    setError(null);
    try {
      await remove(device.id);
      router.replace('/');
    } catch (err) {
      setError(describeError(err) || 'It could not be removed');
    } finally {
      setBusy(false);
    }
  };

  const saveName = () => {
    haptic();
    setBusy(true);
    setError(null);
    rename(device.id, name.trim())
      .catch((err: unknown) => setError(describeError(err) || 'That name could not be saved'))
      .finally(() => setBusy(false));
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Manage</SectionLabel>
      <Card inset>
        <YStack padding="$4" gap="$2">
          <Text fontSize={15} fontWeight="600" color="$color">
            Name
          </Text>
          <XStack gap="$2">
            <Input flex={1} size="$4" value={name} maxLength={60} onChangeText={setName} onSubmitEditing={() => (dirty && !busy ? saveName() : undefined)} backgroundColor="$background" borderColor="$borderColor" aria-label="Name" />
            {dirty ? (
              <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy} onPress={saveName}>
                Save
              </Button>
            ) : null}
          </XStack>
          <Text fontSize={12} color="$muted" lineHeight={17}>
            Yours alone: changing it changes nothing but the label. {device.meta.name}
            {device.identity ? ` · ${device.identity}` : ''}
          </Text>
        </YStack>
        <RowSeparator />
        <Row
          title="Remove this device"
          subtitle="Its history is kept, to bring back or delete later"
          accessory={
            <Button size="$3" minHeight={44} disabled={busy} borderColor="$danger" icon={<Icon name="trash-2" size={13} color={theme.danger?.val} />} onPress={() => void removeIt()}>
              Remove
            </Button>
          }
        />
      </Card>
      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}
