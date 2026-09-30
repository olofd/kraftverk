import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import {
  checkAutomation,
  rehearseAutomation,
  createAutomation,
  deleteAutomation,
  describeError,
  fetchAudit,
  fetchAutomationRuns,
  fetchAutomations,
  fetchRecipes,
  updateAutomation,
  type AuditEntry,
  type AutomationMode,
  type AutomationRun,
  type ConditionState,
  type Rehearsal,
  type AutomationView,
  type ConfigValues,
  type DeviceView,
  type RecipeView,
  type RoleBinding,
} from '@kraftverk/api-client';
import { capabilitiesOf, MAIN_PART, meetsNeed, partsOf } from '@kraftverk/device-sdk';
import { Card, Row, RowSeparator, SchemaForm, SectionLabel, SegmentedControl, haptic, isComplete, Icon, type IconName } from '@kraftverk/ui';

import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';
import { ago, clock, dayOf, lasted, OUTCOME, useTone, type Look } from '../src/features/automations/looks';
import { RunControl } from '../src/features/automations/RunControl';
import { RunSteps, StepPlan } from '../src/features/automations/Steps';
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
/** How often an open page reads its automations again: what each reads now, what each last did. */
const REFRESH_MS = 15_000;

export default function AutomationsScreen() {
  const { mode, devices, onAutomation } = useDevices();
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
    if (mode !== 'server') return;
    void load();
    // How each stands now, and what each last did, kept current while this is open.
    const timer = setInterval(() => {
      fetchAutomations()
        .then(setAutomations)
        .catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, mode]);

  // A run moving — started, a step taken, ended — is heard on the live stream, and read at once: a burst, once.
  useEffect(() => {
    if (mode !== 'server') return;
    let reading: ReturnType<typeof setTimeout> | null = null;
    const stop = onAutomation(() => {
      reading ??= setTimeout(() => {
        reading = null;
        fetchAutomations()
          .then(setAutomations)
          .catch(() => undefined);
      }, 250);
    });
    return () => {
      stop();
      if (reading) clearTimeout(reading);
    };
  }, [mode, onAutomation]);

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

/** What each mode means — for one started when asked, as it is started. */
const modeSays = (mode: AutomationMode, asked: boolean): string =>
  ({
    off: asked ? 'It cannot be started.' : 'It does nothing, and does not look.',
    observe: asked ? 'Tried, it says what it would do. Nothing is switched.' : 'It decides, and says here what it would have done. Nothing is switched.',
    armed: asked ? 'Started, it takes its steps, each through the same checks as a tap on a switch.' : 'It acts on its own, through the same checks as a tap on a switch.',
  })[mode];

/** How often it may look again to keep things so, in minutes; 0 is never. */
const RECHECK: { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 h' },
];

const every = (minutes: number) => (minutes === 60 ? 'hour' : `${minutes} min`);

/** What keeping things so means, for the choice as it stands. */
const recheckSays = (minutes: number | null) =>
  minutes
    ? `Every ${every(minutes)}, a condition that still holds runs it again: something switched by hand against it is switched back. What is already so is left alone.`
    : 'Once it has acted, it leaves things be until a condition comes true again: you can switch by hand in between.';

/** Each mode its own shape as well as its colour: acting is filled, and cannot be mistaken for watching. */
const BADGE: Record<AutomationMode, { label: string; icon: IconName; filled: boolean }> = {
  off: { label: 'Off', icon: 'pause', filled: false },
  observe: { label: 'Only watching', icon: 'eye', filled: false },
  armed: { label: 'Acting', icon: 'zap', filled: true },
};

/** A change made to an automation, as its history shows it. */
const CHANGE: Record<string, Look> = {
  'automation.created': { icon: 'plus', tone: '$color' },
  'automation.proposed': { icon: 'message-circle', tone: '$color' },
  'automation.armed': { icon: 'zap', tone: '$success' },
  'automation.changed': { icon: 'edit-3', tone: '$color' },
  'automation.started': { icon: 'play', tone: '$accent' },
  'automation.stopping': { icon: 'square', tone: '$muted' },
};

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
  const tone = useTone();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<AutomationRun | null>(null);
  const [rehearsal, setRehearsal] = useState<Rehearsal | null>(null);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const recipe = recipes.find((candidate) => candidate.id === automation.recipe) ?? null;
  const badge = BADGE[automation.mode];
  const asked = automation.startsWhenAsked;
  const canKeep = !automation.takesSteps && (recipe?.hasConditions ?? automation.now.conditions.length > 0);
  const onlyAsked = asked && automation.when.every((trigger) => trigger === 'When you start it');

  // Its history: every run it kept, and every change made to it. Read again when it runs or changes.
  const loadHistory = useCallback(() => {
    Promise.all([fetchAutomationRuns(automation.id, 100), fetchAudit({ resourceKind: 'automation', resource: automation.id, limit: 100 })])
      .then(([runs, entries]) => setHistory({ runs, changes: entries.filter((entry) => !isRunEntry(entry)) }))
      .catch(() => setHistory({ runs: [], changes: [] }));
  }, [automation.id]);
  useEffect(() => {
    if (showHistory) loadHistory();
  }, [loadHistory, showHistory, automation.updatedAt, automation.lastRun?.id, automation.running === null]);

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

  /** A change the server may want a yes for: asked in its words, again if the yes came too late. */
  const change = (changes: { mode?: AutomationMode; recheckMinutes?: number | null }, title: string, yes: string) =>
    act(async () => {
      const { answer } = await withConfirmation(
        (confirmation) => updateAutomation(automation.id, { ...changes, confirmation }),
        wantsYes,
        // What the yes is to comes first; what the automation does, below it.
        (reason, again) => confirmAction(title, `${again ? `${ASKED_AGAIN}\n\n` : ''}${reason}\n\n${automation.sentence}`, yes)
      );
      if ('automation' in answer) onChanged(answer.automation);
    }, 'That did not work');

  const remove = async () => {
    if (!(await confirmAction(`Delete “${automation.name}”?`, `${automation.running ? 'Its run is stopped first. ' : ''}It stops, and is gone. Everything it did stays on the timeline.`, 'Delete'))) return;
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
    <Card gap="$4" role="region" aria-label={automation.name} borderWidth={automation.running ? 1 : 0} borderColor="$accent">
      <YStack gap="$2">
        <XStack alignItems="center" justifyContent="space-between" gap="$3">
          <Text fontSize={18} fontWeight="800" color="$color" flex={1}>
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
            <Icon name={badge.icon} size={12} color={badge.filled ? tone('$background') : automation.mode === 'off' ? tone('$muted') : tone('$accent')} />
            <Text fontSize={12} fontWeight="700" color={badge.filled ? '$background' : automation.mode === 'off' ? '$muted' : '$accent'}>
              {badge.label}
            </Text>
          </XStack>
        </XStack>
        <Text fontSize={14} color="$muted" lineHeight={21}>
          {automation.sentence}
        </Text>
      </YStack>

      {automation.problems.length ? (
        <XStack gap="$2" alignItems="flex-start" padding="$3" borderRadius="$4" backgroundColor="$backgroundPress">
          <Icon name="alert-triangle" size={15} color={tone('$warning')} style={{ marginTop: 2 }} />
          <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
            It cannot run as it is: {automation.problems.join('; ')}.
          </Text>
        </XStack>
      ) : null}

      {asked ? <RunControl automation={automation} onChanged={onChanged} onTried={setChecked} /> : null}

      {automation.running ? (
        <YStack gap="$2.5" padding="$3" borderRadius="$4" backgroundColor="$background" borderWidth={1} borderColor="$accent">
          <XStack alignItems="center" gap="$2">
            <Heading>Now</Heading>
            <Text fontSize={12} color="$muted">
              {automation.running.startedBy ? `started by ${automation.running.startedBy}` : automation.running.why} · {clock(automation.running.at)}
            </Text>
          </XStack>
          <RunSteps run={automation.running} />
        </YStack>
      ) : onlyAsked ? null : (
        <Now automation={automation} />
      )}

      {automation.takesSteps ? (
        <YStack gap="$2.5">
          {automation.running ? (
            <Pressable onPress={() => (haptic(), setShowPlan((open) => !open))} label={showPlan ? 'Hide what it does' : 'Show what it does'}>
              <XStack alignItems="center" gap="$2">
                <Icon name={showPlan ? 'chevron-down' : 'chevron-right'} size={14} color={tone('$muted')} />
                <Heading>What it does</Heading>
              </XStack>
            </Pressable>
          ) : (
            <Heading>What it does</Heading>
          )}
          {!automation.running || showPlan ? <StepPlan steps={automation.steps} otherwise={automation.otherwise} /> : null}
        </YStack>
      ) : null}

      {automation.running ? null : (
        <YStack gap="$2">
          <Heading>{automation.lastRun ? `Last run · ${ago(automation.lastRun.at)}` : 'Last run'}</Heading>
          {automation.lastRun ? (
            <RunDetail run={automation.lastRun} />
          ) : (
            <Text fontSize={13} color="$muted" lineHeight={19}>
              {asked ? 'It has not been started yet.' : 'It has not run yet: none of its conditions has come true since it was made.'}
            </Text>
          )}
        </YStack>
      )}

      {checked ? (
        <YStack gap="$2" padding="$3" borderRadius="$4" borderWidth={1} borderColor="$accent">
          <XStack alignItems="center" justifyContent="space-between">
            <Heading>{asked ? 'If it were started now' : 'If it ran now'}</Heading>
            <Button size="$2" chromeless circular aria-label="Close" icon={<Icon name="x" size={14} color={tone('$muted')} />} onPress={() => setChecked(null)} />
          </XStack>
          <RunDetail run={checked} showConditions />
        </YStack>
      ) : null}

      {rehearsal ? <Rehearsed rehearsal={rehearsal} onClose={() => setRehearsal(null)} /> : null}

      <Card inset backgroundColor="$background">
        <SegmentedControl
          title={asked ? 'When started' : 'What it may do'}
          subtitle={modeSays(automation.mode, asked)}
          value={automation.mode}
          options={MODES}
          disabled={busy}
          onChange={(mode) => void change({ mode }, asked ? `Let “${automation.name}” act when started?` : `Let “${automation.name}” act on its own?`, 'Let it act')}
        />
        {canKeep ? (
          <>
            <RowSeparator />
            <SegmentedControl
              title="Keep it so"
              subtitle={recheckSays(automation.recheckMinutes)}
              value={automation.recheckMinutes ?? 0}
              options={RECHECK}
              disabled={busy}
              onChange={(minutes) =>
                void change(
                  { recheckMinutes: minutes || null },
                  minutes ? `Check “${automation.name}” every ${every(minutes)}?` : `Stop checking “${automation.name}” again?`,
                  minutes ? `Every ${every(minutes)}` : 'Stop'
                )
              }
            />
          </>
        ) : null}
      </Card>

      {problem ? (
        <XStack gap="$2" alignItems="flex-start" role="alert">
          <Icon name="alert-circle" size={15} color={tone('$danger')} style={{ marginTop: 2 }} />
          <Text flex={1} fontSize={13} color="$danger" lineHeight={19}>
            {problem}
          </Text>
        </XStack>
      ) : null}

      <XStack gap="$2" flexWrap="wrap" alignItems="center">
        <Button size="$3" disabled={busy || !recipe || automation.running !== null} icon={<Icon name="edit-3" size={14} color={tone('$color')} />} onPress={() => (haptic(), setEditing(true))}>
          Edit
        </Button>
        <Button size="$3" disabled={busy} icon={<Icon name="help-circle" size={14} color={tone('$color')} />} onPress={() => void act(async () => setChecked(await checkAutomation(automation.id)), 'It could not be checked')}>
          What would it do now?
        </Button>
        {onlyAsked ? null : (
          <Button size="$3" disabled={busy} icon={<Icon name="rewind" size={14} color={tone('$color')} />} onPress={() => void act(async () => setRehearsal(await rehearseAutomation(automation.id)), 'It could not be rehearsed')}>
            Rehearse last week
          </Button>
        )}
        <XStack flex={1} />
        <Button size="$3" chromeless color="$danger" disabled={busy} icon={<Icon name="trash-2" size={14} color={tone('$danger')} />} onPress={() => void remove()}>
          Delete
        </Button>
      </XStack>

      <YStack gap="$2" borderTopWidth={1} borderColor="$borderColor" paddingTop="$3">
        <Pressable onPress={() => (haptic(), setShowHistory((open) => !open))} label={showHistory ? 'Hide history' : 'Show history'}>
          <XStack alignItems="center" gap="$2" paddingVertical="$1">
            <Icon name={showHistory ? 'chevron-down' : 'chevron-right'} size={16} color={tone('$muted')} />
            <Text fontSize={14} fontWeight="700" color="$color">
              History
            </Text>
            <Text fontSize={12} color="$muted">
              every run, and every change
            </Text>
          </XStack>
        </Pressable>
        {showHistory ? <Timeline history={history} automation={automation} recipe={recipe} /> : null}
      </YStack>
    </Card>
  );
}

