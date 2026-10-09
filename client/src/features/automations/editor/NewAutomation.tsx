import { useEffect, useState } from 'react';
import { router } from 'expo-router';

import { ruleFits, scriptRole } from '@kraftverk/automation';
import { describeError, PATHS } from '@kraftverk/api-client';

import { Loading } from '../../../components/Loading';
import { Screen } from '../../../components/Screen';
import { useDevices } from '../../../state/DevicesProvider';
import { useFamily } from '../../../state/FamilyProvider';
import { AutomationForm } from './AutomationForm';
import { EMPTY, fromRecipe, useEditorKit, type Draft } from './context';
import { StartFrom } from './StartFrom';

/**
 * A new automation (docs/AUTOMATIONS-UX.md): where it starts — from nothing,
 * or a recipe copied — then the form, the same groups as an automation's page.
 * Started from a device's page (`from`), the recipes it can take part in come
 * first, its parts are offered first wherever a part is chosen, and back and
 * Cancel return to it. It fills no part by itself: a device often fits more
 * than one — a plug is both a charger's supply and its plug — and a guess
 * would be wrong as often as right. Made, it opens on its own page.
 *
 * Started from a script's page (`running`), it opens on the form at once:
 * the script's step its one step, when it runs still to choose — "Run it
 * when…".
 */
export function NewAutomation({ from, running = null }: { from: string | null; running?: { script: string; step: string } | null }) {
  const { api } = useFamily();
  const { devices } = useDevices();
  const { kit, error } = useEditorKit();
  const [start, setStart] = useState<{ draft: Draft; madeFrom: string | null; view: 'form' | 'yaml' } | null>(null);
  const [scriptName, setScriptName] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const device = from ? (devices.find((candidate) => candidate.id === from) ?? null) : null;
  const back = running && scriptName ? { label: scriptName, to: PATHS.scripts.one(running.script) } : device ? { label: device.name, to: PATHS.devices.one(device.id) } : { label: 'Automations', to: PATHS.automations.list };

  // A script's step to run: the draft made from it — a role for the script, the step in "then" — once the script is read.
  useEffect(() => {
    if (!running) return;
    api.scripts
      .get(running.script)
      .then((script) => {
        const made = scriptRole(EMPTY, script.id, script.name);
        setScriptName(script.name);
        setStart({ draft: { ...made.draft, name: script.name, rule: { ...made.draft.rule, then: [{ script: { role: made.role, step: running.step } }] } }, madeFrom: null, view: 'form' });
      })
      .catch((err: unknown) => setScriptError(describeError(err) || 'The script could not be read'));
  }, [api, running?.script, running?.step]);

  if (start) {
    return (
      <AutomationForm
        existing={null}
        initial={start.draft}
        madeFrom={start.madeFrom}
        prefer={device?.id ?? null}
        back={back}
        view={start.view}
        onSaved={(made) => router.replace(PATHS.automations.one(made.id))}
        onCancel={() => router.replace(back.to)}
      />
    );
  }
  return (
    <Screen back={back.label} backTo={back.to} title="New automation">
      {error || scriptError || !kit || running ? (
        <Loading error={error ?? scriptError} />
      ) : (
        <StartFrom
          recipes={kit.recipes}
          fits={(recipe) => (device ? ruleFits(recipe.rule, device) : false)}
          onChoose={(recipe) => setStart({ draft: recipe ? fromRecipe(recipe) : EMPTY, madeFrom: recipe?.id ?? null, view: 'form' })}
          onYaml={() => setStart({ draft: EMPTY, madeFrom: null, view: 'yaml' })}
        />
      )}
    </Screen>
  );
}
