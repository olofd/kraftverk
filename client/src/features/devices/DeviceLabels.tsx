import { useState } from 'react';
import { router } from 'expo-router';
import { Button, Text, YStack } from 'tamagui';

import { describeError, PATHS, type DeviceView } from '@kraftverk/api-client';
import { Card, SectionLabel, ToggleChips } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useFamily } from '../../state/FamilyProvider';
import { useLabels } from '../../state/useLabels';

/** A device's labels (docs/PLAN-WORLD-MODEL.md §8.13): the family's own groupings it is in, turned on and off. */
export function DeviceLabels({ device }: { device: DeviceView }) {
  const { api } = useFamily();
  const { labels, reload } = useLabels();
  const [problem, setProblem] = useState<string | null>(null);
  if (!labels) return null;
  const set = async (ids: string[]) => {
    setProblem(null);
    try {
      await api.labels.set({ device: device.id }, ids);
      await reload();
    } catch (err) {
      setProblem(describeError(err) || 'Its labels could not be saved');
    }
  };
  return (
    <YStack gap="$2">
      <SectionLabel>Labels</SectionLabel>
      <Card gap="$3">
        {labels.labels.length ? (
          <ToggleChips label="Its labels" options={labels.labels.map((label) => ({ value: label.id, label: label.name, color: label.color }))} value={device.labels} onChange={(ids) => void set(ids)} />
        ) : (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Your own groupings — heating, upstairs — to filter your devices by. You have none yet.
          </Text>
        )}
        <Button alignSelf="flex-start" size="$3" minHeight={44} chromeless onPress={() => router.push(PATHS.settings.labels)}>
          {labels.labels.length ? 'Your labels' : 'Make one'}
        </Button>
      </Card>
      {problem ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {problem}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
