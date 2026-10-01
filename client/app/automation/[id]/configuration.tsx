import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Spinner, Text } from 'tamagui';

import { describeError, fetchAutomation, type AutomationView } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

import { Screen } from '../../../src/components/Screen';
import { AutomationConfig } from '../../../src/features/config/AutomationConfig';

/**
 * An automation as configuration (docs/CONFIG.md), a page of its own under
 * its ⋯: rarely needed beside Run and Edit — its key, its YAML to read or
 * write it in, and an export of it alone.
 */
export default function AutomationConfigurationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [automation, setAutomation] = useState<AutomationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchAutomation(id)
      .then((next) => (setAutomation(next), setError(null)))
      .catch((err) => setError(describeError(err) || 'It could not be read'));
  }, [id]);
  useEffect(load, [load]);
  const back = { label: automation?.name ?? 'Automation', to: `/automation/${encodeURIComponent(id)}` };

  return (
    <Screen back={back.label} backTo={back.to} title="As configuration" subtitle={automation?.name}>
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={14} color="$danger">
            {error}
          </Text>
        </Card>
      ) : !automation ? (
        <Spinner color="$accent" />
      ) : (
        <AutomationConfig automation={automation} onChanged={setAutomation} onEditYaml={() => router.replace(`/automation/${encodeURIComponent(id)}?edit=yaml`)} />
      )}
    </Screen>
  );
}
