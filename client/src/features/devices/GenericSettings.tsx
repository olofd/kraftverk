import { useMemo, useState } from 'react';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import { type DeviceView } from '@kraftverk/api-client';
import { isOnline, readingOf, settingsForms, type ConfigValues, type Value } from '@kraftverk/device-sdk';
import { Card, haptic, SchemaForm, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useAttempt } from '../../components/useAttempt';
import { useDevices } from '../../state/DevicesProvider';

/**
 * The device's own settings: the attributes its description says can be
 * written, grouped as it groups them, with what it reports now. Edits are held
 * until Save: writing a register per keystroke would put the hardware through a
 * dozen writes to reach one value.
 */
export function GenericSettings({ device }: { device: DeviceView }) {
  const { actionsFor } = useDevices();
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const { busy, error, setError: setError, attempt } = useAttempt();
  const forms = useMemo(() => settingsForms(device.description), [device]);
  const dangerous = device.description.attributes.filter((attribute) => attribute.access === 'write' && attribute.dangerous);

  if (forms.length === 0) return null;
  const values = Object.fromEntries(forms.flatMap((form) => form.keys).map((key) => [key, readingOf(device.readings, key)?.value ?? undefined]));
  const known = Object.values(values).some((value) => value !== undefined && value !== null);
  const pending = Object.keys(draft).length > 0;

  const save = async () => {
    await attempt(async () => {
      // The reply is a readback: one setting can move another.
      const result = await actionsFor(device).write(draft);
      if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
      if (result.outcome === 'unverified') setError(result.detail);
      setDraft({});
    }, 'That write was refused');
  };

  return (
    <YStack gap="$3">
      {dangerous.length > 0 ? (
        <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
          {dangerous.length === 1 ? 'One setting here can' : `${dangerous.length} settings here can`} damage the hardware if set wrongly. The device
          says which; their descriptions explain what happens.
        </Text>
      ) : null}
      {forms.map((form) => (
        <YStack key={form.section} gap="$2">
          <SectionLabel>{form.section}</SectionLabel>
          <Card inset>
            {!known ? (
              <YStack padding="$5" alignItems="center">
                {isOnline(device.health) ? <Spinner color="$accent" /> : <Text fontSize={13} color="$muted" textAlign="center">{device.health.detail}</Text>}
              </YStack>
            ) : (
              <SchemaForm
                schema={form.schema}
                values={{ ...(values as ConfigValues), ...(draft as ConfigValues) }}
                disabled={busy || !isOnline(device.health)}
                onChange={(name, value) => setDraft((current) => ({ ...current, [name]: value as Value }))}
                onSubmit={() => (pending && !busy ? void save() : undefined)}
              />
            )}
          </Card>
        </YStack>
      ))}
      {error ? (
        <ErrorText fontSize={12} paddingHorizontal="$1">
          {error}
        </ErrorText>
      ) : null}
      {pending ? (
        <XStack gap="$2">
          <Button flex={1} size="$3" minHeight={44} disabled={busy} onPress={() => setDraft({})}>
            Discard
          </Button>
          <Button
            flex={1}
            size="$3" minHeight={44}
            backgroundColor="$accent"
            color="$background"
            disabled={busy}
            onPress={() => {
              haptic();
              void save();
            }}
          >
            {busy ? 'Writing…' : 'Save'}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
}
