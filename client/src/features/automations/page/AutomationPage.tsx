import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import {
  checkAutomation,
  deleteAutomation,
  describeError,
  fetchAudit,
  fetchAutomation,
  fetchAutomationRuns,
  rehearseAutomation,
  updateAutomation,
  type AutomationChanges,
  type AutomationRun,
  type AutomationView,
  type Rehearsal,
} from '@kraftverk/api-client';
import { describeExpr } from '@kraftverk/automation';
import { Card, Icon, RowSeparator, SegmentedControl, ToggleRow, haptic, type IconName } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { Screen } from '../../../components/Screen';
import { ASKED_AGAIN, confirmAction, withConfirmation } from '../../../lib/confirm';
import { useShowing } from '../../../state/useShowing';
import { startsBy } from '../AutomationCard';
import { AutomationForm } from '../editor/AutomationForm';
import { clock, useTone } from '../looks';
import { RunSteps, StepPlan } from '../Steps';
import { useReadAgain } from '../useReadAgain';
import { useRun } from '../useRun';
import { Empty, Group } from './Group';
import { isRunEntry, Rehearsed, RightNow, RunDetail, Timeline, type History } from './history';
import { MODES, modeSays, RECHECK, recheckSays, wantsYes, every } from './modes';

/**
 * An automation's own page (docs/AUTOMATIONS-UX.md): how it stands and a
 * button that runs it, then each part of it in a group of its own — what
 * starts it, what it must meet, what it does, what it does if a step fails,
 * how it stands right now, what it does on its own, and what it has done.
 * What is rarely needed is under ⋯. Edit turns the same page into its form —
 * the same groups, editable — with Cancel and Save below it.
 */
export function AutomationPage({ id, edit = null }: { id: string; edit?: 'form' | 'yaml' | null }) {
  const [automation, setAutomation] = useState<AutomationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Being changed: through the form, or as its YAML. */
  const [editing, setEditing] = useState<'form' | 'yaml' | null>(edit);

  /** Edited, or not: the page again — and an address that does not open the form once more. */
  const done = () => {
    setEditing(null);
    if (edit) router.setParams({ edit: undefined } as never);
  };

  const load = useCallback(() => {
    fetchAutomation(id)
      .then((next) => (setAutomation(next), setError(null)))
      .catch((err) => setError(describeError(err) || 'It could not be read'));
  }, [id]);
  useEffect(load, [load]);
  // A run moving, or a reading it stands on: read again, so the page follows it.
  useReadAgain(load, { followReadings: true });
  // It, and the devices it uses: while it is in front, the server reads them more often.
  useShowing(automation ? [{ kind: 'automation', id: automation.id }, ...Object.values(automation.roles).map((role) => ({ kind: 'device' as const, id: role.device }))] : []);

  if (!automation) {
    return (
      <Screen back="Automations" backTo="/automations" title="Automation">
        {error ? (
          <Card borderColor="$danger">
            <Text fontSize={14} color="$danger">
              {error}
            </Text>
          </Card>
        ) : (
          <Spinner color="$accent" />
        )}
      </Screen>
    );
  }
  if (editing) {
    return (
      <AutomationForm
        existing={automation}
        initial={{ name: automation.name, rule: automation.rule, roles: automation.roles, starts: automation.starts }}
        madeFrom={automation.madeFrom?.id ?? null}
        back={{ label: 'Automations', to: '/automations' }}
        view={editing}
        onSaved={(next) => (setAutomation(next), done())}
        onCancel={done}
      />
    );
  }
  return <Page automation={automation} onChanged={setAutomation} onEdit={(view) => setEditing(view)} />;
}

