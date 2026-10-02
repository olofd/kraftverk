import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Spinner, Text } from 'tamagui';

import { describeError, type AutomationView } from '@kraftverk/api-client';
import type { AutomationId } from '@kraftverk/api-contract';
import { Card } from '@kraftverk/ui';

import { Screen } from '../../components/Screen';
import { useHome } from '../../state/HomeProvider';
import { AutomationConfig } from './AutomationConfig';

/**
 * An automation as configuration (docs/CONFIG.md), a page of its own under
 * its ⋯: rarely needed beside Run and Edit — its key, its YAML to read or
 * write it in, and an export of it alone.
 */
export function AutomationConfigScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useHome();
  const [automation, setAutomation] = useState<AutomationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.automations
      .get(id as AutomationId)
      .then((next) => (setAutomation(next), setError(null)))
      .catch((err: unknown) => setError(describeError(err) || 'It could not be read'));
  }, [api, id]);
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