/** A small heading inside a card. */
function Heading({ children }: { children: ReactNode }) {
  return (
    <Text fontSize={11} fontWeight="800" color="$muted" textTransform="uppercase" letterSpacing={0.8}>
      {children}
    </Text>
  );
}

/** What it read, each value a chip: "Garage station: Charge 74.2 %". */
function Readings({ saw }: { saw: readonly string[] }) {
  if (!saw.length) return null;
  return (
    <XStack gap="$1.5" flexWrap="wrap">
      {saw.map((reading) => (
        <XStack key={reading} paddingHorizontal="$2" paddingVertical={3} borderRadius={999} backgroundColor="$backgroundPress">
          <Text fontSize={12} color="$color" fontVariant={['tabular-nums']}>
            {reading}
          </Text>
        </XStack>
      ))}
    </XStack>
  );
}

/** Each condition, and whether it holds: a filled mark, an empty one, or a question. */
function Conditions({ conditions }: { conditions: readonly ConditionState[] }) {
  const tone = useTone();
  return (
    <YStack gap="$2">
      {conditions.map((condition) => {
        const [mark, said, color] =
          condition.holds === true ? (['check', 'Yes', '$success'] as const) : condition.holds === false ? (['circle', 'Not now', '$muted'] as const) : (['help-circle', 'Cannot tell', '$warning'] as const);
        return (
          <XStack key={condition.text} gap="$2.5" alignItems="center">
            <YStack
              width={20}
              height={20}
              borderRadius={10}
              alignItems="center"
              justifyContent="center"
              backgroundColor={condition.holds === true ? '$success' : 'transparent'}
              borderWidth={condition.holds === true ? 0 : 1.5}
              borderColor={color}
            >
              {condition.holds === false ? null : <Icon name={mark} size={12} color={condition.holds === true ? '#ffffff' : tone(color)} />}
            </YStack>
            <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
              {condition.text}
            </Text>
            <Text fontSize={12} fontWeight="700" color={color}>
              {said}
            </Text>
          </XStack>
        );
      })}
    </YStack>
  );
}

