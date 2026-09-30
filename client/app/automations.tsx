import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import {
  checkAutomation,
  rehearseAutomation,
  createAutomation,
  deleteAutomation,
  describeError,
  fetchAudit,
  fetchAutomations,
  fetchRecipes,
  updateAutomation,
  type AuditEntry,
  type AutomationMode,
  type AutomationRun,
  type Rehearsal,
  type AutomationView,
  type ConfigValues,
  type DeviceView,
  type RecipeView,
  type RoleBinding,
} from '@kraftverk/api-client';
import { capabilitiesOf, MAIN_PART, meetsNeed, partsOf } from '@kraftverk/device-sdk';
import { Card, Row, RowSeparator, SchemaForm, SectionLabel, SegmentedControl, haptic, isComplete, Icon } from '@kraftverk/ui';

import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';
import { ASKED_AGAIN, confirmAction, withConfirmation } from '../src/lib/confirm';
import { useDevices } from '../src/state/DevicesProvider';

/**
 * Automations (docs/AUTOMATIONS.md): recipes, with roles you fill with your
 * devices.
 *
 * A role offers only the devices that can do what it needs, so an automation
 * that cannot work cannot be made. A new one only watches — it says what it
 * would have done — until it is let act, which is confirmed. What an acting
 * one does goes through the same gateway as a tap on a switch, and every run,
 * acting or not, is kept and shown.
 */
export default function AutomationsScreen() {
  const { mode, devices } = useDevices();
  const [recipes, setRecipes] = useState<RecipeView[] | null>(null);
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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

  const replace = (next: AutomationView) => setAutomations((all) => all?.map((candidate) => (candidate.id === next.id ? next : candidate)) ?? null);

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

      {automations?.length === 0 && !creating ? (
        <Card gap="$2">
          <Text fontSize={15} fontWeight="700" color="$color">
            Nothing yet
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            An automation connects what your devices report to what they can do — “charge the station while it is low”.
            A new one only watches at first: it says what it would have done, and you let it act when you trust it.
          </Text>
        </Card>
      ) : null}

      {automations?.map((automation) => (
        <AutomationCard
          key={automation.id}
          automation={automation}
          recipes={recipes ?? []}
          devices={devices}
          onChanged={replace}
          onDeleted={() => setAutomations((all) => all?.filter((candidate) => candidate.id !== automation.id) ?? null)}
        />
      ))}

      {creating && recipes ? (
        <Editor
          recipes={recipes}
          devices={devices}
          onCancel={() => setCreating(false)}
          onSaved={(created) => {
            setCreating(false);
            setAutomations((all) => [...(all ?? []), created]);
          }}
        />
      ) : automations ? (
        <Button alignSelf="flex-start" size="$3" backgroundColor="$accent" color="$background" icon={<Icon name="plus" size={14} />} onPress={() => (haptic(), setCreating(true))}>
          New automation
        </Button>
      ) : null}
    </Screen>
  );
}

// --- one automation -----------------------------------------------------------------

const MODES: { value: AutomationMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'observe', label: 'Only watch' },
  { value: 'armed', label: 'Act' },
];

const MODE_SAYS: Record<AutomationMode, string> = {
  off: 'It does nothing, and does not look.',
  observe: 'It decides, and says here what it would have done. Nothing is switched.',
  armed: 'It acts on its own, through the same checks as a tap on a switch.',
};

/** Each mode its own shape as well as its colour: acting is filled, and cannot be mistaken for watching. */
const BADGE: Record<AutomationMode, { label: string; icon: 'pause' | 'eye' | 'zap'; filled: boolean }> = {
  off: { label: 'Off', icon: 'pause', filled: false },
  observe: { label: 'Only watching', icon: 'eye', filled: false },
  armed: { label: 'Acting', icon: 'zap', filled: true },
};

type Look = { icon: string; tone: '$success' | '$warning' | '$accent' | '$muted' | '$danger' | '$color' };

