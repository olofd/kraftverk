import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Text, YStack } from 'tamagui';

import { describeError, type AutomationView, type ConfigSnapshotView, type ElsewhereView } from '@kraftverk/api-client';
import { schemaLine, type Vocabulary } from '@kraftverk/home-file';
import { Card, Row, SectionLabel } from '@kraftverk/ui';

import { Screen } from '../src/components/Screen';
import { ExportCard } from '../src/features/config/ExportCard';
import { ImportCard } from '../src/features/config/ImportCard';
import { useDevices } from '../src/state/DevicesProvider';
import { useHome } from '../src/state/HomeProvider';
import { useServers } from '../src/state/ServersProvider';

/**
 * Your home as one configuration file (docs/CONFIG.md): an export of all of
 * it or of what you choose, an import planned before it is applied — on a
 * server, and in a home the app keeps itself alike — and, with a server, the
 * copy it keeps beside its database (what carries the home across a reset)
 * and how to write one in an editor of your own. Opened from a
 * device's or an automation's page, its export starts with that one chosen.
 */
export default function ConfigurationScreen() {
  const params = useLocalSearchParams<{ devices?: string; automations?: string; import?: string; from?: string }>();
  const { devices, refresh } = useDevices();
  const { api, kind } = useHome();
  const { server } = useServers();
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
  const [snapshot, setSnapshot] = useState<ConfigSnapshotView | null>(null);
  /** A home this app keeps beside this one, to bring in: its own, moving to a server; or a server's copy, staying. */
  const [elsewhere, setElsewhere] = useState<ElsewhereView>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // The copy kept beside a database is a server's: a home the app keeps itself has none.
    Promise.all([api.automations.list(), api.configuration.vocabulary(), server ? server.snapshot() : Promise.resolve(null)])
      .then(([all, words, kept]) => (setAutomations(all), setVocabulary(words), setSnapshot(kept), setError(null)))
      .catch((err: unknown) => setError(describeError(err) || 'It could not be read'));
    void api.configuration
      .elsewhere()
      .then(setElsewhere)
      .catch(() => setElsewhere(null));
  }, [api, kind, server]);
  useEffect(load, [load]);

  const split = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : []);
  const chosen = params.devices || params.automations ? { devices: split(params.devices), automations: split(params.automations) } : null;
  const active = devices.filter((device) => !device.removedAt);

  return (
    <Screen
      back={params.import ? 'Add a device' : 'App settings'}
      backTo={params.import ? '/add-device' : '/app-settings'}
      title={params.import ? 'Import' : 'Configuration'}
      subtitle={params.import ? 'A device, an automation, or a whole home, from a configuration' : 'Your home as one file: to keep, move, or write by hand'}
    >
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={14} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}
      {params.import || kind !== 'server' ? null : <Kept snapshot={snapshot} />}
      {params.import ? null : automations ? <ExportCard key={`${params.devices}|${params.automations}`} devices={active} automations={automations} chosen={chosen} /> : null}
      <ImportCard
        vocabulary={vocabulary}
        restored={!params.import && Boolean(snapshot?.restored)}
        elsewhere={elsewhere}
        start={params.from === 'this-node' || params.from === 'copy' ? params.from : null}
        onApplied={() => (void refresh(), load())}
      />
      {params.import && kind === 'server' ? <Kept snapshot={snapshot} /> : null}
      {kind === 'server' ? <InAnEditor /> : null}
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
  const { active } = useServers();
  const line = schemaLine(`${active?.url ?? ''}/config/schema.json`);
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