/**
 * How it stands now: each condition it waits for, what it reads to say so,
 * and when it next looks. An automation that waits for no condition — a time
 * of day, an event — says when it runs instead.
 */
function Now({ automation }: { automation: AutomationView }) {
  const tone = useTone();
  const { conditions, saw } = automation.now;
  return (
    <YStack gap="$2.5" padding="$3" borderRadius="$4" backgroundColor="$background">
      <XStack alignItems="center" justifyContent="space-between" gap="$2">
        <Heading>{conditions.length ? 'Right now' : 'When it runs'}</Heading>
        {automation.nextLookAt ? (
          <XStack alignItems="center" gap={5}>
            <Icon name="refresh-cw" size={11} color={tone('$muted')} />
            <Text fontSize={12} color="$muted">
              Looks again {clock(automation.nextLookAt)}
            </Text>
          </XStack>
        ) : null}
      </XStack>
      {conditions.length ? (
        <>
          <Conditions conditions={conditions} />
          <Readings saw={saw} />
          <Text fontSize={12} color="$muted" lineHeight={17}>
            It runs when one of these turns to yes, and looks at them every time the device reports.
            {automation.recheckMinutes
              ? ` Every ${every(automation.recheckMinutes)} it also runs again while one still holds, unless all is already so.`
              : automation.takesSteps
                ? ''
                : ' Once it has acted, what you switch by hand stays until one turns to yes again.'}
          </Text>
        </>
      ) : (
        automation.when.map((trigger) => (
          <XStack key={trigger} gap="$2" alignItems="flex-start">
            <Icon name={trigger === 'When you start it' ? 'play' : 'clock'} size={13} color={tone('$muted')} style={{ marginTop: 3 }} />
            <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
              {trigger}
            </Text>
          </XStack>
        ))
      )}
    </YStack>
  );
}