const OUTCOME: Record<AutomationRun['outcome'], Look> = {
  acted: { icon: 'check-circle', tone: '$success' },
  unverified: { icon: 'alert-circle', tone: '$warning' },
  'would-act': { icon: 'eye', tone: '$accent' },
  idle: { icon: 'minus-circle', tone: '$muted' },
  unknown: { icon: 'help-circle', tone: '$warning' },
  refused: { icon: 'slash', tone: '$warning' },
  failed: { icon: 'x-circle', tone: '$danger' },
};

/** What a history entry is: a run, by its outcome, or a change made to the automation. */
function lookOf(kind: string): Look {
  const outcome = kind.replace(/^automation\./, '') as AutomationRun['outcome'];
  if (outcome in OUTCOME) return OUTCOME[outcome];
  if (kind === 'automation.armed') return { icon: 'zap', tone: '$success' };
  if (kind === 'automation.created') return { icon: 'plus-circle', tone: '$color' };
  return { icon: 'edit-3', tone: '$color' };
}

/** "Today 14:02", "Yesterday 07:00", "12 Sep 07:00". */
function when(at: string): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/** The server's question, when a change to an automation wants a person's yes. */
const wantsYes = (answer: Awaited<ReturnType<typeof updateAutomation>>) =>
  'needsConfirmation' in answer ? { token: answer.needsConfirmation, reason: answer.reason } : null;

