import { useCallback, useEffect, useState } from 'react';
import { Spinner, Text } from 'tamagui';

import { describeError, fetchAutomations, type AutomationView } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

import { Screen } from '../src/components/Screen';
import { AutomationList } from '../src/features/automations/AutomationList';
import { useReadAgain } from '../src/features/automations/useReadAgain';
import { useDevices } from '../src/state/DevicesProvider';

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
  const { mode } = useDevices();
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchAutomations()
      .then((all) => (setAutomations(all), setError(null)))
      .catch((err) => setError(describeError(err) || 'The automations could not be read'));
  }, []);
  useEffect(() => {
    if (mode === 'server') load();
  }, [load, mode]);
  // How each stands, kept current while this is open: read again when a run moves, or a reading each stands on.
  useReadAgain(load, { followReadings: true });

  if (mode !== 'server') {
    return (
      <Screen back="Your devices" title="Automations">
        <Card>
          <Text fontSize={14} color="$muted" lineHeight={20}>
            Automations run on a server, because something has to be awake when they are due. Add a server under App
            settings to use them.
          </Text>
        </Card>
      </Screen>
    );
  }

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