/** A run's mark: its outcome's icon in a tinted circle. */
function Mark({ look, size = 28 }: { look: Look; size?: number }) {
  const tone = useTone();
  return (
    <YStack width={size} height={size} borderRadius={size / 2} alignItems="center" justifyContent="center" backgroundColor="$backgroundPress" borderWidth={1.5} borderColor={look.tone}>
      <Icon name={look.icon} size={Math.round(size * 0.5)} color={tone(look.tone)} />
    </YStack>
  );
}

/**
 * One run, told the way a person asks about it: what happened, why, what it
 * read, and each step it took and how it went — and, when asked, how each
 * condition stood.
 */
function RunDetail({ run, showConditions }: { run: AutomationRun; showConditions?: boolean }) {
  const tone = useTone();
  const look = OUTCOME[run.outcome];
  return (
    <XStack gap="$3" alignItems="flex-start">
      <Mark look={look} />
      <YStack flex={1} gap="$2">
        <YStack gap={2}>
          <Text fontSize={15} fontWeight="700" color="$color" lineHeight={21}>
            {run.summary}
          </Text>
          <XStack gap={5} alignItems="flex-start">
            <Icon name="corner-down-right" size={12} color={tone('$muted')} style={{ marginTop: 3 }} />
            <Text flex={1} fontSize={13} color="$muted" lineHeight={19}>
              {run.why}
              {lasted(run)}
            </Text>
          </XStack>
        </YStack>
        <Readings saw={run.saw} />
        {showConditions && run.conditions.length ? <Conditions conditions={run.conditions} /> : null}
        {run.steps.length ? <RunSteps run={run} /> : null}
      </YStack>
    </XStack>
  );
}

