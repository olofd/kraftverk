import { useCallback, useEffect, useMemo, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import {
  checkAutomation,
  createAutomation,
  deleteAutomation,
  describeError,
  fetchAutomations,
  fetchRecipes,
  updateAutomation,
  type AutomationMode,
  type AutomationRun,
  type AutomationView,
  type ConfigValues,
  type DeviceView,
  type RecipeView,
  type RoleBinding,
} from '@kraftverk/api-client';
import { capabilitiesOf, MAIN_PART, meetsNeed, partsOf } from '@kraftverk/device-sdk';
import { Card, Row, RowSeparator, SchemaForm, SectionLabel, SegmentedControl, haptic, isComplete } from '@kraftverk/ui';

import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';
import { confirmAction } from '../src/lib/confirm';
import { useDevices } from '../src/state/DevicesProvider';

/**
 * Automations (docs/ARCHITECTURE.md step 14): recipes, with roles you fill
 * with your devices.
 *
 * A role offers only the devices that can do what it needs, so an automation
 * that cannot work cannot be made. A new one observes — it says what it would
 * have done — until it is armed, which is confirmed. What an armed one does
 * goes through the same gateway as a tap on a switch, and lands in the audit
 * timeline with its name on it.
 */
export default function AutomationsScreen() {
  const { mode, devices } = useDevices();
  const [recipes, setRecipes] = useState<RecipeView[] | null>(null);
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextRecipes, nextAutomations] = await Promise.all([fetchRecipes(), fetchAutomations()]);
      setRecipes(nextRecipes);
      setAutomations(nextAutomations);
      setError(null);
    } catch (err) {
      setError(describeError(err) || 'The automations could not be read');
    }
  }, []);

  useEffect(() => {
    if (mode === 'server') void load();
  }, [load, mode]);

  if (mode !== 'server') {
    return (
      <Screen back="Your devices" title="Automations">
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Automations run on a server, because something has to be awake when they are due. Add a server under App
            settings to use them.
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen back="Your devices" title="Automations" subtitle="What happens on its own">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}
      {!automations && !error ? <Spinner color="$accent" /> : null}

      {automations?.length === 0 && !editing ? (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Nothing yet. An automation connects what your devices report to what they can do — “if tomorrow is sunny,
            turn the plug on”.
          </Text>
        </Card>
      ) : null}

      {automations?.map((automation) => (
        <AutomationCard
          key={automation.id}
          automation={automation}
          onChanged={(next) => setAutomations((all) => all?.map((candidate) => (candidate.id === next.id ? next : candidate)) ?? null)}
          onDeleted={() => setAutomations((all) => all?.filter((candidate) => candidate.id !== automation.id) ?? null)}
        />
      ))}

      {editing && recipes ? (
        <Editor
          recipes={recipes}
          devices={devices}
          onCancel={() => setEditing(false)}
          onSaved={(created) => {
            setEditing(false);
            setAutomations((all) => [...(all ?? []), created]);
          }}
        />
      ) : automations ? (
        <Button alignSelf="flex-start" size="$3" icon={<Feather name="plus" size={14} />} onPress={() => (haptic(), setEditing(true))}>
          New automation
        </Button>
      ) : null}
    </Screen>
  );
}

// --- one automation -----------------------------------------------------------------

const MODES: { value: AutomationMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'observe', label: 'Observe' },
  { value: 'armed', label: 'Act' },
];

const OUTCOME: Record<AutomationRun['outcome'], { icon: string; tone: string }> = {
  acted: { icon: 'check-circle', tone: '$success' },
  unverified: { icon: 'alert-circle', tone: '$warning' },
  'would-act': { icon: 'eye', tone: '$accent' },
  idle: { icon: 'minus-circle', tone: '$muted' },
  unknown: { icon: 'help-circle', tone: '$warning' },
  refused: { icon: 'slash', tone: '$warning' },
  failed: { icon: 'x-circle', tone: '$danger' },
};