function AutomationCard({
  automation,
  recipes,
  devices,
  onChanged,
  onDeleted,
}: {
  automation: AutomationView;
  recipes: RecipeView[];
  devices: DeviceView[];
  onChanged: (next: AutomationView) => void;
  onDeleted: () => void;
}) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<AutomationRun | null>(null);
  const [rehearsal, setRehearsal] = useState<Rehearsal | null>(null);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<AuditEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const recipe = recipes.find((candidate) => candidate.id === automation.recipe) ?? null;
  const badge = BADGE[automation.mode];

  // Its history: every run and every change, as the audit timeline has them. Read again when it changes.
  const loadHistory = useCallback(() => {
    fetchAudit({ resourceKind: 'automation', resource: automation.id, limit: 50 })
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [automation.id]);
  useEffect(() => {
    if (showHistory) loadHistory();
  }, [loadHistory, showHistory, automation.updatedAt, automation.lastRunAt]);

  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(describeError(err) || failure);
    } finally {
      setBusy(false);
    }
  };

  const setMode = (mode: AutomationMode) =>
    act(async () => {
      const { answer } = await withConfirmation(
        (confirmation) => updateAutomation(automation.id, { mode, confirmation }),
        wantsYes,
        (reason, again) => confirmAction(`Let “${automation.name}” act on its own?`, `${again ? `${ASKED_AGAIN}\n\n` : ''}${automation.sentence}\n\n${reason}`, 'Let it act')
      );
      if ('automation' in answer) onChanged(answer.automation);
    }, 'That did not work');

  const remove = async () => {
    if (!(await confirmAction(`Delete “${automation.name}”?`, 'It stops, and is gone. What it did stays in the audit timeline.', 'Delete'))) return;
    await act(async () => {
      await deleteAutomation(automation.id);
      onDeleted();
    }, 'It could not be deleted');
  };

  if (editing && recipe) {
    return (
      <Editor
        recipes={[recipe]}
        devices={devices}
        existing={automation}
        onCancel={() => setEditing(false)}
        onSaved={(next) => {
          setEditing(false);
          onChanged(next);
        }}
      />
    );
  }

  return (
    <Card gap="$4">
      <YStack gap="$2">
        <XStack alignItems="center" justifyContent="space-between" gap="$3">
          <Text fontSize={17} fontWeight="800" color="$color" flex={1}>
            {automation.name}
          </Text>
          <XStack
            alignItems="center"
            gap={6}
            paddingHorizontal="$2.5"
            paddingVertical={4}
            borderRadius={999}
            borderWidth={1}
            borderColor={automation.mode === 'off' ? '$borderColor' : '$accent'}
            backgroundColor={badge.filled ? '$accent' : 'transparent'}
          >
            <Icon name={badge.icon} size={12} color={badge.filled ? theme.background?.val : automation.mode === 'off' ? theme.muted?.val : theme.accent?.val} />
            <Text fontSize={12} fontWeight="700" color={badge.filled ? '$background' : automation.mode === 'off' ? '$muted' : '$accent'}>
              {badge.label}
            </Text>
          </XStack>
        </XStack>
        <Text fontSize={14} color="$color" lineHeight={20}>
          {automation.sentence}
        </Text>
      </YStack>

      {automation.when.length ? (
        <YStack gap="$1.5">
          <Text fontSize={12} fontWeight="700" color="$muted" textTransform="uppercase" letterSpacing={0.6}>
            When it runs
          </Text>
          {automation.when.map((trigger) => (
            <XStack key={trigger} gap="$2" alignItems="flex-start">
              <Icon name="clock" size={13} color={theme.muted?.val} style={{ marginTop: 3 }} />
              <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
                {trigger}
              </Text>
            </XStack>
          ))}
          <Text fontSize={12} color="$muted" lineHeight={17}>
            A condition is looked at every time the device it reads reports.
          </Text>
        </YStack>
      ) : null}

      {automation.problems.length ? (
        <Text fontSize={13} color="$warning" lineHeight={19}>
          It cannot run as it is: {automation.problems.join('; ')}.
        </Text>
      ) : null}

      <Card inset backgroundColor="$background">
        <SegmentedControl title="What it may do" subtitle={MODE_SAYS[automation.mode]} value={automation.mode} options={MODES} disabled={busy} onChange={(mode) => void setMode(mode)} />
      </Card>

      <YStack gap="$2">
        <RunLine label="Last run" run={automation.lastResult} empty="It has not run yet: none of its conditions has come true." />
        {checked ? <RunLine label="Right now" run={checked} empty="" /> : null}
        {rehearsal ? <Rehearsed rehearsal={rehearsal} /> : null}
      </YStack>

      <YStack gap="$2">
        <Pressable onPress={() => (haptic(), setShowHistory((open) => !open))}>
          <XStack alignItems="center" gap="$2" paddingVertical="$1">
            <Icon name={showHistory ? 'chevron-down' : 'chevron-right'} size={16} color={theme.muted?.val} />
            <Text fontSize={14} fontWeight="700" color="$color">
              History
            </Text>
            <Text fontSize={12} color="$muted">
              every run, and every change
            </Text>
          </XStack>
        </Pressable>
        {showHistory ? <History entries={history} name={automation.name} /> : null}
      </YStack>

      {problem ? (
        <Text fontSize={13} color="$danger" lineHeight={19}>
          {problem}
        </Text>
      ) : null}

      <XStack gap="$2" flexWrap="wrap">
        <Button size="$3" disabled={busy || !recipe} icon={<Icon name="edit-3" size={14} color={theme.color?.val} />} onPress={() => (haptic(), setEditing(true))}>
          Edit
        </Button>
        <Button size="$3" disabled={busy} onPress={() => void act(async () => setChecked(await checkAutomation(automation.id)), 'It could not be checked')}>
          What would it do now?
        </Button>
        <Button size="$3" disabled={busy} onPress={() => void act(async () => setRehearsal(await rehearseAutomation(automation.id)), 'It could not be rehearsed')}>
          Rehearse on last week
        </Button>
        <Button size="$3" chromeless color="$danger" disabled={busy} onPress={() => void remove()}>
          Delete
        </Button>
      </XStack>
    </Card>
  );
}

/** Every run and change, newest first, as the timeline has them. */
function History({ entries, name }: { entries: AuditEntry[] | null; name: string }) {
  const theme = useTheme();
  if (!entries) return <Spinner size="small" color="$accent" alignSelf="flex-start" />;
  if (!entries.length) {
    return (
      <Text fontSize={13} color="$muted" lineHeight={19}>
        Nothing yet.
      </Text>
    );
  }
  return (
    <Card inset backgroundColor="$background">
      {entries.map((entry, index) => {
        const look = lookOf(entry.kind);
        // The timeline says whose it is — "Charge window: …" — which this card already does.
        const summary = entry.summary.startsWith(`${name}: `) ? entry.summary.slice(name.length + 2) : entry.summary;
        return (
          <YStack key={entry.id}>
            {index > 0 ? <RowSeparator /> : null}
            <XStack gap="$3" paddingHorizontal="$3" paddingVertical="$2.5" alignItems="flex-start">
              <Icon name={look.icon as never} size={15} color={(theme[look.tone.slice(1) as keyof typeof theme] as { val?: string } | undefined)?.val} style={{ marginTop: 2 }} />
              <YStack flex={1} gap={2}>
                <Text fontSize={13} color="$color" lineHeight={19}>
                  {summary}
                </Text>
                <Text fontSize={11} color="$muted">
                  {when(entry.at)}
                  {entry.actor && !entry.actor.startsWith('automation:') ? ` · ${entry.actor}` : ''}
                </Text>
              </YStack>
            </XStack>
          </YStack>
        );
      })}
    </Card>
  );
}

