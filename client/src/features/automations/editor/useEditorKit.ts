import { useEffect, useState } from 'react';

import { describeError, type AutomationKit, type AutomationView } from '@kraftverk/api-client';

import { useHome } from '../../../state/HomeProvider';

/*
  An automation being changed, or made (docs/AUTOMATIONS-UX.md): the same
  groups as its page — what it uses, when, only if, what it does, what it does
  if a step fails — each editable in its box, with what is wrong said in the
  group it is about, and Cancel and Save kept below the page.
*/

/** What the editor needs from the server: the recipes and functions it offers, and the automations a step may start. */
export function useEditorKit() {
  const { api } = useHome();
  const [kit, setKit] = useState<AutomationKit | null>(null);
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api.automations.kit(), api.automations.list()])
      .then(([nextKit, all]) => live && (setKit(nextKit), setAutomations(all)))
      .catch((err: unknown) => live && setError(describeError(err) || 'It could not be read'));
    return () => {
      live = false;
    };
  }, [api]);
  return { kit, automations, error };
}
