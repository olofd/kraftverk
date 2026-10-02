import { router } from 'expo-router';
import { useState } from 'react';
import { Spinner, Text } from 'tamagui';

import { Card } from '@kraftverk/ui';

import { Screen } from '../../../components/Screen';
import { useDevices } from '../../../state/DevicesProvider';
import { AutomationForm, recipeFits, StartFrom, useEditorKit } from './AutomationForm';
import { EMPTY, fromRecipe, type Draft } from './context';

/**
 * A new automation (docs/AUTOMATIONS-UX.md): where it starts — from nothing,
 * or a recipe copied — then the form, the same groups as an automation's page.
 * Started from a device's page (`from`), the recipes it can take part in come
 * first, its parts are offered first wherever a part is chosen, and back and
 * Cancel return to it. It fills no part by itself: a device often fits more
 * than one — a plug is both a charger's supply and its plug — and a guess
 * would be wrong as often as right. Made, it opens on its own page.
 */
export function NewAutomation({ from }: { from: string | null }) {
  const { devices } = useDevices();
  const { kit, error } = useEditorKit();
  const [start, setStart] = useState<{ draft: Draft; madeFrom: string | null; view: 'form' | 'yaml' } | null>(null);
  const device = from ? (devices.find((candidate) => candidate.id === from) ?? null) : null;
  const back = device ? { label: device.name, to: `/device/${device.id}` } : { label: 'Automations', to: '/automations' };

  if (start) {
    return (
      <AutomationForm
        existing={null}
        initial={start.draft}
        madeFrom={start.madeFrom}
        prefer={device?.id ?? null}
        back={back}
        view={start.view}
        onSaved={(made) => router.replace(`/automation/${made.id}`)}
        onCancel={() => router.replace(back.to)}
      />
    );
  }
  return (
    <Screen back={back.label} backTo={back.to} title="New automation">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={14} color="$danger">
            {error}
          </Text>
        </Card>
      ) : !kit ? (
        <Spinner color="$accent" />
      ) : (
        <StartFrom
          recipes={kit.recipes}
          fits={(recipe) => (device ? recipeFits(recipe, device) : false)}
          onChoose={(recipe) => setStart({ draft: recipe ? fromRecipe(recipe) : EMPTY, madeFrom: recipe?.id ?? null, view: 'form' })}
          onYaml={() => setStart({ draft: EMPTY, madeFrom: null, view: 'yaml' })}
        />
      )}
    </Screen>
  );
}
