import { useState } from 'react';
import { Platform } from 'react-native';
import { Button, Input, XStack } from 'tamagui';

import type { ConfigExported } from '@kraftverk/api-client';
import { fileNameOf } from '@kraftverk/device-sdk';
import { PASSPHRASE_MIN } from '@kraftverk/home-file';
import { haptic, Icon } from '@kraftverk/ui';

import { useTone } from '../../components/tone';
import { useAttempt } from '../../components/useAttempt';
import { confirmAction } from '../../platform/confirm';
import { saveText } from '../../platform/download';
import { useHome } from '../../state/HomeProvider';

/*
  An export being made (docs/CONFIG.md), wherever it is asked for — the whole
  home, or one device or automation on its page: how its secrets go — left
  out, sealed with a passphrase, or plain where their owner allowed it — the
  file once made, and saving or showing it.
*/

/** How an export's secrets go: left out, sealed with a passphrase, or as they are. */
export type SecretsMode = 'none' | 'sealed' | 'plain';

/** An export as it is made: its secrets' mode and passphrase, the file once made, and making it. */
export function useExportFile() {
  const { api } = useHome();
  const [mode, setMode] = useState<SecretsMode>('none');
  const [passphrase, setPassphrase] = useState('');
  const [exported, setExported] = useState<(ConfigExported & { at: string }) | null>(null);
  const [shown, setShown] = useState(false);
  const { busy, error, attempt } = useAttempt();
  /** A passphrase the home would refuse: an export travels. */
  const short = mode === 'sealed' && passphrase.length < PASSPHRASE_MIN;

  /** Makes the file — asking first, in `plain`'s words, when its secrets go as they are — and shows it at once when `show`. */
  const make = async (what: { devices?: string[]; automations?: string[] }, plain: { title: string; message: string }, show = false) => {
    if (busy || short) return;
    haptic();
    if (mode === 'plain' && !(await confirmAction(plain.title, plain.message, 'Export', 'dangerous'))) return;
    await attempt(async () => {
      const answer = await api.configuration.export({ ...what, secrets: mode, ...(mode === 'sealed' ? { passphrase } : {}) });
      setExported({ ...answer, at: new Date().toISOString() });
      setShown(show);
    }, 'It could not be exported');
  };

  return { mode, setMode, passphrase, setPassphrase, short, exported, shown, setShown, busy, error, make };
}

export type ExportFile = ReturnType<typeof useExportFile>;

/** The passphrase an export's secrets are sealed with: said short while it is. */
export function PassphraseField({ file, onSubmit }: { file: ExportFile; onSubmit: () => void }) {
  return (
    <Input
      size="$4"
      value={file.passphrase}
      onChangeText={file.setPassphrase}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      placeholder={`A passphrase, ${PASSPHRASE_MIN} characters at least`}
      aria-label="Passphrase"
      backgroundColor="$background"
      borderColor={file.passphrase && file.short ? '$warning' : '$borderColor'}
      onSubmitEditing={onSubmit}
    />
  );
}

/** The file made: downloaded on the web, shared on a phone — named for what it is about — or shown. */
export function SaveOrShow({ file, about, primary = false }: { file: ExportFile; about: string; primary?: boolean }) {
  const tone = useTone();
  const exported = file.exported;
  if (!exported) return null;
  return (
    <XStack gap="$2" flexWrap="wrap">
      <Button
        size="$3"
        minHeight={44}
        {...(primary ? { backgroundColor: '$accent', color: '$background' } : { icon: <Icon name="download" size={16} color={tone('$color')} /> })}
        onPress={() => void saveText(fileNameOf(about, exported.at, 'yaml'), exported.text, 'application/yaml')}
      >
        {Platform.OS === 'web' ? 'Download' : 'Share'}
      </Button>
      <Button size="$3" minHeight={44} onPress={() => file.setShown((was) => !was)}>
        {file.shown ? 'Hide it' : 'Show it'}
      </Button>
    </XStack>
  );
}
