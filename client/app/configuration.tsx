import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Text, YStack } from 'tamagui';

import { describeError, fetchAutomations, fetchConfigSnapshot, fetchConfigVocabulary, getApiBaseUrl, type AutomationView, type ConfigSnapshotView } from '@kraftverk/api-client';
import { schemaLine, type Vocabulary } from '@kraftverk/config';
import { Card, Row, SectionLabel } from '@kraftverk/ui';

import { Screen } from '../src/components/Screen';
import { ExportCard } from '../src/features/config/ExportCard';
import { ImportCard } from '../src/features/config/ImportCard';
import { useDevices } from '../src/state/DevicesProvider';

/**
 * Your home as one configuration file (docs/CONFIG.md): the copy the server
 * keeps beside its database — what carries the home across a reset — an
 * export of all of it or of what you choose, an import planned before it is
 * applied, and how to write one in an editor of your own. Opened from a
 * device's or an automation's page, its export starts with that one chosen.
 */
export default function ConfigurationScreen() {
  const params = useLocalSearchParams<{ devices?: string; automations?: string; import?: string }>();
  const { devices, mode, refresh } = useDevices();
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
  const [snapshot, setSnapshot] = useState<ConfigSnapshotView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (mode !== 'server') return;
    Promise.all([fetchAutomations(), fetchConfigVocabulary(), fetchConfigSnapshot()])
      .then(([all, words, kept]) => (setAutomations(all), setVocabulary(words), setSnapshot(kept), setError(null)))
      .catch((err) => setError(describeError(err) || 'It could not be read'));
  }, [mode]);
  useEffect(load, [load]);

  const split = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : []);
  const chosen = params.devices || params.automations ? { devices: split(params.devices), automations: split(params.automations) } : null;
  const active = devices.filter((device) => !device.removedAt);

  if (mode !== 'server') {
    return (
      <Screen back="App settings" backTo="/app-settings" title="Configuration">
        <Card>
          <Text fontSize={14} color="$muted" lineHeight={20}>
            A configuration is your server’s: this app is in local mode, keeping its own devices.
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen back="App settings" backTo="/app-settings" title="Configuration" subtitle="Your home as one file: to keep, move, or write by hand">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={14} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}
      {params.import ? null : <Kept snapshot={snapshot} />}
      {params.import ? null : automations ? <ExportCard key={`${params.devices}|${params.automations}`} devices={active} automations={automations} chosen={chosen} /> : null}
      <ImportCard vocabulary={vocabulary} restored={!params.import && Boolean(snapshot?.restored)} onApplied={() => (void refresh(), load())} />
      {params.import ? <Kept snapshot={snapshot} /> : null}
      <InAnEditor />
    </Screen>
  );
}

/** The copy beside the database: when it was last written, and what restoring it last did. */
function Kept({ snapshot }: { snapshot: ConfigSnapshotView | null }) {
  const restored = snapshot?.restored ?? null;
  const count = (list: { added: string[]; changed: string[] }) => list.added.length + list.changed.length;
  return (
    <YStack gap="$2">
      <SectionLabel>Kept beside the server</SectionLabel>
      <Card inset>
        <Row
          title={snapshot?.writtenAt ? `Written ${new Date(snapshot.writtenAt).toLocaleString()}` : snapshot ? 'Not written yet' : 'Reading…'}
          subtitle="Written again within seconds of every change. When a new version starts its database afresh, your home is restored from it, by itself. Its secrets never leave the server."
        />
      </Card>
      {restored ? (
        <Card gap="$2" borderColor={restored.problems.length ? '$warning' : '$borderColor'}>
          <Text fontSize={15} fontWeight="600" color={restored.problems.length ? '$warning' : '$color'}>
            {restored.applied
              ? `Restored ${new Date(restored.at).toLocaleString()}: ${count(restored.applied.devices)} devices, ${count(restored.applied.automations)} automations`
              : `Could not be restored ${new Date(restored.at).toLocaleString()}`}
          </Text>
          {restored.problems.map((problem) => (
            <Text key={problem} fontSize={13} color="$color" lineHeight={19}>
              {problem}
            </Text>
          ))}
          {restored.problems.length ? (
            <Text fontSize={13} color="$muted" lineHeight={19}>
              The copy it was restored from is kept: under Import, import it again, giving what it needs.
            </Text>
          ) : null}
        </Card>
      ) : null}
    </YStack>
  );
}

/** How to write one in an editor of your own: the line that makes it check the file as it is typed. */
function InAnEditor() {
  const line = schemaLine(`${getApiBaseUrl()}/config/schema.json`);
  return (
    <YStack gap="$2">
      <SectionLabel>In an editor of your own</SectionLabel>
      <Card gap="$2">
        <Text fontSize={13} color="$muted" lineHeight={19}>
          In VS Code, with Red Hat’s YAML extension, this first line makes it complete and check the file as you type:
        </Text>
        <Text fontSize={12} fontFamily="$mono" color="$color" userSelect="text" backgroundColor="$backgroundPress" padding="$3" borderRadius="$3">
          {line}
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          So it knows a secret kept by name, add this to its settings:
        </Text>
        <Text fontSize={12} fontFamily="$mono" color="$color" userSelect="text" backgroundColor="$backgroundPress" padding="$3" borderRadius="$3">
          {'"yaml.customTags": ["!secret scalar"]'}
        </Text>
      </Card>
    </YStack>
  );
}