/** What it would have done on the last week of history, run by run, and what history could not show. */
function Rehearsed({ rehearsal }: { rehearsal: Rehearsal }) {
  const shown = rehearsal.runs.slice(-10);
  return (
    <YStack gap="$1.5">
      <Text fontSize={13} fontWeight="700" color="$color">
        On the last week: {rehearsal.runs.length ? `${rehearsal.runs.length} run${rehearsal.runs.length === 1 ? '' : 's'}${rehearsal.runs.length > shown.length ? `, the last ${shown.length} shown` : ''}` : 'it would not have run'}
      </Text>
      {/* Two triggers can fire in one minute: the run's place, not its time, tells them apart. */}
      {shown.map((run, index) => (
        <RunLine key={`${index}:${run.at}`} label="Would have" run={{ at: run.at, outcome: run.outcome, summary: run.summary }} empty="" />
      ))}
      {rehearsal.caveats.map((caveat) => (
        <Text key={caveat} fontSize={12} color="$muted" lineHeight={17}>
          {caveat}.
        </Text>
      ))}
    </YStack>
  );
}

function RunLine({ label, run, empty }: { label: string; run: AutomationRun | null; empty: string }) {
  const theme = useTheme();
  if (!run) {
    return (
      <Text fontSize={13} color="$muted" lineHeight={19}>
        {label}: {empty}
      </Text>
    );
  }
  const look = OUTCOME[run.outcome];
  return (
    <XStack gap="$2" alignItems="flex-start">
      <Icon name={look.icon as never} size={14} color={(theme[look.tone.slice(1) as keyof typeof theme] as { val?: string } | undefined)?.val} style={{ marginTop: 3 }} />
      <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
        <Text fontWeight="700">{label}</Text>, {when(run.at)}: {run.summary}
      </Text>
    </XStack>
  );
}

// --- making one, and changing one ---------------------------------------------------------

function defaults(recipe: RecipeView): ConfigValues {
  return Object.fromEntries(
    Object.entries(recipe.params.fields).flatMap(([name, field]) => ('default' in field && field.default !== undefined ? [[name, field.default]] : []))
  );
}

/**
 * Making an automation, or changing one: its recipe (fixed once made), the
 * devices that fill its roles, its settings, and its name. Changing one that
 * acts asks first, as letting it act does: what it may do changes.
 */
