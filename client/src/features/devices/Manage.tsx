import { useState } from 'react';
import { router } from 'expo-router';
import { Button, Input, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, type DeviceView, PATHS } from '@kraftverk/api-client';
import { Card, haptic, Icon, Row, RowSeparator, SectionLabel, TrackSetting } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { confirmAction } from '../../platform/confirm';
import { useDevices } from '../../state/DevicesProvider';


// --- manage -----------------------------------------------------------------------

/**
 * Its name, and removing it. Removing keeps its history in the home — a
 * server's, or the app's own — so adding the same device again can bring it
 * back.
 */
export function Manage({ device }: { device: DeviceView }) {
  const { rename, remove, devices, setPaused, screenProps } = useDevices();
  // A device that says where it is may keep where it has been.
  const located = device.description.attributes.some((attribute) => attribute.means === 'position');
  // What is reached through it — an account's scooters, a gateway's plugs — said before it goes.
  const members = devices.filter((other) => other.connections.some((connection) => connection.through?.id === device.id));
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  const dirty = name.trim() !== device.name && name.trim().length > 0;

  const removeIt = async () => {
    haptic();
    const through = members.length
      ? ` ${members.map((member) => member.name).join(', ')} ${members.length === 1 ? 'is' : 'are'} reached through it: ${members.length === 1 ? 'it stays, and is' : 'they stay, and are'} reached no other way until you add one.`
      : '';
    const message = `${device.name} leaves your list, and its connections go. Its history is kept: add the same device again to bring it back.${through}`;
    if (!(await confirmAction(`Remove this ${device.kind === 'hardware' ? 'device' : device.kind}?`, message, 'Remove', 'dangerous'))) return;
    setBusy(true);
    setError(null);
    try {
      await remove(device.id);
      router.replace(PATHS.home);
    } catch (err) {
      setError(describeError(err) || 'It could not be removed');
    } finally {
      setBusy(false);
    }
  };

  const pauseIt = (paused: boolean) => {
    haptic();
    setBusy(true);
    setError(null);
    setPaused(device.id, paused)
      .catch((err: unknown) => setError(describeError(err) || (paused ? 'It could not be paused' : 'It could not be resumed')))
      .finally(() => setBusy(false));
  };

  const keepTrack = (days: number | null) => {
    setBusy(true);
    setError(null);
    screenProps(device)
      .track.keep(days)
      .catch((err: unknown) => setError(describeError(err) || 'That could not be changed'))
      .finally(() => setBusy(false));
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
        {located && !device.removedAt ? (
          <>
            <RowSeparator />
            <TrackSetting days={device.trackDays} disabled={busy} onChange={keepTrack} />
          </>
        ) : null}
        <RowSeparator />
        <Row
          title={device.pausedAt ? 'Paused' : `Pause this ${device.kind === 'hardware' ? 'device' : device.kind}`}
          subtitle={
            device.pausedAt
              ? 'Kept, with its history, and not reached — nor anything through it — until you resume it'
              : 'Kept as it is, and not reached until you resume it: for one that is away, or being mended'
          }
          accessory={
            <Button size="$3" minHeight={44} disabled={busy} icon={<Icon name={device.pausedAt ? 'play' : 'pause'} size={13} color={theme.color?.val} />} onPress={() => pauseIt(!device.pausedAt)}>
              {device.pausedAt ? 'Resume' : 'Pause'}
            </Button>
          }
        />
        <RowSeparator />
        <Row
          title={`Remove this ${device.kind === 'hardware' ? 'device' : device.kind}`}
          subtitle="Its history is kept, to bring back or delete later"
          accessory={
            <Button size="$3" minHeight={44} disabled={busy} borderColor="$danger" icon={<Icon name="trash-2" size={13} color={theme.danger?.val} />} onPress={() => void removeIt()}>
              Remove
            </Button>
          }
        />
      </Card>
      {error ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {error}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
