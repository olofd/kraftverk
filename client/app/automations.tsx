import { useCallback, useEffect, useState } from 'react';
import { Spinner, Text } from 'tamagui';

import { describeError, type AutomationView } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

import { Screen } from '../src/components/Screen';
import { AutomationList } from '../src/features/automations/AutomationList';
import { useReadAgain } from '../src/features/automations/useReadAgain';
import { useHome } from '../src/state/HomeProvider';

/**
 * Automations (docs/AUTOMATIONS.md, docs/AUTOMATIONS-UX.md): each one a small
 * card — what starts it, its name, how it stands, and a button that runs it
 * now. Its name opens its own page, where it is seen whole and changed.
 *
 * Any can be run, for real. What it does on its own — its triggers — only
 * watches at first: it says what it would have done, until it is let act,
 * which is confirmed. Everything it does goes through the same gateway as a
 * tap on a switch.
 */
export default function AutomationsScreen() {
  const { api } = useHome();
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.automations
      .list()
      .then((all) => (setAutomations(all), setError(null)))
      .catch((err: unknown) => setError(describeError(err) || 'The automations could not be read'));
  }, [api]);
  useEffect(() => load(), [load]);
  // How each stands, kept current while this is open: read again when a run moves, or a reading each stands on.
  useReadAgain(load, { followReadings: true });

  const replace = (next: AutomationView) => setAutomations((all) => all?.map((candidate) => (candidate.id === next.id ? next : candidate)) ?? null);

  return (
    <Screen back="Your devices" title="Automations">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={14} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}
      {!automations && !error ? <Spinner color="$accent" /> : null}

      {automations ? (
        <AutomationList
          automations={automations}
          onChanged={replace}
          empty="An automation is steps your devices take — “power the charger, wait for its plug, switch it on, and make sure it draws” — started by you, at a time, or when something holds. Build one block by block, or start from a recipe."
        />
      ) : null}
    </Screen>
  );
}