function Editor({
  recipes,
  devices,
  existing,
  onCancel,
  onSaved,
}: {
  recipes: RecipeView[];
  devices: DeviceView[];
  /** The automation being changed; none when making a new one. */
  existing?: AutomationView;
  onCancel: () => void;
  onSaved: (automation: AutomationView) => void;
}) {
  const [recipe, setRecipe] = useState<RecipeView | null>(existing ? (recipes[0] ?? null) : recipes.length === 1 ? recipes[0]! : null);
  const [name, setName] = useState(existing?.name ?? '');
  const [roles, setRoles] = useState<Record<string, RoleBinding>>(existing?.roles ?? {});
  const [params, setParams] = useState<ConfigValues>(() => (existing ? { ...existing.params } : recipes.length === 1 ? defaults(recipes[0]!) : {}));
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
    : ['what it does'];
  const ready = missing.length === 0;

  const save = async () => {
    if (!recipe) return;
    setBusy(true);
    setProblem(null);
    try {
      const chosenName = name.trim() || recipe.label;
      if (!existing) {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        onSaved(await createAutomation({ name: chosenName, recipe: recipe.id, roles, params, timeZone }));
        return;
      }
      const changes = { name: chosenName, roles, params };
      const { answer } = await withConfirmation(
        (confirmation) => updateAutomation(existing.id, { ...changes, confirmation }),
        wantsYes,
        (reason, again) => confirmAction(`Change “${existing.name}” while it acts?`, again ? `${ASKED_AGAIN}\n\n${reason}` : reason, 'Change it')
      );
      if ('automation' in answer) onSaved(answer.automation);
    } catch (err) {
      setProblem(describeError(err) || 'It could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card gap="$4" borderWidth={1} borderColor="$accent">
      <YStack gap="$1">
        <Text fontSize={17} fontWeight="800" color="$color">
          {existing ? `Change “${existing.name}”` : 'New automation'}
        </Text>
        {recipe ? (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {recipe.label}: {recipe.description}
          </Text>
        ) : null}
      </YStack>

      {!existing && recipes.length > 1 ? (
        <YStack gap="$2">
          <SectionLabel>What should it do?</SectionLabel>
          <Card inset backgroundColor="$background">
            {recipes.map((candidate, index) => (
              <YStack key={candidate.id}>
                {index > 0 ? <RowSeparator /> : null}
                <Pressable selected={recipe?.id === candidate.id} onPress={() => (setRecipe(candidate), setParams(defaults(candidate)), setRoles({}))}>
                  <Row title={candidate.label} subtitle={candidate.from ? `${candidate.description} From ${candidate.from.name}.` : candidate.description} />
                </Pressable>
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {recipe ? (
        <>
          {Object.entries(recipe.roles).map(([role, spec]) => (
            <YStack key={role} gap="$2">
              <SectionLabel>{spec.label}</SectionLabel>
              <Card inset backgroundColor="$background">
                {fits[role]?.length ? (
                  fits[role]!.map(({ device, part, title }, index) => (
                    <YStack key={`${device.id}:${part.id}`}>
                      {index > 0 ? <RowSeparator /> : null}
                      <Pressable selected={chosen(role, device, part.id)} onPress={() => setRoles((current) => ({ ...current, [role]: { device: device.id, part: part.id } }))}>
                        <Row title={title} subtitle={device.meta.name} />
                      </Pressable>
                    </YStack>
                  ))
                ) : (
                  <Row title="Nothing you have fits" subtitle={`${spec.description}. Add one first.`} />
                )}
              </Card>
            </YStack>
          ))}

          {Object.keys(recipe.params.fields).length ? (
            <YStack gap="$2">
              <SectionLabel>Settings</SectionLabel>
              <Card inset backgroundColor="$background">
                <SchemaForm schema={recipe.params} values={params} onChange={(field, value) => setParams((current) => ({ ...current, [field]: value }))} />
              </Card>
            </YStack>
          ) : null}

          <YStack gap="$2">
            <SectionLabel>Name</SectionLabel>
            <Input size="$3" value={name} placeholder={recipe.label} onChangeText={setName} backgroundColor="$background" borderColor="$borderColor" aria-label="Name" />
          </YStack>
        </>
      ) : null}

      {problem ? (
        <Text fontSize={13} color="$danger" lineHeight={19}>
          {problem}
        </Text>
      ) : null}
      {!ready ? (
        <Text fontSize={13} color="$warning" lineHeight={19} role="status">
          Still to choose: {missing.join(', ')}.
        </Text>
      ) : null}
      {existing ? null : (
        <Text fontSize={12} color="$muted" lineHeight={18}>
          It starts by only watching: it decides and says what it would have done, and switches nothing until you let it act.
        </Text>
      )}
      <XStack gap="$2" justifyContent="flex-end">
        <Button size="$3" chromeless color="$muted" disabled={busy} onPress={onCancel}>
          Cancel
        </Button>
        <Button size="$3" backgroundColor="$accent" color="$background" disabled={busy || !ready} opacity={busy || !ready ? 0.5 : 1} onPress={() => void save()}>
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Create'}
        </Button>
      </XStack>
    </Card>
  );
}