/** A timeline entry that stands for a run: its full story is the run itself, read from its runs. */
const isRunEntry = (entry: AuditEntry) => entry.kind.replace(/^automation\./, '') in OUTCOME;

/** Its history: every run it kept, and every change made to it. */
type History = { runs: AutomationRun[]; changes: AuditEntry[] };

type Changed = { mode?: AutomationMode; recheckMinutes?: number | null; params?: ConfigValues; roles?: Record<string, RoleBinding> };

/** What a change changed, in words: "Only watching → Acting", "Stop charging at: 50 % → 60 %". */
function changesOf(entry: AuditEntry, recipe: RecipeView | null): string[] {
  const detail = entry.detail as { before?: Changed; after?: Changed } | null;
  const before = detail?.before;
  const after = detail?.after;
  if (!before || !after) return [];
  const said: string[] = [];
  if (before.mode !== after.mode && after.mode) said.push(`${BADGE[before.mode ?? 'observe'].label} → ${BADGE[after.mode].label}`);
  if ((before.recheckMinutes ?? null) !== (after.recheckMinutes ?? null)) {
    const keep = (minutes: number | null | undefined) => (minutes ? `every ${every(minutes)}` : 'off');
    said.push(`Keep it so: ${keep(before.recheckMinutes)} → ${keep(after.recheckMinutes)}`);
  }
  for (const [key, value] of Object.entries(after.params ?? {})) {
    const was = before.params?.[key];
    if (was === value) continue;
    const field = recipe?.params.fields[key];
    const unit = field && 'unit' in field && field.unit ? ` ${field.unit}` : '';
    said.push(`${field?.title ?? key}: ${was ?? '—'}${was === undefined ? '' : unit} → ${value}${unit}`);
  }
  if (JSON.stringify(before.roles ?? {}) !== JSON.stringify(after.roles ?? {})) said.push('Its devices changed');
  return said;
}

type Entry = { at: string; key: string } & ({ run: AutomationRun } | { change: AuditEntry });

/**
 * Its history, as a timeline: day by day, newest first, each run with why it
 * ran and what came of it — a tap opens its steps — and each change made to
 * it, with who made it and what changed.
 */
