import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import type { AutomationView, DeviceView } from '@kraftverk/api-client';
import { Card, Icon, RowSeparator, SectionLabel, SegmentedControl, toggled, ToggleRow } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useTone } from '../../components/tone';
import { YamlEditor } from '../../components/YamlEditor';
import { PassphraseField, SaveOrShow, useExportFile, YoursField, type SecretsMode } from './ExportFile';

const SECRETS: readonly { value: SecretsMode; label: string }[] = [
  { value: 'none', label: 'Leave out' },
  { value: 'sealed', label: 'Sealed' },
  { value: 'plain', label: 'Plain text' },
];

/**
 * An export (docs/CONFIG.md): everything — or chosen devices and automations,
 * by key — as one configuration file, its secrets left out, sealed with a
 * passphrase, or in plain text where their owner allowed it; then downloaded,
 * or shown.
 */
export function ExportCard({ devices, automations, chosen }: { devices: readonly DeviceView[]; automations: readonly AutomationView[]; chosen: { devices: string[]; automations: string[] } | null }) {
  const tone = useTone();
  const file = useExportFile();
  const [everything, setEverything] = useState(chosen === null);
  const [pickedDevices, setPickedDevices] = useState<ReadonlySet<string>>(new Set(chosen?.devices ?? []));
  const [pickedAutomations, setPickedAutomations] = useState<ReadonlySet<string>>(new Set(chosen?.automations ?? []));

  const plainAllowed = devices.flatMap((device) =>
    device.connections.filter((connection) => connection.heldBy.kind === 'master' && connection.secretsExportable && connection.secrets.length).map((connection) => `${device.name} (${connection.methodLabel})`)
  );
  const nothingChosen = !everything && pickedDevices.size === 0 && pickedAutomations.size === 0;
  const ready = !file.busy && !nothingChosen && !file.blocked;

  const run = () => {
    if (!ready) return;
    void file.make(everything ? {} : { devices: [...pickedDevices], automations: [...pickedAutomations] }, {
      title: 'Export secrets in plain text?',
      message: `The file will carry, as they are: ${plainAllowed.join(', ') || 'nothing — no connection lets its secrets leave in plain text'}. Anyone who has the file can reach those devices as you do.`,
    });
  };

  const about = everything ? 'kraftverk' : [...pickedDevices, ...pickedAutomations].length === 1 ? [...pickedDevices, ...pickedAutomations][0]! : 'kraftverk part';

  return (
    <YStack gap="$2">
      <SectionLabel>Export</SectionLabel>
      <Card inset>
        <SegmentedControl
          title="What"
          subtitle={everything ? 'Every device, how each is reached, the links between them, every automation and the home’s values.' : 'The devices and automations you choose, by their keys.'}
          value={everything ? 'all' : 'some'}
          options={[
            { value: 'all', label: 'Everything' },
            { value: 'some', label: 'Choose' },
          ]}
          onChange={(value) => setEverything(value === 'all')}
        />
        {!everything ? (
          <>
            {devices.map((device) => (
              <YStack key={device.id}>
                <RowSeparator />
                <ToggleRow title={device.name} subtitle={device.key} checked={pickedDevices.has(device.key)} onCheckedChange={(on) => setPickedDevices((set) => toggled(set, device.key, on))} />
              </YStack>
            ))}
            {automations.map((automation) => (
              <YStack key={automation.id}>
                <RowSeparator />
                <ToggleRow title={automation.name} subtitle={`${automation.key} · automation`} checked={pickedAutomations.has(automation.key)} onCheckedChange={(on) => setPickedAutomations((set) => toggled(set, automation.key, on))} />
              </YStack>
            ))}
          </>
        ) : null}
        <RowSeparator />
        <SegmentedControl
          title="Secrets"
          subtitle={
            file.mode === 'none'
              ? 'Left out: a local key, a password. Given again after importing.'
              : file.mode === 'sealed'
                ? 'Sealed with a passphrase you choose: opened only by kraftverk, given the passphrase.'
                : plainAllowed.length
                  ? `As they are, for the connections that allow it: ${plainAllowed.join(', ')}. The others are left out.`
                  : 'No connection lets its secrets leave in plain text: they are all left out.'
          }
          value={file.mode}
          options={SECRETS}
          onChange={file.setMode}
        />
        {file.mode === 'sealed' ? (
          <YStack paddingHorizontal="$4" paddingBottom="$3" gap="$1.5">
            <PassphraseField file={file} onSubmit={run} />
            <Text fontSize={12} color="$muted" lineHeight={17}>
              Kept nowhere: without it, the secrets in the file cannot be opened.
            </Text>
          </YStack>
        ) : null}
        {file.asks ? (
          <YStack paddingHorizontal="$4" paddingBottom="$3">
            <YoursField file={file} />
          </YStack>
        ) : null}
      </Card>
      <XStack gap="$2" alignItems="center">
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={!ready} opacity={ready ? 1 : 0.5} icon={<Icon name="download" size={16} color={tone('$background')} />} onPress={run}>
          {file.busy ? 'Exporting…' : 'Export'}
        </Button>
        {nothingChosen ? (
          <Text flex={1} fontSize={13} color="$muted">
            Choose something to export.
          </Text>
        ) : null}
      </XStack>
      <ErrorText>{file.error}</ErrorText>
      {file.exported ? (
        <Card gap="$3">
          <XStack gap="$2" alignItems="center">
            <Icon name="check-circle" size={16} color={tone('$success')} />
            <Text flex={1} fontSize={15} fontWeight="600" color="$color">
              Ready: {file.exported.text.split('\n').length} lines
            </Text>
          </XStack>
          {file.exported.notes.length ? (
            <YStack gap="$1">
              {file.exported.notes.map((note) => (
                <Text key={note} fontSize={13} color="$muted" lineHeight={19}>
                  {note}
                </Text>
              ))}
            </YStack>
          ) : null}
          <SaveOrShow file={file} about={about} primary />
          {file.shown ? <YamlEditor value={file.exported.text} label="The exported configuration" /> : null}
        </Card>
      ) : null}
    </YStack>
  );
}