function Page({ automation, onChanged, onEdit }: { automation: AutomationView; onChanged: (next: AutomationView) => void; onEdit: (view: 'form' | 'yaml') => void }) {
  const [checked, setChecked] = useState<AutomationRun | null>(null);
  const [rehearsal, setRehearsal] = useState<Rehearsal | null>(null);
  const onItsOwn = automation.when.length > 0;
  const name = (role: string) => automation.names[role] ?? role;
  const condition = automation.rule.if ? describeExpr(automation.rule, automation.rule.if, {}, name) : null;
  const steps = automation.steps.length;

  return (
    <Screen back="Automations" backTo="/automations" title={automation.name}>
      <Header automation={automation} onChanged={onChanged} onEdit={() => onEdit('form')} onChecked={setChecked} onRehearsed={setRehearsal} />

      {checked ? (
        <Group icon="help-circle" title="If it ran now" summary="Nothing is sent">
          <RunDetail run={checked} showConditions />
          <Button alignSelf="flex-start" size="$3" minHeight={44} chromeless color="$muted" onPress={() => setChecked(null)}>
            Close
          </Button>
        </Group>
      ) : null}
      {rehearsal ? (
        <Group icon="rewind" title="On the last week" summary="Nothing is sent">
          <Rehearsed rehearsal={rehearsal} onClose={() => setRehearsal(null)} />
        </Group>
      ) : null}

      <Group icon={startsBy(automation)} title="When" summary={onItsOwn ? undefined : 'When started'}>
        {onItsOwn ? (
          automation.when.map((trigger) => (
            <Text key={trigger} fontSize={15} color="$color" lineHeight={22}>
              {trigger}
            </Text>
          ))
        ) : (
          <Empty>Nothing starts it on its own: you start it, or another automation does.</Empty>
        )}
      </Group>

      <Group icon="filter" title="Only if" summary={condition ? undefined : 'Always'}>
        {condition ? (
          <Text fontSize={15} color="$color" lineHeight={22}>
            {condition.charAt(0).toUpperCase() + condition.slice(1)}
          </Text>
        ) : (
          <Empty>None: every time it runs, it takes its steps.</Empty>
        )}
      </Group>

      <Group icon="list" title="Does" summary={steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined}>
        {steps ? <StepPlan steps={automation.steps} /> : <Empty>Nothing yet.</Empty>}
      </Group>

      {automation.otherwise.length ? (
        <Group icon="corner-up-left" title="If a step fails, or you stop it">
          <StepPlan steps={automation.otherwise} numbered={false} />
        </Group>
      ) : null}

      {automation.now.conditions.length ? (
        <Group icon="activity" title="Right now" summary={automation.nextLookAt ? `Looks again ${clock(automation.nextLookAt)}` : undefined}>
          <RightNow automation={automation} />
        </Group>
      ) : null}

      <OnItsOwn automation={automation} onChanged={onChanged} />

      <Activity automation={automation} />

      {automation.madeFrom || automation.sharedWith.length ? (
        <YStack gap="$1.5" paddingHorizontal="$1">
          {automation.madeFrom ? (
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Made from “{automation.madeFrom.label}”.
            </Text>
          ) : null}
          {automation.sharedWith.map((other) => (
            <Text key={other.id} fontSize={13} color="$muted" lineHeight={19}>
              “{other.name}” also changes {other.parts.join(', ')}.
            </Text>
          ))}
        </YStack>
      ) : null}
    </Screen>
  );
}

