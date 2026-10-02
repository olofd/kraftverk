import { useState } from 'react';
import { Platform } from 'react-native';
import { Button, Input, Text, XStack, YStack } from 'tamagui';

import { describeError, type ConfigExported } from '@kraftverk/api-client';
import { SegmentedControl, haptic, Icon } from '@kraftverk/ui';

import { confirmAction } from '../../lib/confirm';
import { useHome } from '../../state/HomeProvider';
import { fileNameOf, saveText } from '../../lib/download';
import { useTone } from '../automations/looks';
import { YamlEditor } from './YamlEditor';
import { secretWords } from './shared';

/** Passphrases shorter than this are refused by the server: an export travels. */
const PASSPHRASE_MIN = 12;

type Secrets = 'none' | 'sealed' | 'plain';

/**
 * One device or one automation exported where it is (docs/CONFIG.md): a
 * file of just it — importable here again, or on another server — its
 * secrets, when it has any, left out, sealed with a passphrase, or plain if
 * its owner allowed it; then downloaded, or shown.
 */
export function ExportOne({ what, name, secrets = [], plainAllowed = false }: { what: { devices?: string[]; automations?: string[] }; name: string; secrets?: readonly string[]; plainAllowed?: boolean }) {
  const { api } = useHome();
  const tone = useTone();
  const [mode, setMode] = useState<Secrets>('none');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [exported, setExported] = useState<(ConfigExported & { at: string }) | null>(null);
  const [shown, setShown] = useState(false);
  const short = mode === 'sealed' && passphrase.length < PASSPHRASE_MIN;
  const options: { value: Secrets; label: string }[] = [
    { value: 'none', label: 'Leave out' },
    { value: 'sealed', label: 'Sealed' },
    ...(plainAllowed ? [{ value: 'plain' as const, label: 'Plain text' }] : []),
  ];

  const run = async () => {
    if (busy || short) return;
    haptic();
    if (mode === 'plain' && !(await confirmAction('Export in plain text?', `The file will carry its ${secretWords(secrets)} as it is: anyone who has it can reach the device as you do.`, 'Export', 'dangerous'))) return;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api.configuration.export({ devices: what.devices ?? [], automations: what.automations ?? [], secrets: mode, ...(mode === 'sealed' ? { passphrase } : {}) });
      setExported({ ...answer, at: new Date().toISOString() });
      setShown(Platform.OS !== 'web');
    } catch (err) {
      setProblem(describeError(err) || 'It could not be exported');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$3" borderTopWidth={1} borderColor="$borderColor" paddingTop="$3">
      {secrets.length ? (
        <YStack marginHorizontal="$-4">
          <SegmentedControl
            title="Its secrets"
            subtitle={mode === 'none' ? `Its ${secretWords(secrets)} left out: given again after importing.` : mode === 'sealed' ? 'Sealed with a passphrase you choose: opened only by kraftverk, given it.' : 'As it is, as you allowed: anyone with the file has it.'}
            value={mode}
            options={options}
            onChange={setMode}
          />
        </YStack>
      ) : null}
      {mode === 'sealed' ? (
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
          borderColor={passphrase && short ? '$warning' : '$borderColor'}
          onSubmitEditing={() => void run()}
        />
      ) : null}
      <XStack gap="$2" flexWrap="wrap" alignItems="center">
        <Button size="$3" minHeight={44} disabled={busy || short} opacity={busy || short ? 0.5 : 1} icon={<Icon name="file-text" size={16} color={tone('$color')} />} onPress={() => void run()}>
          {busy ? 'Exporting…' : exported ? 'Export again' : 'Make the file'}
        </Button>
        {exported ? (
          <>
            <Button size="$3" minHeight={44} icon={<Icon name="download" size={16} color={tone('$color')} />} onPress={() => void saveText(fileNameOf(name, exported.at, 'yaml'), exported.text, 'application/yaml')}>
              {Platform.OS === 'web' ? 'Download' : 'Share'}
            </Button>
            <Button size="$3" minHeight={44} onPress={() => setShown((was) => !was)}>
              {shown ? 'Hide it' : 'Show it'}
            </Button>
          </>
        ) : null}
      </XStack>
      {problem ? (
        <Text fontSize={13} color="$danger" lineHeight={19} role="alert">
          {problem}
        </Text>
      ) : null}
      {exported?.notes.map((note) => (
        <Text key={note} fontSize={12} color="$muted" lineHeight={17}>
          {note}
        </Text>
      ))}
      {exported && shown ? <YamlEditor value={exported.text} label={`${name}, exported`} minLines={4} /> : null}
      <Text fontSize={12} color="$muted" lineHeight={17}>
        {what.automations?.length
          ? 'A file of just it: import it under App settings → Configuration, or paste it into a new automation written as YAML — here, or on another server that has the devices it names.'
          : 'A file of just it: import it under App settings → Configuration — here, or on another server.'}
      </Text>
    </YStack>
  );
}