function AutomationCard({ automation, onChanged, onDeleted }: { automation: AutomationView; onChanged: (next: AutomationView) => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<AutomationRun | null>(null);

  const setMode = async (mode: AutomationMode) => {
    setBusy(true);
    setProblem(null);
    try {
      let answer = await updateAutomation(automation.id, { mode });
      if ('needsConfirmation' in answer) {
        const yes = await confirmAction(`Let “${automation.name}” act on its own?`, `${automation.sentence}\n\n${answer.reason}`, 'Arm it');
        if (!yes) return;
        answer = await updateAutomation(automation.id, { mode, confirmation: answer.needsConfirmation });
      }
      if ('automation' in answer) onChanged(answer.automation);
    } catch (err) {
      setProblem(describeError(err) || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setChecked(await checkAutomation(automation.id));
    } catch (err) {
      setProblem(describeError(err) || 'It could not be checked');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmAction(`Delete “${automation.name}”?`, 'It stops, and is gone. What it did stays in the audit timeline.', 'Delete'))) return;
    setBusy(true);
    try {
      await deleteAutomation(automation.id);
      onDeleted();
    } catch (err) {
      setProblem(describeError(err) || 'It could not be deleted');
      setBusy(false);
    }
  };

  return (
    <Card gap="$3">
      <YStack gap="$1">
        <Text fontSize={15} fontWeight="700" color="$color">
          {automation.name}
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          {automation.sentence}
        </Text>
      </YStack>
      {automation.problems.length ? (
        <Text fontSize={12} color="$warning" lineHeight={18}>
          It cannot run as it is: {automation.problems.join('; ')}.
        </Text>
      ) : null}
      <SegmentedControl
        title="Mode"
        subtitle={
          automation.mode === 'armed'
            ? 'Acts on its own, through the same checks as a tap on a switch'
            : automation.mode === 'observe'
              ? 'Decides, and says what it would have done — nothing is switched'
              : 'Does nothing'
        }
        value={automation.mode}
        options={MODES}
        disabled={busy}
        onChange={(mode) => void setMode(mode)}
      />
      <RunLine label="Last run" run={automation.lastResult} empty="Not run yet" />
      {checked ? <RunLine label="Right now" run={checked} empty="" /> : null}
      {problem ? (
        <Text fontSize={12} color="$danger" lineHeight={18}>
          {problem}
        </Text>
      ) : null}
      <XStack gap="$2">
        <Button size="$2" disabled={busy} onPress={() => void check()}>
          Check now
        </Button>
        <Button size="$2" borderColor="$danger" color="$danger" disabled={busy} onPress={() => void remove()}>
          Delete
        </Button>
      </XStack>
    </Card>
  );
}

function RunLine({ label, run, empty }: { label: string; run: AutomationRun | null; empty: string }) {
  const theme = useTheme();
  if (!run) {
    return (
      <Text fontSize={12} color="$muted">
        {label}: {empty}
      </Text>
    );
  }
  const look = OUTCOME[run.outcome];
  const tone = look.tone.slice(1) as keyof typeof theme;
  return (
    <XStack gap="$2" alignItems="flex-start">
      <Feather name={look.icon as never} size={13} color={(theme[tone] as { val?: string } | undefined)?.val} style={{ marginTop: 2 }} />
      <Text flex={1} fontSize={12} color="$color" lineHeight={18}>
        {label}, {new Date(run.at).toLocaleString()}: {run.summary}
      </Text>
    </XStack>
  );
}

// --- making one -------------------------------------------------------------------

function defaults(recipe: RecipeView): ConfigValues {
  return Object.fromEntries(
    Object.entries(recipe.params.fields).flatMap(([name, field]) => ('default' in field && field.default !== undefined ? [[name, field.default]] : []))
  );
}

function Editor({
  recipes,
  devices,
  onCancel,
  onSaved,
}: {
  recipes: RecipeView[];
  devices: DeviceView[];
  onCancel: () => void;
  onSaved: (created: AutomationView) => void;
}) {
  const [recipe, setRecipe] = useState<RecipeView | null>(recipes.length === 1 ? recipes[0]! : null);
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<Record<string, RoleBinding>>({});
  const [params, setParams] = useState<ConfigValues>(() => (recipes.length === 1 ? defaults(recipes[0]!) : {}));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** For each role, every part of every device you have that fits it: a plug, or one outlet of a station. */
  const fits = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(recipe?.roles ?? {}).map(([role, spec]) => [
          role,
          devices
            .filter((device) => !device.removedAt)
            .flatMap((device) =>
              partsOf(device.description, device.name)
                .filter((part) => meetsNeed(spec, capabilitiesOf(device.description, part.id)))
                .map((part) => ({ device, part, title: part.id === MAIN_PART ? device.name : `${device.name} — ${part.label}` }))
            ),
        ])
      ),
    [devices, recipe]
  );
  const chosen = (role: string, device: DeviceView, part: string) => roles[role]?.device === device.id && roles[role]?.part === part;
  // What is still needed, said rather than implied by a greyed-out button. The name is the recipe's until you give one.
  const missing = recipe
    ? [
        ...Object.entries(recipe.roles).flatMap(([role, spec]) => (roles[role] ? [] : [spec.label.toLowerCase()])),
        ...(isComplete(recipe.params, params) ? [] : ['its settings']),
      ]
    : ['a recipe'];
  const ready = missing.length === 0;

  const save = async () => {
    if (!recipe) return;
    setBusy(true);
    setProblem(null);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      onSaved(await createAutomation({ name: name.trim() || recipe.label, recipe: recipe.id, roles, params, timeZone }));
    } catch (err) {
      setProblem(describeError(err) || 'It could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$3">
      <SectionLabel>New automation</SectionLabel>
      {recipes.length > 1 ? (
        <Card inset>
          {recipes.map((candidate, index) => (
            <YStack key={candidate.id}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable selected={recipe?.id === candidate.id} onPress={() => (setRecipe(candidate), setParams(defaults(candidate)), setRoles({}))}>
                <Row title={candidate.label} subtitle={candidate.from ? `${candidate.description} From ${candidate.from.name}.` : candidate.description} />
              </Pressable>
            </YStack>
          ))}
        </Card>
      ) : recipe ? (
        <Text fontSize={13} color="$muted" lineHeight={19} paddingHorizontal="$1">
          {recipe.label}: {recipe.description}
        </Text>
      ) : null}

      {recipe ? (
        <>
          {Object.entries(recipe.roles).map(([role, spec]) => (
            <YStack key={role} gap="$2">
              <SectionLabel>{spec.label}</SectionLabel>
              <Card inset>
                {fits[role]?.length ? (
                  fits[role]!.map(({ device, part, title }, index) => (
                    <YStack key={`${device.id}:${part.id}`}>
                      {index > 0 ? <RowSeparator /> : null}
                      <Pressable
                        selected={chosen(role, device, part.id)}
                        onPress={() => setRoles((current) => ({ ...current, [role]: { device: device.id, part: part.id } }))}
                      >
                        <Row
                          title={title}
                          subtitle={device.meta.name}
                          accessory={chosen(role, device, part.id) ? <Feather name="check" size={16} /> : undefined}
                        />
                      </Pressable>
                    </YStack>
                  ))
                ) : (
                  <Row title="Nothing you have fits" subtitle={`${spec.description}. Add one first.`} />
                )}
              </Card>
            </YStack>
          ))}

          <YStack gap="$2">
            <SectionLabel>Settings</SectionLabel>
            <Card gap="$3">
              <SchemaForm schema={recipe.params} values={params} onChange={(field, value) => setParams((current) => ({ ...current, [field]: value }))} />
            </Card>
          </YStack>

          <YStack gap="$2">
            <SectionLabel>Name</SectionLabel>
            <Input size="$3" value={name} placeholder={recipe.label} onChangeText={setName} backgroundColor="$background" borderColor="$borderColor" accessibilityLabel="Name" />
          </YStack>
        </>
      ) : null}

      {problem ? (
        <Text fontSize={12} color="$danger" lineHeight={18}>
          {problem}
        </Text>
      ) : null}
      {!ready ? (
        <Text fontSize={12} color="$warning" lineHeight={18} paddingHorizontal="$1" role="status">
          Still to choose: {missing.join(', ')}.
        </Text>
      ) : null}
      <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
        It starts by observing: it decides and says what it would have done, and switches nothing until you let it act.
      </Text>
      <XStack gap="$2">
        <Button flex={1} size="$3" disabled={busy} onPress={onCancel}>
          Cancel
        </Button>
        <Button flex={1} size="$3" backgroundColor="$accent" color="$background" disabled={busy || !ready} onPress={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </XStack>
    </YStack>
  );
}