/** How it stands, Run (or Stop), Edit, and ⋯ for what is rarely needed. */
function Header({
  automation,
  onChanged,
  onEdit,
  onChecked,
  onRehearsed,
}: {
  automation: AutomationView;
  onChanged: (next: AutomationView) => void;
  onEdit: () => void;
  onChecked: (run: AutomationRun) => void;
  onRehearsed: (rehearsal: Rehearsal) => void;
}) {
  const tone = useTone();
  const run = useRun(automation, onChanged);
  const [menu, setMenu] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const more = useRef<HTMLElement | null>(null);
  const menuBox = useRef<HTMLElement | null>(null);
  // Opened, its first item has the focus; Escape closes it, the focus back on ⋯ — as a menu does.
  useEffect(() => {
    if (menu) (menuBox.current?.querySelector('[role=button]') as HTMLElement | null)?.focus();
  }, [menu]);
  const close = () => {
    setMenu(false);
    more.current?.focus();
  };
  const running = run.running !== null;
  // Not run yet: what starts it is its own group below, not this line as well.
  const status = !automation.running && !automation.lastRun && automation.mode !== 'off' && !automation.problems.length ? (automation.when.length ? 'Not run yet' : 'Not started yet') : run.status;

  const act = async (work: () => Promise<void>, failure: string) => {
    setMenu(false);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(describeError(err) || failure);
    }
  };
  const remove = () =>
    act(async () => {
      if (!(await confirmAction(`Delete “${automation.name}”?`, `${automation.running ? 'Its run is stopped first. ' : ''}It stops, and is gone — its runs and their logs with it. What it did stays on the timeline, said in words.`, 'Delete', 'dangerous'))) return;
      await deleteAutomation(automation.id);
      router.replace('/automations');
    }, 'It could not be deleted');

  const items: { icon: IconName; label: string; danger?: boolean; onPress: () => void }[] = [
    { icon: 'help-circle', label: 'What would it do now?', onPress: () => void act(async () => onChecked(await checkAutomation(automation.id)), 'It could not be checked') },
    ...(automation.when.length ? [{ icon: 'rewind' as const, label: 'Rehearse on last week', onPress: () => void act(async () => onRehearsed(await rehearseAutomation(automation.id)), 'It could not be rehearsed') }] : []),
    { icon: 'code', label: 'As configuration', onPress: () => (setMenu(false), router.push(`/automation/${encodeURIComponent(automation.id)}/configuration`)) },
    { icon: 'trash-2', label: 'Delete', danger: true, onPress: () => void remove() },
  ];

  return (
    <YStack gap="$3">
      <Text fontSize={15} lineHeight={21} color={running ? '$accent' : '$muted'} role="status">
        {status}
      </Text>
      <XStack gap="$2" alignItems="center">
        {running ? (
          <Button flex={1} size="$4" borderWidth={1.5} borderColor="$danger" backgroundColor="transparent" color="$danger" disabled={run.busy} icon={<Icon name="square" size={16} color={tone('$danger')} />} onPress={() => void run.stop()} aria-label={`Stop ${automation.name}`}>
            Stop
          </Button>
        ) : (
          <Button
            flex={1}
            size="$4"
            backgroundColor="$accent"
            color="$background"
            disabled={run.busy || run.blocked !== null}
            opacity={run.busy || run.blocked ? 0.5 : 1}
            icon={<Icon name="play" size={16} color={tone('$background')} />}
            onPress={() => void run.start()}
            aria-label={`Start ${automation.name}`}
          >
            Run
          </Button>
        )}
        <Button size="$4" backgroundColor="$card" borderWidth={1} borderColor="$borderColor" disabled={running} opacity={running ? 0.5 : 1} icon={<Icon name="edit-3" size={16} color={tone('$color')} />} onPress={() => (haptic(), onEdit())}>
          Edit
        </Button>
        <Button ref={more as never} size="$4" width={48} circular backgroundColor="$card" borderWidth={1} borderColor="$borderColor" aria-label="More" aria-haspopup="menu" aria-expanded={menu} icon={<Icon name="more-horizontal" size={18} color={tone('$color')} />} onPress={() => (haptic(), setMenu((open) => !open))} />
      </XStack>
      {menu ? (
        <YStack
          ref={menuBox as never}
          onKeyDown={((event: { key: string; preventDefault: () => void }) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            close();
          }) as never}
        >
          <Card inset role="menu" aria-label={`More for ${automation.name}`}>
            {items.map((item, index) => (
              <YStack key={item.label}>
                {index > 0 ? <RowSeparator /> : null}
                <Pressable onPress={item.onPress} label={item.label}>
                  <XStack alignItems="center" gap="$3" paddingHorizontal="$4" minHeight={48}>
                    <Icon name={item.icon} size={18} color={tone(item.danger ? '$danger' : '$color')} />
                    <Text flex={1} fontSize={15} color={item.danger ? '$danger' : '$color'}>
                      {item.label}
                    </Text>
                  </XStack>
                </Pressable>
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}
      {run.problem || problem ? (
        <Text fontSize={13} color="$danger" lineHeight={19} role="alert">
          {run.problem ?? problem}
        </Text>
      ) : null}
    </YStack>
  );
}

/** What it does on its own: off, only watching, or acting — keeping things so, and a place on the home page. */
function OnItsOwn({ automation, onChanged }: { automation: AutomationView; onChanged: (next: AutomationView) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const onItsOwn = automation.when.length > 0;
  const canKeep = !automation.takesSteps && automation.rule.when.some((trigger) => 'becomes' in trigger);

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
  const change = (changes: AutomationChanges, title: string, yes: string) =>
    act(async () => {
      const { answer } = await withConfirmation(
        (confirmation) => updateAutomation(automation.id, { ...changes, confirmation }),
        wantsYes,
        (reason, again) => confirmAction(title, `${again ? `${ASKED_AGAIN}\n\n` : ''}${reason}\n\n${automation.sentence}`, yes)
      );
      if ('automation' in answer) onChanged(answer.automation);
    }, 'That did not work');

  return (
    <Group icon="zap" title={onItsOwn ? 'On its own' : 'When others start it'} inset>
      <SegmentedControl
        title="Mode"
        subtitle={modeSays(automation.mode, onItsOwn)}
        value={automation.mode}
        options={MODES}
        disabled={busy}
        onChange={(mode) => void change({ mode }, onItsOwn ? `Let “${automation.name}” act on its own?` : `Let “${automation.name}” act when others start it?`, 'Let it act')}
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
      <RowSeparator />
      <ToggleRow
        title="On the home page"
        subtitle={automation.homePlace === null ? 'A shortcut to run it, on your home page.' : 'Its card is on your home page.'}
        checked={automation.homePlace !== null}
        disabled={busy}
        onCheckedChange={(on) =>
          void act(async () => {
            const answer = await updateAutomation(automation.id, { homePlace: on ? 1000 : null });
            if ('automation' in answer) onChanged(answer.automation);
          }, 'That did not work')
        }
      />
      {problem ? (
        <Text paddingHorizontal="$4" paddingBottom="$3" fontSize={13} color="$danger" lineHeight={19} role="alert">
          {problem}
        </Text>
      ) : null}
    </Group>
  );
}

/** What it is doing, what it did last, and — opened — everything it has done and every change made to it. */
function Activity({ automation }: { automation: AutomationView }) {
  const tone = useTone();
  const [history, setHistory] = useState<History | null>(null);
  const [open, setOpen] = useState(false);
  const loadHistory = useCallback(() => {
    Promise.all([fetchAutomationRuns(automation.id, 100), fetchAudit({ resourceKind: 'automation', resource: automation.id, limit: 100 })])
      .then(([runs, entries]) => setHistory({ runs, changes: entries.filter((entry) => !isRunEntry(entry)) }))
      .catch(() => setHistory({ runs: [], changes: [] }));
  }, [automation.id]);
  useEffect(() => {
    if (open) loadHistory();
  }, [loadHistory, open, automation.updatedAt, automation.lastRun?.id, automation.running === null]);

  const running = automation.running;
  return (
    <Group icon="clock" title="Activity" summary={running ? 'Running now' : undefined}>
      {running ? (
        <YStack gap="$2">
          <Text fontSize={13} color="$muted">
            {running.startedByRun ? `Started by “${running.startedByRun.name}”` : running.startedBy ? `Started by ${running.startedBy}` : running.why} · {clock(running.at)}
          </Text>
          <RunSteps run={running} />
        </YStack>
      ) : automation.lastRun ? (
        <RunDetail run={automation.lastRun} automationId={automation.id} />
      ) : (
        <Empty>{automation.when.length ? 'It has not run yet: nothing that starts it has happened since it was made.' : 'It has not been started yet.'}</Empty>
      )}
      <YStack borderTopWidth={1} borderColor="$borderColor" paddingTop="$2">
        <Pressable onPress={() => (haptic(), setOpen((was) => !was))} label={open ? 'Hide history' : 'Show history'}>
          <XStack alignItems="center" gap="$2" minHeight={44}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} color={tone('$muted')} />
            <Text fontSize={15} fontWeight="600" color="$color">
              History
            </Text>
            <Text fontSize={13} color="$muted">
              every run, and every change
            </Text>
          </XStack>
        </Pressable>
        {open ? <Timeline history={history} automation={automation} /> : null}
      </YStack>
    </Group>
  );
}
