

import { ErrorText } from '../../components/ErrorText';
import { Loading } from '../../components/Loading';
import { Screen } from '../../components/Screen';
import { AutomationList } from './AutomationList';
import { useAutomations } from './useAutomations';

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
export function AutomationsScreen() {
  // How each stands, kept current while this is open: read again when a run moves, or a reading each stands on.
  const { automations, error, replace } = useAutomations({ followReadings: true });

  return (
    <Screen back="Your devices" title="Automations">
      {!automations ? <Loading error={error} /> : <ErrorText>{error}</ErrorText>}
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
