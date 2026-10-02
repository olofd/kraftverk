import { useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Button, Spinner, Text, XStack, YStack } from 'tamagui';

import type { AutomationMode } from '@kraftverk/automation';
import { automationChangeOf, summaryOn, type AuditEntry, type AutomationRun, type AutomationView, type ConditionState, type Rehearsal } from '@kraftverk/api-client';
import { Icon, IconLabel, type IconName } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useTone } from '../../../components/tone';
import { clock, dayOf, every, lasted, OUTCOME, type Look } from '../looks';
import { RunSteps } from '../Steps';

/** Each mode its own shape as well as its colour: acting is filled, and cannot be mistaken for watching. */
const BADGE: Record<AutomationMode, { label: string; icon: IconName; filled: boolean }> = {
  off: { label: 'Off', icon: 'pause', filled: false },
  watch: { label: 'Only watching', icon: 'eye', filled: false },
  act: { label: 'Acting', icon: 'zap', filled: true },
};

/** A change made to an automation, as its history shows it. */
const CHANGE: Record<string, Look> = {
  'automation.created': { icon: 'plus', tone: '$color' },
  'automation.proposed': { icon: 'message-circle', tone: '$color' },
  'automation.let-act': { icon: 'zap', tone: '$success' },
  'automation.changed': { icon: 'edit-3', tone: '$color' },
  'automation.started': { icon: 'play', tone: '$accent' },
  'automation.stopping': { icon: 'square', tone: '$muted' },
};

/*
  An automation's runs and its history (docs/AUTOMATIONS-UX.md): a run told
  the way a person asks about it, the timeline of runs and changes, and a
  rehearsal on last week — on its page.
*/

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
 * How it stands now: each condition it waits for, whether it holds, what it
 * read to say so — and what that means for when it runs.
 */
export function RightNow({ automation }: { automation: AutomationView }) {
  const { conditions, saw } = automation.now;
  return (
    <YStack gap="$3">
      <Conditions conditions={conditions} />
      <Readings saw={saw} />
      <Text fontSize={13} color="$muted" lineHeight={19}>
        It runs when one of these turns to yes, and looks at them every time the device reports.
        {automation.recheckMinutes
          ? ` Every ${every(automation.recheckMinutes)} it also runs again while one still holds, unless all is already so.`
          : automation.takesSteps
            ? ''
            : ' Once it has acted, what you switch by hand stays until one turns to yes again.'}
      </Text>
    </YStack>
  );
}

/** A run's mark: its outcome's icon in a tinted circle. */
export function Mark({ look, size = 28 }: { look: Look; size?: number }) {
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
export function RunDetail({ run, showConditions, automationId }: { run: AutomationRun; showConditions?: boolean; automationId?: string }) {
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
          <IconLabel icon="corner-down-right" size={12} color={tone('$muted')} lineHeight={19} gap={5}>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              {run.why}
              {lasted(run)}
            </Text>
          </IconLabel>
        </YStack>
        <Readings saw={run.saw} />
        {showConditions && run.conditions.length ? <Conditions conditions={run.conditions} /> : null}
        {run.steps.length ? <RunSteps run={run} /> : null}
        {automationId && run.steps.length ? <RunLogLink automationId={automationId} run={run} /> : null}
      </YStack>
    </XStack>
  );
}

/** The way to a run's log: every value its devices gave while it ran, on a page of its own. */
function RunLogLink({ automationId, run }: { automationId: string; run: AutomationRun }) {
  const router = useRouter();
  const runId = run.id;
  if (!runId) return null;
  return (
    <Button
      size="$3"
      minHeight={44}
      alignSelf="flex-start"
      icon={<Icon name="activity" size={16} />}
      aria-label={`Run log: ${run.summary}`}
      onPress={() => router.push(`/automation/${encodeURIComponent(automationId)}/run/${encodeURIComponent(runId)}`)}
    >
      Run log
    </Button>
  );
}

/** Its history: every run it kept, and every change made to it. */
export type History = { runs: AutomationRun[]; changes: AuditEntry[] };

/** What a change changed, in words: "Only watching → Acting", "What it does changed". */
function changesOf(entry: AuditEntry): string[] {
  const change = automationChangeOf(entry);
  if (!change) return [];
  const keep = (minutes: number | null) => (minutes ? `every ${every(minutes)}` : 'off');
  return [
    change.mode ? `${BADGE[change.mode.from].label} → ${BADGE[change.mode.to].label}` : null,
    change.recheckMinutes ? `Keep it so: ${keep(change.recheckMinutes.from)} → ${keep(change.recheckMinutes.to)}` : null,
    change.rule ? 'What it does changed' : null,
    change.uses ? 'What it uses changed' : null,
    change.homePlace === 'taken' ? 'Taken off the home page' : change.homePlace === 'put' ? 'Put on the home page' : null,
  ].filter((said): said is string => said !== null);
}

type Entry = { at: string; key: string } & ({ run: AutomationRun } | { change: AuditEntry });

/**
 * Its history, as a timeline: day by day, newest first, each run with why it
 * ran and what came of it — a tap opens its steps — and each change made to
 * it, with who made it and what changed.
 */
export function Timeline({ history, automation }: { history: History | null; automation: AutomationView }) {
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
  const own = (summary: string) => summaryOn(summary, automation.name);
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
            const changes = change ? changesOf(change) : [];
            const by = run?.startedByRun ? `“${run.startedByRun.name}”` : (run?.startedBy ?? (change?.actor && !change.actor.startsWith('automation:') ? change.actor : null));
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
                      {run.steps.length ? <RunLogLink automationId={automation.id} run={run} /> : null}
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
export function Rehearsed({ rehearsal, onClose }: { rehearsal: Rehearsal; onClose: () => void }) {
  const tone = useTone();
  const shown = rehearsal.runs.slice(-10).reverse();
  const count = rehearsal.runs.length;
  return (
    <YStack gap="$2.5" padding="$3" borderRadius="$4" borderWidth={1} borderColor="$borderColor">
      <XStack alignItems="center" justifyContent="space-between">
        <Heading>On the last week</Heading>
        <Button width={44} height={44} chromeless circular aria-label="Close" icon={<Icon name="x" size={16} color={tone('$muted')} />} onPress={onClose} />
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
        <IconLabel key={caveat} icon="info" size={12} color={tone('$muted')} lineHeight={18}>
          <Text fontSize={13} color="$muted" lineHeight={18}>
            {caveat}.
          </Text>
        </IconLabel>
      ))}
    </YStack>
  );
}
