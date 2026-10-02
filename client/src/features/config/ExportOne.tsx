import { Platform } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';

import { Icon, SegmentedControl } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { secretWords } from '../../components/ProblemList';
import { useTone } from '../../components/tone';
import { YamlEditor } from '../../components/YamlEditor';
import { PassphraseField, SaveOrShow, useExportFile, type SecretsMode } from './ExportFile';

/**
 * One device or one automation exported where it is (docs/CONFIG.md): a
 * file of just it — importable here again, or on another server — its
 * secrets, when it has any, left out, sealed with a passphrase, or plain if
 * its owner allowed it; then downloaded, or shown.
 */
export function ExportOne({ what, name, secrets = [], plainAllowed = false }: { what: { devices?: string[]; automations?: string[] }; name: string; secrets?: readonly string[]; plainAllowed?: boolean }) {
  const tone = useTone();
  const file = useExportFile();
  const options: { value: SecretsMode; label: string }[] = [
    { value: 'none', label: 'Leave out' },
    { value: 'sealed', label: 'Sealed' },
    ...(plainAllowed ? [{ value: 'plain' as const, label: 'Plain text' }] : []),
  ];
  const run = () =>
    void file.make(
      { devices: what.devices ?? [], automations: what.automations ?? [] },
      { title: 'Export in plain text?', message: `The file will carry its ${secretWords(secrets)} as it is: anyone who has it can reach the device as you do.` },
      Platform.OS !== 'web'
    );

  return (
    <YStack gap="$3" borderTopWidth={1} borderColor="$borderColor" paddingTop="$3">
      {secrets.length ? (
        <YStack marginHorizontal="$-4">
          <SegmentedControl
            title="Its secrets"
            subtitle={file.mode === 'none' ? `Its ${secretWords(secrets)} left out: given again after importing.` : file.mode === 'sealed' ? 'Sealed with a passphrase you choose: opened only by kraftverk, given it.' : 'As it is, as you allowed: anyone with the file has it.'}
            value={file.mode}
            options={options}
            onChange={file.setMode}
          />
        </YStack>
      ) : null}
      {file.mode === 'sealed' ? <PassphraseField file={file} onSubmit={run} /> : null}
      <XStack gap="$2" flexWrap="wrap" alignItems="center">
        <Button size="$3" minHeight={44} disabled={file.busy || file.short} opacity={file.busy || file.short ? 0.5 : 1} icon={<Icon name="file-text" size={16} color={tone('$color')} />} onPress={run}>
          {file.busy ? 'Exporting…' : file.exported ? 'Export again' : 'Make the file'}
        </Button>
        <SaveOrShow file={file} about={name} />
      </XStack>
      <ErrorText>{file.error}</ErrorText>
      {file.exported?.notes.map((note) => (
        <Text key={note} fontSize={12} color="$muted" lineHeight={17}>
          {note}
        </Text>
      ))}
      {file.exported && file.shown ? <YamlEditor value={file.exported.text} label={`${name}, exported`} minLines={4} /> : null}
      <Text fontSize={12} color="$muted" lineHeight={17}>
        {what.automations?.length
          ? 'A file of just it: import it under App settings → Configuration, or paste it into a new automation written as YAML — here, or on another server that has the devices it names.'
          : 'A file of just it: import it under App settings → Configuration — here, or on another server.'}
      </Text>
    </YStack>
  );
}
