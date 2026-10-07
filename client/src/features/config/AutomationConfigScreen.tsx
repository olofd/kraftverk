import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';

import type { AutomationId } from '@kraftverk/device-sdk';
import { type AutomationView, describeError, PATHS } from '@kraftverk/api-client';

import { Loading } from '../../components/Loading';
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
  const back = { label: automation?.name ?? 'Automation', to: PATHS.automations.one(id) };

  return (
    <Screen back={back.label} backTo={back.to} title="As configuration" subtitle={automation?.name}>
      {error || !automation ? (
<Loading error={error} />
) : (
        <AutomationConfig automation={automation} onChanged={setAutomation} onEditYaml={() => router.replace(PATHS.automations.edit(id, 'yaml'))} />
      )}
    </Screen>
  );
}
