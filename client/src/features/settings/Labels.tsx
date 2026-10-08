import { useState } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type LabelView } from '@kraftverk/api-client';
import { Card, Chips, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { confirmAction } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';
import { useLabels } from '../../state/useLabels';

/** A few colours to tell labels apart by: none is a colour too. */
const LABEL_COLORS: readonly { value: string; label: string }[] = [
  { value: 'none', label: 'No colour' },
  { value: '#e5484d', label: 'Red' },
  { value: '#f76b15', label: 'Orange' },
  { value: '#ffc53d', label: 'Yellow' },
  { value: '#46a758', label: 'Green' },
  { value: '#0090ff', label: 'Blue' },
  { value: '#8e4ec6', label: 'Purple' },
];

/**
 * The family's labels (docs/PLAN-WORLD-MODEL.md §8.13): any grouping it
 * wants — "upstairs", "heating" — put on devices and rooms, and filtered by
 * on the home screen. Removing one takes it off everything.
 */
export function Labels() {
  const { api } = useFamily();
  const { labels, reload } = useLabels();
  const [name, setName] = useState('');
  const [color, setColor] = useState('none');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doing = async (work: () => Promise<unknown>, failed: string) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await reload();
    } catch (err) {
      setProblem(describeError(err) || failed);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (label: LabelView) => {
    if (!(await confirmAction(`Remove "${label.name}"?`, 'It comes off every device, room and automation it is on.', 'Remove', 'careful'))) return;
    await doing(() => api.labels.remove(label.id), 'It could not be removed');
  };
  const counted = (label: LabelView) => {
    if (!labels) return '';
    const on = (of: Record<string, string[]>) => Object.values(of).filter((ids) => ids.includes(label.id)).length;
    const parts = [
      [on(labels.labelled.devices), 'device'],
      [on(labels.labelled.spaces), 'room'],
      [on(labels.labelled.automations), 'automation'],
    ] as const;
    return parts.filter(([count]) => count).map(([count, what]) => `${count} ${what}${count === 1 ? '' : 's'}`).join(' · ') || 'On nothing yet';
  };

  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Labels" subtitle="Your own groupings, across devices, rooms and automations">
      {!labels ? <Spinner color="$accent" /> : null}
      {labels ? (
        <YStack gap="$2">
          <SectionLabel>Your labels</SectionLabel>
          <Card inset>
            {labels.labels.length === 0 ? (
              <Text fontSize={13} color="$muted" lineHeight={19} padding="$4">
                None yet: "Heating", "Upstairs", "The kids'". Put them on devices and rooms, and filter your devices by them.
              </Text>
            ) : null}
            {labels.labels.map((label, index) => (
              <YStack key={label.id}>
                {index ? <RowSeparator /> : null}
                <Row
                  leading={<YStack width={12} height={12} borderRadius={6} backgroundColor={(label.color ?? '$borderColor') as never} />}
                  title={label.name}
                  subtitle={counted(label)}
                  accessory={
                    <Button size="$3" minHeight={44} chromeless color="$danger" disabled={busy} onPress={() => void remove(label)}>
                      Remove
                    </Button>
                  }
                />
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}
      <YStack gap="$2">
        <SectionLabel>Add a label</SectionLabel>
        <Card gap="$3">
          <Chips label="Its colour" options={LABEL_COLORS} value={color} onChange={setColor} />
          <XStack gap="$2" alignItems="center">
            <Input flex={1} aria-label="Its name" placeholder="Heating" size="$4" maxLength={30} value={name} onChangeText={setName} />
            <Button
              size="$4"
              backgroundColor="$accent"
              color="$background"
              disabled={!name.trim() || busy}
              opacity={!name.trim() || busy ? 0.5 : 1}
              onPress={() =>
                void doing(async () => {
                  await api.labels.add({ name: name.trim(), ...(color !== 'none' ? { color } : {}) });
                  setName('');
                }, 'It could not be added')
              }
            >
              Add
            </Button>
          </XStack>
        </Card>
      </YStack>
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
    </Screen>
  );
}