function Timeline({ history, automation, recipe }: { history: History | null; automation: AutomationView; recipe: RecipeView | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!history) return <Spinner size="small" color="$accent" alignSelf="flex-start" />;
  const entries: Entry[] = [
    ...history.runs.filter((run) => run.outcome !== 'running').map((run): Entry => ({ at: run.at, key: `run:${run.id}`, run })),
    ...history.changes.map((change): Entry => ({ at: change.at, key: `change:${change.id}`, change })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!entries.length) {
    return (
      <Text fontSize={13} color="$muted" lineHeight={19}>
        Nothing yet.
      </Text>
    );
  }
  // The timeline says whose each entry is — "Charge window: …" — which this card already does.
  const own = (summary: string) =>
    (summary.startsWith(`${automation.name}: `) ? summary.slice(automation.name.length + 2) : summary)
      .replace(`: "${automation.name}"`, '')
      .replace(` "${automation.name}"`, '');
  const days = entries.reduce<{ day: string; entries: Entry[] }[]>((grouped, entry) => {
    const day = dayOf(entry.at);
    const last = grouped.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else grouped.push({ day, entries: [entry] });
    return grouped;
  }, []);

  return (
    <YStack gap="$3">
      {days.map(({ day, entries: onDay }) => (
        <YStack key={day} gap="$1">
          <Heading>{day}</Heading>
          {onDay.map((entry, index) => {
            const run = 'run' in entry ? entry.run : null;
            const change = 'change' in entry ? entry.change : null;
            const look = run ? OUTCOME[run.outcome] : (CHANGE[change!.kind] ?? { icon: 'edit-3', tone: '$color' });
            const expanded = open === entry.key;
            const changes = change ? changesOf(change, recipe) : [];
            const by = run?.startedBy ?? (change?.actor && !change.actor.startsWith('automation:') ? change.actor : null);
            const row = (
              <XStack gap="$3" alignItems="stretch">
                {/* The rail: a mark for each entry, joined to the next. */}
                <YStack width={24} alignItems="center">
                  <Mark look={look} size={24} />
                  {index < onDay.length - 1 ? <YStack flex={1} width={2} marginTop={2} backgroundColor="$borderColor" borderRadius={1} /> : null}
                </YStack>
                <YStack flex={1} gap={3} paddingBottom="$3">
                  <XStack gap="$2" alignItems="flex-start">
                    <Text flex={1} fontSize={14} fontWeight={run ? '700' : '600'} color="$color" lineHeight={20}>
                      {run ? run.summary : own(change!.summary)}
                    </Text>
                    <Text fontSize={12} color="$muted" fontVariant={['tabular-nums']} marginTop={2}>
                      {clock(entry.at)}
                    </Text>
                  </XStack>
                  {run?.why && !run.startedBy ? (
                    <Text fontSize={12} color="$muted" lineHeight={17}>
                      {run.why}
                    </Text>
                  ) : null}
                  {changes.map((line) => (
                    <Text key={line} fontSize={12} color="$color" lineHeight={17}>
                      {line}
                    </Text>
                  ))}
                  {by ? (
                    <Text fontSize={12} color="$muted">
                      by {by}
                      {run ? lasted(run) : ''}
                    </Text>
                  ) : null}
                  {expanded && run ? (
                    <YStack gap="$2" marginTop="$1.5">
                      <Readings saw={run.saw} />
                      {run.conditions.length ? <Conditions conditions={run.conditions} /> : null}
                      <RunSteps run={run} />
                    </YStack>
                  ) : null}
                </YStack>
              </XStack>
            );
            // A run with more to say opens on a tap; a change says all it has.
            const more = run && (run.saw.length || run.conditions.length || run.steps.length);
            return more ? (
              <Pressable key={entry.key} onPress={() => setOpen(expanded ? null : entry.key)} label={`${run.summary}, ${clock(entry.at)}: ${expanded ? 'hide' : 'show'} what it read and did`}>
                {row}
              </Pressable>
            ) : (
              <YStack key={entry.key}>{row}</YStack>
            );
          })}
        </YStack>
      ))}
    </YStack>
  );
}

/** What it would have done on the last week of history, run by run, and what history could not show. */
function Rehearsed({ rehearsal, onClose }: { rehearsal: Rehearsal; onClose: () => void }) {
  const tone = useTone();
  const shown = rehearsal.runs.slice(-10).reverse();
  const count = rehearsal.runs.length;
  return (
    <YStack gap="$2.5" padding="$3" borderRadius="$4" borderWidth={1} borderColor="$borderColor">
      <XStack alignItems="center" justifyContent="space-between">
        <Heading>On the last week</Heading>
        <Button size="$2" chromeless circular aria-label="Close" icon={<Icon name="x" size={14} color={tone('$muted')} />} onPress={onClose} />
      </XStack>
      <Text fontSize={14} fontWeight="700" color="$color">
        {count ? `It would have run ${count} time${count === 1 ? '' : 's'}${count > shown.length ? `; the last ${shown.length}:` : ':'}` : 'It would not have run.'}
      </Text>
      {/* Two triggers can fire in one minute: the run's place, not its time, tells them apart. */}
      {shown.map((run, index) => (
        <XStack key={`${index}:${run.at}`} gap="$2.5" alignItems="flex-start">
          <Mark look={OUTCOME[run.outcome]} size={22} />
          <YStack flex={1} gap={1}>
            <Text fontSize={13} color="$color" lineHeight={19}>
              {run.summary}
            </Text>
            <Text fontSize={11} color="$muted">
              {dayOf(run.at)} {clock(run.at)}
            </Text>
          </YStack>
        </XStack>
      ))}
      {rehearsal.caveats.map((caveat) => (
        <XStack key={caveat} gap="$2" alignItems="flex-start">
          <Icon name="info" size={12} color={tone('$muted')} style={{ marginTop: 3 }} />
          <Text flex={1} fontSize={12} color="$muted" lineHeight={17}>
            {caveat}.
          </Text>
        </XStack>
      ))}
    </YStack>
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
  const [recheck, setRecheck] = useState(existing?.recheckMinutes ?? 0);
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
      // Only a rule with a condition has anything to keep.
      const recheckMinutes = recipe.hasConditions && recheck > 0 ? recheck : null;
      if (!existing) {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        onSaved(await createAutomation({ name: chosenName, recipe: recipe.id, roles, params, timeZone, recheckMinutes }));
        return;
      }
      const changes = { name: chosenName, roles, params, recheckMinutes };
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
                  <Row
                    title={candidate.label}
                    subtitle={candidate.from ? `${candidate.description} From ${candidate.from.name}.` : candidate.description}
                    accessory={candidate.takesSteps || candidate.startsWhenAsked ? <Kinds recipe={candidate} /> : undefined}
                  />
                </Pressable>
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {recipe ? (
        <>
          {recipe.takesSteps && !existing ? (
            <YStack gap="$2">
              <SectionLabel>What it will do</SectionLabel>
              <Card inset backgroundColor="$background" padding="$3">
                <StepPlan steps={recipe.steps} />
              </Card>
            </YStack>
          ) : null}
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

          {recipe.hasConditions ? (
            <YStack gap="$2">
              <SectionLabel>Keep it so</SectionLabel>
              <Card inset backgroundColor="$background">
                <SegmentedControl title="Check again" subtitle={recheckSays(recheck || null)} value={recheck} options={RECHECK} disabled={busy} onChange={setRecheck} />
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
          {recipe?.startsWhenAsked
            ? 'It starts by only watching: trying it says what it would do, and switches nothing until you let it act. Then Start takes its steps.'
            : 'It starts by only watching: it decides and says what it would have done, and switches nothing until you let it act.'}
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

/** What kind of automation a recipe makes, as small marks: it takes steps; you start it. */
function Kinds({ recipe }: { recipe: RecipeView }) {
  const tone = useTone();
  const marks = [...(recipe.takesSteps ? [{ icon: 'list' as const, label: 'Steps' }] : []), ...(recipe.startsWhenAsked ? [{ icon: 'play' as const, label: 'You start it' }] : [])];
  return (
    <YStack gap={4} alignItems="flex-end">
      {marks.map((mark) => (
        <XStack key={mark.label} gap={4} alignItems="center" paddingHorizontal="$2" paddingVertical={2} borderRadius={999} borderWidth={1} borderColor="$accent">
          <Icon name={mark.icon} size={10} color={tone('$accent')} />
          <Text fontSize={11} fontWeight="700" color="$accent">
            {mark.label}
          </Text>
        </XStack>
      ))}
    </YStack>
  );
}
