import { useState } from 'react';
import { Platform } from 'react-native';
import { Button, Input, Text, XStack, YStack } from 'tamagui';

import { describeError, type AutomationView, type ConfigExported, type DeviceView } from '@kraftverk/api-client';
import { fileNameOf } from '@kraftverk/device-sdk';
import { Card, haptic, Icon, RowSeparator, SectionLabel, SegmentedControl, ToggleRow } from '@kraftverk/ui';

import { useTone } from '../../components/tone';
import { YamlEditor } from '../../components/YamlEditor';
import { confirmAction } from '../../platform/confirm';
import { saveText } from '../../platform/download';
import { useHome } from '../../state/HomeProvider';

/** Passphrases shorter than this are refused by the server: an export travels. */
const PASSPHRASE_MIN = 12;

type Secrets = 'none' | 'sealed' | 'plain';

const SECRETS: readonly { value: Secrets; label: string }[] = [
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
  const { api } = useHome();
  const tone = useTone();
  const [everything, setEverything] = useState(chosen === null);
  const [pickedDevices, setPickedDevices] = useState<ReadonlySet<string>>(new Set(chosen?.devices ?? []));
  const [pickedAutomations, setPickedAutomations] = useState<ReadonlySet<string>>(new Set(chosen?.automations ?? []));
  const [secrets, setSecrets] = useState<Secrets>('none');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [exported, setExported] = useState<(ConfigExported & { at: string }) | null>(null);
  const [shown, setShown] = useState(false);

  const plainAllowed = devices.flatMap((device) =>
    device.connections.filter((connection) => connection.heldBy.kind === 'master' && connection.secretsExportable && connection.secrets.length).map((connection) => `${device.name} (${connection.methodLabel})`)
  );
  const nothingChosen = !everything && pickedDevices.size === 0 && pickedAutomations.size === 0;
  const passphraseShort = secrets === 'sealed' && passphrase.length < PASSPHRASE_MIN;
  const ready = !busy && !nothingChosen && !passphraseShort;

  const toggle = (set: ReadonlySet<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  const run = async () => {
    if (!ready) return;
    haptic();
    if (secrets === 'plain' && !(await confirmAction('Export secrets in plain text?', `The file will carry, as they are: ${plainAllowed.join(', ') || 'nothing — no connection lets its secrets leave in plain text'}. Anyone who has the file can reach those devices as you do.`, 'Export', 'dangerous'))) return;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api.configuration.export({
        ...(everything ? {} : { devices: [...pickedDevices], automations: [...pickedAutomations] }),
        secrets,
        ...(secrets === 'sealed' ? { passphrase } : {}),
      });
      setExported({ ...answer, at: new Date().toISOString() });
      setShown(false);
    } catch (err) {
      setProblem(describeError(err) || 'It could not be exported');
    } finally {
      setBusy(false);
    }
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
                <ToggleRow title={device.name} subtitle={device.key} checked={pickedDevices.has(device.key)} onCheckedChange={(on) => setPickedDevices((set) => toggle(set, device.key, on))} />
              </YStack>
            ))}
            {automations.map((automation) => (
              <YStack key={automation.id}>
                <RowSeparator />
                <ToggleRow title={automation.name} subtitle={`${automation.key} · automation`} checked={pickedAutomations.has(automation.key)} onCheckedChange={(on) => setPickedAutomations((set) => toggle(set, automation.key, on))} />
              </YStack>
            ))}
          </>
        ) : null}
        <RowSeparator />
        <SegmentedControl
          title="Secrets"
          subtitle={
            secrets === 'none'
              ? 'Left out: a local key, a password. Given again after importing.'
              : secrets === 'sealed'
                ? 'Sealed with a passphrase you choose: opened only by kraftverk, given the passphrase.'
                : plainAllowed.length
                  ? `As they are, for the connections that allow it: ${plainAllowed.join(', ')}. The others are left out.`
                  : 'No connection lets its secrets leave in plain text: they are all left out.'
          }
          value={secrets}
          options={SECRETS}
          onChange={setSecrets}
        />
        {secrets === 'sealed' ? (
          <YStack paddingHorizontal="$4" paddingBottom="$3" gap="$1.5">
            <Input
              size="$4"
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={`A passphrase, ${PASSPHRASE_MIN} characters at least`}
              aria-label="Passphrase"
              backgroundColor="$background"
              borderColor={passphrase && passphraseShort ? '$warning' : '$borderColor'}
              onSubmitEditing={() => void run()}
            />
            <Text fontSize={12} color="$muted" lineHeight={17}>
              Kept nowhere: without it, the secrets in the file cannot be opened.
            </Text>
          </YStack>
        ) : null}
      </Card>
      <XStack gap="$2" alignItems="center">
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={!ready} opacity={ready ? 1 : 0.5} icon={<Icon name="download" size={16} color={tone('$background')} />} onPress={() => void run()}>
          {busy ? 'Exporting…' : 'Export'}
        </Button>
        {nothingChosen ? (
          <Text flex={1} fontSize={13} color="$muted">
            Choose something to export.
          </Text>
        ) : null}
      </XStack>
      {problem ? (
        <Text fontSize={13} color="$danger" lineHeight={19} role="alert">
          {problem}
        </Text>
      ) : null}
      {exported ? (
        <Card gap="$3">
          <XStack gap="$2" alignItems="center">
            <Icon name="check-circle" size={16} color={tone('$success')} />
            <Text flex={1} fontSize={15} fontWeight="600" color="$color">
              Ready: {exported.text.split('\n').length} lines
            </Text>
          </XStack>
          {exported.notes.length ? (
            <YStack gap="$1">
              {exported.notes.map((note) => (
                <Text key={note} fontSize={13} color="$muted" lineHeight={19}>
                  {note}
                </Text>
              ))}
            </YStack>
          ) : null}
          <XStack gap="$2" flexWrap="wrap">
            <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" onPress={() => void saveText(fileNameOf(about, exported.at, 'yaml'), exported.text, 'application/yaml')}>
              {Platform.OS === 'web' ? 'Download' : 'Share'}
            </Button>
            <Button size="$3" minHeight={44} onPress={() => setShown((was) => !was)}>
              {shown ? 'Hide it' : 'Show it'}
            </Button>
          </XStack>
          {shown ? <YamlEditor value={exported.text} label="The exported configuration" /> : null}
        </Card>
      ) : null}
    </YStack>
  );
}
