import { useState } from 'react';
import { router } from 'expo-router';
import { Button, Input, Text, YStack } from 'tamagui';

import type { DeviceView } from '@kraftverk/api-client';
import { Card, haptic, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useAttempt } from '../../components/useAttempt';
import { useDevices } from '../../state/DevicesProvider';
import { History } from './History';

/**
 * A device you removed, kept with its history (docs/DATA-MODEL.md §4).
 *
 * Its history can still be looked at. Bringing it back is adding it again —
 * the check step recognises it and offers its history back. Deleting its
 * history is the one irreversible thing in the app, so it asks for the
 * device's name, typed.
 */
export function RemovedDevice({ device }: { device: DeviceView }) {
  const { deleteHistory } = useDevices();
  const [typed, setTyped] = useState('');
  const { busy, error, attempt } = useAttempt();

  const remove = async () => {
    haptic();
    await attempt(async () => {
      await deleteHistory(device.id, typed);
      router.replace('/removed');
    }, 'Its history could not be deleted');
  };

  return (
    <>
      <Card gap="$2">
        <Text fontSize={15} fontWeight="700" color="$color">
          Removed {device.removedAt ? new Date(device.removedAt).toLocaleDateString() : ''}
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          Its history is kept. To bring it back, add it again: when the check recognises it, it offers
          to bring this history with it.
        </Text>
        <Button alignSelf="flex-start" size="$3" onPress={() => router.push(`/add-device?type=${encodeURIComponent(device.typeId)}`)}>
          Add it again
        </Button>
      </Card>

      <History device={device} />

      <YStack gap="$2">
        <SectionLabel>Delete its history</SectionLabel>
        <Card gap="$3">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Deletes {device.name} and everything it recorded. This cannot be undone here: only a backup brings it
            back. Type its name to confirm.
          </Text>
          <Input size="$3" value={typed} onChangeText={setTyped} onSubmitEditing={() => (!busy && typed.trim() === device.name ? void remove() : undefined)} placeholder={device.name} aria-label="Its name, typed to confirm" backgroundColor="$background" borderColor="$borderColor" />
          <Button
            size="$3"
            borderColor="$danger"
            color="$danger"
            disabled={busy || typed.trim() !== device.name}
            opacity={typed.trim() === device.name ? 1 : 0.5}
            onPress={() => void remove()}
          >
            Delete for good
          </Button>
          {error ? (
            <ErrorText fontSize={12}>
              {error}
            </ErrorText>
          ) : null}
        </Card>
      </YStack>
    </>
  );
}
